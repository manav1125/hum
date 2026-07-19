/**
 * Mv3ScheduleEditorSheet — the mobile-v3 schedule editor (spec frame 40:
 * plain-language cron). Opens from a row on the Schedules leaf.
 *
 * Frame-verbatim grammar: sheet with grabber → 19px/700 title → WHEN as
 * chips (Every weekday / Daily / Weekly / Custom…) + a native time input →
 * WHAT IT DOES prose card → the raw cron demoted to a 10px mono footnote
 * with a next-run preview + the enable toggle → gradient "Save schedule" →
 * quiet-red Delete.
 *
 * DATA (all real): Save = `PATCH /v1/assistants/{id}/schedules/{id}`
 * ({expression, message}); toggle = the existing toggle POST; Delete = the
 * DELETE route. Chips↔cron mapping lives in `utils/cron-chips.ts` and
 * round-trips the simple shapes; anything else edits as raw cron under
 * Custom…. The frame's "Runs as ◆ Ops · delivers to push + Telegram" line is
 * rendered ONLY from real fields — schedules carry no agent/delivery-target
 * fields, so the line shows the inference profile when set and is omitted
 * otherwise.
 */
import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { assistantSchedulesQueryKey } from "@/lib/sync/query-tags";
import { mv3Mono } from "@/mobile-v3/mv3-kit";
import { SheetShell } from "@/mobile-v3/sheet-shell";
import { haptic } from "@/utils/haptics";

import {
  deleteSchedule,
  toggleSchedule,
  updateSchedule,
} from "@/domains/settings/api/schedules";
import type { Schedule } from "@/domains/settings/types/schedules";
import { WEEKDAYS } from "@/domains/settings/utils/cron-builder";
import {
  buildCronFromChips,
  cronZoneLabel,
  formatNextRun,
  looksLikeCron,
  nextRunFromChipsInZone,
  parseCronToChips,
  resolveCronZone,
  type CadenceChipId,
  type ChipCadence,
} from "@/domains/settings/utils/cron-chips";
import { formatTimestamp } from "@/domains/settings/utils/schedule-formatters";

const WHEN_CHIPS: ReadonlyArray<{ id: CadenceChipId; label: string }> = [
  { id: "weekday", label: "Every weekday" },
  { id: "daily", label: "Daily" },
  { id: "weekly", label: "Weekly" },
  { id: "custom", label: "Custom…" },
];

/** 11px/600 uppercase section label (frame 40 "WHEN" / "WHAT IT DOES"). */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11,
        letterSpacing: ".05em",
        textTransform: "uppercase",
        color: "var(--mv3-muted)",
        fontWeight: 600,
        marginBottom: 7,
      }}
    >
      {children}
    </div>
  );
}

/** Frame-40 selection pill: selected = inverted (text bg + canvas ink). */
function chipStyle(selected: boolean): React.CSSProperties {
  return {
    fontSize: 12.5,
    fontWeight: 600,
    fontFamily: "inherit",
    color: selected ? "var(--mv3-bg)" : "var(--mv3-muted)",
    background: selected ? "var(--mv3-text)" : "var(--mv3-btn2-bg)",
    border: selected
      ? "1px solid transparent"
      : "1px solid var(--mv3-btn2-border)",
    borderRadius: 99,
    padding: "7px 14px",
    minHeight: 44,
    cursor: "pointer",
    WebkitTapHighlightColor: "transparent",
  };
}

const fieldCard: React.CSSProperties = {
  background: "var(--mv3-btn2-bg)",
  border: "1px solid var(--mv3-btn2-border)",
  borderRadius: 16,
  padding: "13px 15px",
};

function toTimeValue(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function Mv3ScheduleEditorSheet({
  schedule,
  assistantId,
  onClose,
}: {
  schedule: Schedule;
  assistantId: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const queryKey = assistantSchedulesQueryKey(assistantId);

  // Cadence editing applies to cron-syntax schedules only; one-shots and
  // RRULEs keep their timing (edited via chat / desktop) — message editing,
  // toggle and delete still work for them.
  const savedCron =
    schedule.syntax === "cron"
      ? (schedule.cronExpression ?? schedule.expression)
      : null;
  const cadenceEditable = schedule.syntax === "cron" && savedCron !== null;

  const [cadence, setCadence] = useState<ChipCadence>(() =>
    parseCronToChips(savedCron),
  );
  const [customCron, setCustomCron] = useState(() => savedCron ?? "");
  const [message, setMessage] = useState(schedule.message);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const draftCron = useMemo(() => {
    if (!cadenceEditable) return savedCron;
    return cadence.chip === "custom"
      ? customCron.trim()
      : buildCronFromChips(cadence);
  }, [cadenceEditable, savedCron, cadence, customCron]);

  const cronChanged = cadenceEditable && draftCron !== savedCron;
  const messageChanged = message !== schedule.message;
  const dirty = cronChanged || messageChanged;
  const customInvalid =
    cadence.chip === "custom" && cronChanged && !looksLikeCron(customCron);

  // The zone the DAEMON interprets this cron in (stored IANA zone, else the
  // daemon host's zone inferred from savedCron + nextRunAt). The picker's
  // hour/minute are that zone's wall clock, not necessarily the browser's —
  // the label makes that visible whenever the two differ (UAT P1-17).
  const cronZone = useMemo(
    () =>
      resolveCronZone({
        timezone: schedule.timezone ?? null,
        savedCron,
        nextRunAt: schedule.nextRunAt ?? null,
      }),
    [schedule.timezone, savedCron, schedule.nextRunAt],
  );
  const zoneLabel = cronZoneLabel(cronZone);

  // Next-run preview: the server's nextRunAt is authoritative for the saved
  // expression; a changed simple shape is previewed in the daemon's zone (so
  // the shown instant is the one that will actually fire); a changed custom
  // cron is honest about needing the save.
  const nextRunLabel = useMemo(() => {
    if (!cronChanged) return formatNextRun(schedule.nextRunAt);
    const next = nextRunFromChipsInZone(cadence, cronZone);
    return next ? `${formatNextRun(next)} (after save)` : "computed on save";
  }, [cronChanged, schedule.nextRunAt, cadence, cronZone]);

  const saveMutation = useMutation({
    mutationFn: () =>
      updateSchedule(assistantId, schedule.id, {
        ...(cronChanged && draftCron ? { expression: draftCron } : {}),
        ...(messageChanged ? { message } : {}),
      }),
    onSuccess: () => {
      haptic.success();
      void queryClient.invalidateQueries({ queryKey });
      onClose();
    },
    onError: (error) => {
      haptic.error();
      setSaveError(
        error instanceof Error ? error.message : "Couldn't save the schedule.",
      );
    },
  });

  const toggleMutation = useMutation({
    mutationFn: (enabled: boolean) =>
      toggleSchedule(assistantId, schedule.id, enabled),
    onMutate: async (enabled) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<Schedule[]>(queryKey);
      queryClient.setQueryData<Schedule[]>(queryKey, (prev) =>
        prev?.map((s) => (s.id === schedule.id ? { ...s, enabled } : s)),
      );
      return { previous };
    },
    onError: (_e, _v, ctx) => {
      haptic.error();
      if (ctx?.previous) queryClient.setQueryData(queryKey, ctx.previous);
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey }),
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteSchedule(assistantId, schedule.id),
    onSuccess: () => {
      haptic.medium();
      void queryClient.invalidateQueries({ queryKey });
      onClose();
    },
    onError: (error) => {
      haptic.error();
      setConfirmDelete(false);
      setSaveError(
        error instanceof Error
          ? error.message
          : "Couldn't delete the schedule.",
      );
    },
  });

  // Optimistic-cache reads keep the toggle live while the sheet is open.
  const liveEnabled =
    queryClient
      .getQueryData<Schedule[]>(queryKey)
      ?.find((s) => s.id === schedule.id)?.enabled ?? schedule.enabled;

  const setTime = (value: string) => {
    const [h, m] = value.split(":");
    const hour = Number(h);
    const minute = Number(m);
    if (Number.isFinite(hour) && Number.isFinite(minute)) {
      setCadence((prev) => ({ ...prev, hour, minute }));
    }
  };

  const pickChip = (id: CadenceChipId) => {
    haptic.light();
    setSaveError(null);
    if (id === "custom" && cadence.chip !== "custom") {
      // Seed the raw field from the current draft so nothing is lost.
      setCustomCron(draftCron ?? "");
    }
    setCadence((prev) => ({ ...prev, chip: id }));
  };

  return (
    <SheetShell open onClose={onClose} label={`Edit ${schedule.name}`}>
      <div style={{ padding: "0 2px 4px" }}>
        <div style={{ fontSize: 19, fontWeight: 700, letterSpacing: "-.4px" }}>
          {schedule.name}
        </div>
        {/* Real fields only: no agent/delivery fields exist on a schedule,
            so this line surfaces the inference profile when one is pinned. */}
        {schedule.inferenceProfile ? (
          <div
            style={{ fontSize: 12, color: "var(--mv3-muted)", marginTop: 3 }}
          >
            Runs on the{" "}
            <span style={{ color: "var(--mv3-teal)" }}>
              {schedule.inferenceProfile}
            </span>{" "}
            model profile
          </div>
        ) : null}

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 10,
            marginTop: 14,
          }}
        >
          {cadenceEditable ? (
            <>
              <div>
                <SectionLabel>When</SectionLabel>
                <div
                  role="radiogroup"
                  aria-label="Cadence"
                  style={{ display: "flex", gap: 7, flexWrap: "wrap" }}
                >
                  {WHEN_CHIPS.map((chip) => (
                    <button
                      key={chip.id}
                      type="button"
                      role="radio"
                      aria-checked={cadence.chip === chip.id}
                      onClick={() => pickChip(chip.id)}
                      style={chipStyle(cadence.chip === chip.id)}
                    >
                      {chip.label}
                    </button>
                  ))}
                </div>
              </div>

              {cadence.chip === "weekly" ? (
                <div
                  role="radiogroup"
                  aria-label="Day of week"
                  style={{ display: "flex", gap: 6 }}
                >
                  {WEEKDAYS.map((day) => {
                    const selected = cadence.weekday === day.value;
                    return (
                      <button
                        key={day.value}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        aria-label={day.full}
                        onClick={() => {
                          haptic.light();
                          setCadence((prev) => ({
                            ...prev,
                            weekday: day.value,
                          }));
                        }}
                        style={{
                          ...chipStyle(selected),
                          flex: 1,
                          padding: "7px 0",
                          textAlign: "center",
                        }}
                      >
                        {day.letter}
                      </button>
                    );
                  })}
                </div>
              ) : null}

              {cadence.chip === "custom" ? (
                <div>
                  <input
                    type="text"
                    value={customCron}
                    onChange={(e) => {
                      setSaveError(null);
                      setCustomCron(e.target.value);
                    }}
                    placeholder="30 7 * * 1-5"
                    aria-label="Cron expression"
                    autoCapitalize="off"
                    autoCorrect="off"
                    spellCheck={false}
                    style={{
                      ...fieldCard,
                      width: "100%",
                      fontFamily: mv3Mono,
                      fontSize: 16,
                      color: "var(--mv3-text)",
                      outline: "none",
                    }}
                  />
                  <div
                    style={{
                      fontSize: 10.5,
                      color: customInvalid
                        ? "#E5675B"
                        : "var(--mv3-faint)",
                      marginTop: 6,
                    }}
                  >
                    {customInvalid
                      ? "Cron needs 5 fields: minute hour day month weekday"
                      : "minute · hour · day of month · month · weekday"}
                  </div>
                </div>
              ) : (
                <label
                  style={{
                    ...fieldCard,
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    cursor: "pointer",
                  }}
                >
                  <span
                    style={{
                      fontSize: 13,
                      color: "var(--mv3-muted)",
                      flex: 1,
                    }}
                  >
                    At
                    {zoneLabel ? (
                      /* The time field edits the cron's wall clock, which the
                         daemon runs in this zone — not the phone's. */
                      <span
                        style={{
                          fontSize: 10.5,
                          color: "var(--mv3-faint)",
                          marginLeft: 6,
                        }}
                      >
                        {zoneLabel}
                      </span>
                    ) : null}
                  </span>
                  <input
                    type="time"
                    value={toTimeValue(cadence.hour, cadence.minute)}
                    onChange={(e) => setTime(e.target.value)}
                    aria-label="Time of day"
                    style={{
                      fontSize: 22,
                      fontWeight: 700,
                      fontVariantNumeric: "tabular-nums",
                      fontFamily: "inherit",
                      color: "var(--mv3-text)",
                      background: "transparent",
                      border: "none",
                      outline: "none",
                      colorScheme: "dark light",
                    }}
                  />
                </label>
              )}
            </>
          ) : (
            <div style={{ fontSize: 12, color: "var(--mv3-muted)" }}>
              {schedule.isOneShot
                ? `One-time — runs ${formatTimestamp(schedule.nextRunAt)}`
                : "This schedule's timing isn't a simple cron — adjust it in chat or on desktop."}
            </div>
          )}

          <div>
            <SectionLabel>What it does</SectionLabel>
            <textarea
              value={message}
              onChange={(e) => {
                setSaveError(null);
                setMessage(e.target.value);
              }}
              rows={3}
              aria-label="What this schedule does"
              style={{
                ...fieldCard,
                width: "100%",
                fontSize: 16,
                lineHeight: 1.5,
                fontFamily: "inherit",
                color: "var(--mv3-text)",
                outline: "none",
                resize: "none",
              }}
            />
            {schedule.mode === "script" ? (
              <div
                style={{
                  fontSize: 10.5,
                  color: "var(--mv3-faint)",
                  marginTop: 5,
                }}
              >
                Runs a script — the shell command itself is edited on desktop.
              </div>
            ) : null}
          </div>

          {/* Raw cron footnote + enable toggle (frame 40's bottom row). */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "2px 2px",
            }}
          >
            <span
              style={{
                fontFamily: mv3Mono,
                fontSize: 10,
                color: "var(--mv3-faint)",
                flex: 1,
                overflowWrap: "anywhere",
              }}
            >
              {draftCron
                ? `cron ${draftCron}${zoneLabel ? ` (${zoneLabel})` : ""} · next run ${nextRunLabel}`
                : `next run ${nextRunLabel}`}
            </span>
            <button
              type="button"
              role="switch"
              aria-checked={liveEnabled}
              aria-label={liveEnabled ? "Pause schedule" : "Resume schedule"}
              onClick={() => {
                haptic.light();
                toggleMutation.mutate(!liveEnabled);
              }}
              style={{
                width: 40,
                height: 24,
                borderRadius: 99,
                border: "none",
                padding: 0,
                margin: "10px 0",
                background: liveEnabled
                  ? "var(--mv3-accent)"
                  : "var(--mv3-track)",
                position: "relative",
                cursor: "pointer",
                flexShrink: 0,
                transition: "background .2s ease",
              }}
            >
              <span
                aria-hidden
                style={{
                  position: "absolute",
                  top: 2,
                  left: liveEnabled ? 18 : 2,
                  width: 20,
                  height: 20,
                  borderRadius: "50%",
                  background: "#fff",
                  transition: "left .2s ease",
                }}
              />
            </button>
          </div>
        </div>

        {saveError ? (
          <div
            role="alert"
            style={{
              fontSize: 11.5,
              color: "#E5675B",
              marginTop: 4,
              lineHeight: 1.4,
            }}
          >
            {saveError}
          </div>
        ) : null}

        <button
          type="button"
          disabled={!dirty || customInvalid || saveMutation.isPending}
          onClick={() => {
            haptic.medium();
            setSaveError(null);
            saveMutation.mutate();
          }}
          style={{
            width: "100%",
            background:
              !dirty || customInvalid
                ? "var(--mv3-btn2-bg)"
                : "linear-gradient(160deg, #4E7CEC, #3560CC)",
            color: !dirty || customInvalid ? "var(--mv3-faint)" : "#fff",
            border: "none",
            borderRadius: 14,
            padding: 14,
            fontSize: 14.5,
            fontWeight: 600,
            fontFamily: "inherit",
            marginTop: 12,
            cursor: !dirty || customInvalid ? "default" : "pointer",
            boxShadow:
              !dirty || customInvalid
                ? "none"
                : "0 14px 30px -10px rgba(61,110,232,.6)",
          }}
        >
          {saveMutation.isPending ? "Saving…" : "Save schedule"}
        </button>

        <div style={{ display: "flex", justifyContent: "center" }}>
          <button
            type="button"
            disabled={deleteMutation.isPending}
            onClick={() => {
              if (!confirmDelete) {
                haptic.light();
                setConfirmDelete(true);
                return;
              }
              haptic.medium();
              deleteMutation.mutate();
            }}
            style={{
              fontSize: 12,
              color: "#E5675B",
              background: "none",
              border: "none",
              padding: "12px 16px",
              minHeight: 44,
              cursor: "pointer",
              fontFamily: "inherit",
              fontWeight: confirmDelete ? 600 : 400,
            }}
          >
            {deleteMutation.isPending
              ? "Deleting…"
              : confirmDelete
                ? "Tap again to delete"
                : "Delete"}
          </button>
        </div>
      </div>
    </SheetShell>
  );
}
