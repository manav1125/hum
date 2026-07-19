/**
 * Mobile-v3 settings leafs (task #101) — the touch-adapted screens for the
 * highest-value settings pages (parity-audit §7 priority): AI models,
 * Privacy, Schedules (list), Voice, Sounds, Appearance.
 *
 * Each leaf renders the SAME stores/mutations its desktop page uses (config
 * PATCH, device settings, `settings/client` KV, sounds config PUT, schedule
 * toggle) in You-cluster row grammar. Anything a phone can't sensibly edit
 * (cron editor, provider keys, PTT hotkey capture, per-event sound files)
 * stays on desktop and says so in a footnote. Desktop pages untouched.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";

import {
  AUTO_PROFILE_NAME,
  gateAutoProfile,
  profilePickerLabel,
  visibleProfilesForPicker,
} from "@/assistant/profile-pickers";
import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { buildOrderedProfiles } from "@/domains/settings/ai/ai-utils";
import {
  fetchSchedules,
  toggleSchedule,
} from "@/domains/settings/api/schedules";
import type { Schedule } from "@/domains/settings/types/schedules";
import {
  defaultSoundsConfig,
  SOUND_EVENT_DISPLAY_NAMES,
  SOUND_EVENT_IDS,
  type SoundEventId,
} from "@/domains/settings/types/sounds";
import { getSoundManager } from "@/domains/settings/utils/sound-manager";
import { groupSchedules } from "@/domains/settings/utils/schedule-formatters";
import {
  applyThemePreference,
  readStoredThemePreference,
  writeStoredThemePreference,
  type ThemePreference,
} from "@/domains/settings/utils/theme-preferences";
import {
  configGetOptions,
  configGetSetQueryData,
  soundsConfigGetOptions,
  soundsConfigGetSetQueryData,
  soundsConfigPutMutation,
  useConfigPatchMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import { settingsClientPut } from "@/generated/daemon/sdk.gen";
import type { SoundsConfigGetResponse } from "@/generated/daemon/types.gen";
import { captureError } from "@/lib/sentry/capture-error";
import { assistantSchedulesQueryKey } from "@/lib/sync/query-tags";
import { GlassCard } from "@/mobile-v3/glass-card";
import { microLabel, rise } from "@/mobile-v3/mv3-kit";
import { Eyebrow } from "@/mobile-v3/you/you-kit";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";
import { useHasPlatformSession } from "@/stores/auth-store";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import {
  getDeviceBool,
  getDeviceSetting,
  setDeviceSetting,
} from "@/utils/device-settings";
import { haptic } from "@/utils/haptics";
import {
  getLocalSetting,
  removeLocalSetting,
  setLocalSetting,
} from "@/utils/local-settings";
import { savePreferenceToggle } from "@/utils/onboarding-cleanup";
import { routes } from "@/utils/routes";
import {
  LS_VOICE_INPUT_DEVICE,
  getPreferredInputDeviceId,
} from "@/utils/voice-input-device";

import {
  Mv3SettingsNote,
  Mv3SettingsScreen,
} from "@/domains/settings/mobile/mobile-settings-kit";

type SoundsConfig = SoundsConfigGetResponse;

// ---------------------------------------------------------------------------
// Row primitives (frame-20 row grammar, mirrors the Rules screen).
// ---------------------------------------------------------------------------

function rowShell(isLast?: boolean): React.CSSProperties {
  return {
    width: "100%",
    display: "flex",
    alignItems: "center",
    gap: 11,
    padding: "13px 15px",
    minHeight: 52,
    textAlign: "left",
    background: "transparent",
    border: "none",
    borderBottom: isLast ? "none" : "1px solid var(--mv3-line)",
    fontFamily: "inherit",
    color: "var(--mv3-text)",
  };
}

function RowText({
  name,
  line,
}: {
  name: string;
  line?: React.ReactNode;
}) {
  return (
    <span style={{ flex: 1, minWidth: 0 }}>
      <span
        style={{
          display: "block",
          fontSize: 13.5,
          fontWeight: 600,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {name}
      </span>
      {line ? (
        <span
          style={{
            display: "block",
            fontSize: 11,
            color: "var(--mv3-muted)",
            marginTop: 1,
          }}
        >
          {line}
        </span>
      ) : null}
    </span>
  );
}

function StateChip({ on, onText = "ON", offText = "OFF" }: {
  on: boolean;
  onText?: string;
  offText?: string;
}) {
  const color = on ? "var(--mv3-green)" : "var(--mv3-faint)";
  return (
    <span
      style={{
        ...microLabel,
        fontSize: 9.5,
        color,
        background: `color-mix(in srgb, ${color} 12%, transparent)`,
        padding: "4px 9px",
        borderRadius: 6,
        flexShrink: 0,
      }}
    >
      {on ? onText : offText}
    </span>
  );
}

/** Full-row toggle — tap anywhere flips it (52px target, haptic tick). */
function ToggleRow({
  name,
  line,
  on,
  disabled,
  isLast,
  onToggle,
  onText,
  offText,
}: {
  name: string;
  line?: React.ReactNode;
  on: boolean;
  disabled?: boolean;
  isLast?: boolean;
  onToggle: () => void;
  onText?: string;
  offText?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={name}
      disabled={disabled}
      onClick={() => {
        haptic.light();
        onToggle();
      }}
      style={{
        ...rowShell(isLast),
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.55 : 1,
      }}
    >
      <RowText name={name} line={line} />
      <StateChip on={on} onText={onText} offText={offText} />
    </button>
  );
}

/** Radio-style row — one-of-N selection (retention, timeout, theme, mic). */
function RadioRow({
  name,
  line,
  selected,
  isLast,
  onPress,
}: {
  name: string;
  line?: React.ReactNode;
  selected: boolean;
  isLast?: boolean;
  onPress: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={() => {
        haptic.light();
        onPress();
      }}
      style={{ ...rowShell(isLast), cursor: "pointer" }}
    >
      <span
        aria-hidden
        style={{
          width: 18,
          height: 18,
          borderRadius: "50%",
          border: selected
            ? "2px solid var(--mv3-accent)"
            : "2px solid var(--mv3-btn2-border)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
        }}
      >
        {selected ? (
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              background: "var(--mv3-accent)",
            }}
          />
        ) : null}
      </span>
      <RowText name={name} line={line} />
    </button>
  );
}

function SectionCard({
  eyebrow,
  delay,
  children,
}: {
  eyebrow?: string;
  delay: number;
  children: React.ReactNode;
}) {
  return (
    <div style={rise(delay)}>
      {eyebrow ? (
        <div style={{ padding: "4px 4px 8px" }}>
          <Eyebrow>{eyebrow}</Eyebrow>
        </div>
      ) : null}
      <GlassCard padding={0} radius={20} style={{ overflow: "hidden" }}>
        {children}
      </GlassCard>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Appearance (settings/general) — theme picker; the rest stays desktop.
// ---------------------------------------------------------------------------

const THEME_ROWS: ReadonlyArray<{
  value: ThemePreference;
  name: string;
  line: string;
}> = [
  { value: "system", name: "System", line: "Follows the device appearance" },
  { value: "light", name: "Light", line: "Always light" },
  { value: "dark", name: "Dark", line: "Always dark" },
  { value: "velvet", name: "Velvet", line: "The deep-red night theme" },
];

export function Mv3AppearanceLeaf() {
  const velvet = useClientFeatureFlagStore.use.velvet();
  const [theme, setTheme] = useState<ThemePreference>(() =>
    readStoredThemePreference({ velvetEnabled: velvet }),
  );

  const pick = (next: ThemePreference) => {
    setTheme(next);
    writeStoredThemePreference(next);
    applyThemePreference(next);
  };

  const rows = THEME_ROWS.filter((r) => r.value !== "velvet" || velvet);

  return (
    <Mv3SettingsScreen
      title="Appearance"
      sub="Theme for every Cue surface"
      tint="lavender"
      testId="mv3-settings-appearance"
    >
      <SectionCard eyebrow="Theme" delay={0.1}>
        {rows.map((row, i) => (
          <RadioRow
            key={row.value}
            name={row.name}
            line={row.line}
            selected={theme === row.value}
            isLast={i === rows.length - 1}
            onPress={() => pick(row.value)}
          />
        ))}
      </SectionCard>
      <Mv3SettingsNote>
        Assistant name, timezone and software updates live in Settings →
        General on desktop.
      </Mv3SettingsNote>
    </Mv3SettingsScreen>
  );
}

// ---------------------------------------------------------------------------
// AI models (settings/ai) — default profile + default effort.
// ---------------------------------------------------------------------------

const EFFORT_OPTIONS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
type EffortOption = (typeof EFFORT_OPTIONS)[number];

export function Mv3AiLeaf() {
  const assistantId = useActiveAssistantId();
  const queryClient = useQueryClient();

  const { data: config, isLoading } = useQuery({
    ...configGetOptions({ path: { assistant_id: assistantId } }),
    staleTime: 30_000,
  });

  const activeProfile = config?.llm?.activeProfile ?? null;
  const defaultModel = config?.llm?.default?.model ?? null;
  const effort = (config?.llm?.default?.effort ?? null) as EffortOption | null;

  const queryComplexityRoutingEnabled =
    useAssistantFeatureFlagStore.use.queryComplexityRouting();

  const entries = useMemo(
    () =>
      gateAutoProfile(
        visibleProfilesForPicker(
          buildOrderedProfiles(
            config?.llm?.profiles ?? {},
            config?.llm?.profileOrder ?? [],
          ),
          [activeProfile],
        ),
        queryComplexityRoutingEnabled,
      ),
    [config, activeProfile, queryComplexityRoutingEnabled],
  );

  const configMutation = useConfigPatchMutation({
    onSuccess: (data) => {
      configGetSetQueryData(
        queryClient,
        { path: { assistant_id: assistantId } },
        data,
      );
      haptic.success();
    },
    onError: () => haptic.error(),
  });

  const setProfile = (name: string) => {
    if (name === activeProfile || configMutation.isPending) return;
    configMutation.mutate({
      path: { assistant_id: assistantId },
      body: { llm: { activeProfile: name } },
    });
  };

  const setEffort = (next: EffortOption) => {
    if (next === effort || configMutation.isPending) return;
    configMutation.mutate({
      path: { assistant_id: assistantId },
      body: { llm: { default: { effort: next } } },
    });
  };

  return (
    <Mv3SettingsScreen
      title="AI models"
      sub={
        defaultModel
          ? `Running on ${defaultModel}`
          : isLoading
            ? "Reading the model config…"
            : "Which brain answers, and how hard it thinks"
      }
      tint="blue"
      testId="mv3-settings-ai"
    >
      <SectionCard eyebrow="Default profile" delay={0.1}>
        {entries.length === 0 ? (
          <div
            style={{
              padding: "14px 15px",
              fontSize: 12.5,
              color: "var(--mv3-muted)",
            }}
          >
            {isLoading
              ? "Loading profiles…"
              : "No profiles yet — create one in desktop Settings → Models & Services."}
          </div>
        ) : (
          entries.map((p, i) => (
            <RadioRow
              key={p.name}
              name={
                p.name === AUTO_PROFILE_NAME
                  ? "Auto"
                  : profilePickerLabel(p)
              }
              line={
                p.name === AUTO_PROFILE_NAME
                  ? "Automatically switch between profiles"
                  : (p.description ?? p.model ?? undefined)
              }
              selected={activeProfile === p.name}
              isLast={i === entries.length - 1}
              onPress={() => setProfile(p.name)}
            />
          ))
        )}
      </SectionCard>

      <SectionCard eyebrow="Default effort" delay={0.25}>
        <div
          role="radiogroup"
          aria-label="Default effort"
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 7,
            padding: "13px 15px",
          }}
        >
          {EFFORT_OPTIONS.map((opt) => {
            const active = effort === opt;
            return (
              <button
                key={opt}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => {
                  haptic.light();
                  setEffort(opt);
                }}
                style={{
                  fontSize: 12.5,
                  fontWeight: active ? 600 : 400,
                  fontFamily: "inherit",
                  color: active ? "var(--mv3-bg)" : "var(--mv3-muted)",
                  background: active
                    ? "var(--mv3-text)"
                    : "var(--mv3-btn2-bg)",
                  border: active
                    ? "1px solid transparent"
                    : "1px solid var(--mv3-btn2-border)",
                  borderRadius: 99,
                  padding: "8px 14px",
                  minHeight: 36,
                  cursor: "pointer",
                  WebkitTapHighlightColor: "transparent",
                }}
              >
                {opt}
              </button>
            );
          })}
        </div>
        <div
          style={{
            padding: "0 15px 13px",
            fontSize: 11,
            color: "var(--mv3-faint)",
            lineHeight: 1.5,
          }}
        >
          How much reasoning the default model spends per turn.
          {effort === null ? " Currently using the model's default." : ""}
        </div>
      </SectionCard>

      {configMutation.isError ? (
        <GlassCard>
          <div style={{ fontSize: 12.5, color: "#E5675B" }}>
            Couldn&rsquo;t save — check the connection and try again.
          </div>
        </GlassCard>
      ) : null}

      <Mv3SettingsNote>
        Providers, API keys, image · speech · web-search services and call-site
        overrides are managed in desktop Settings → Models &amp; Services.
      </Mv3SettingsNote>
    </Mv3SettingsScreen>
  );
}

// ---------------------------------------------------------------------------
// Privacy (settings/privacy) — sharing toggles + LLM log retention.
// ---------------------------------------------------------------------------

const RETENTION_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "dontRetain", label: "Don't retain" },
  { value: "oneHour", label: "1 hour" },
  { value: "oneDay", label: "1 day" },
  { value: "sevenDays", label: "7 days" },
  { value: "thirtyDays", label: "30 days" },
  { value: "ninetyDays", label: "90 days" },
  { value: "keepForever", label: "Keep forever" },
];
const DEFAULT_RETENTION_ID = "thirtyDays";
const LLM_LOG_RETENTION_KEY = "llmLogRetention";

export function Mv3PrivacyLeaf() {
  const navigate = useNavigate();
  const hasPlatformSession = useHasPlatformSession();
  // Settings routes are NOT under `<ActiveAssistantGate>` — raw store read
  // (nullable), matching the desktop privacy page.
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();

  const [shareAnalytics, setShareAnalytics] = useState(() =>
    getDeviceBool("shareAnalytics", true),
  );
  const [shareDiagnostics, setShareDiagnostics] = useState(() =>
    getDeviceBool("shareDiagnostics", true),
  );
  const [retentionId, setRetentionId] = useState(() =>
    getDeviceSetting(LLM_LOG_RETENTION_KEY, DEFAULT_RETENTION_ID),
  );

  const setRetention = (value: string) => {
    setRetentionId(value);
    setDeviceSetting(LLM_LOG_RETENTION_KEY, value);
    if (assistantId) {
      void settingsClientPut({
        path: { assistant_id: assistantId },
        body: { key: LLM_LOG_RETENTION_KEY, value },
        throwOnError: true,
      }).catch((error) => {
        captureError(error, { context: "settings-llm-log-retention" });
      });
    }
  };

  return (
    <Mv3SettingsScreen
      title="Privacy"
      sub="What leaves this device, and for how long"
      tint="teal"
      testId="mv3-settings-privacy"
    >
      <SectionCard eyebrow="Sharing" delay={0.1}>
        <ToggleRow
          name="Share analytics"
          line="Anonymous usage data — never your conversations"
          on={shareAnalytics}
          onToggle={() => {
            const next = !shareAnalytics;
            setShareAnalytics(next);
            savePreferenceToggle("share_analytics", next, hasPlatformSession);
          }}
        />
        <ToggleRow
          name="Share diagnostics"
          line="Crash reports and performance metrics"
          on={shareDiagnostics}
          isLast
          onToggle={() => {
            const next = !shareDiagnostics;
            setShareDiagnostics(next);
            savePreferenceToggle(
              "share_diagnostics",
              next,
              hasPlatformSession,
            );
          }}
        />
      </SectionCard>

      <SectionCard eyebrow="LLM request log retention" delay={0.25}>
        {RETENTION_OPTIONS.map((opt, i) => (
          <RadioRow
            key={opt.value}
            name={opt.label}
            selected={retentionId === opt.value}
            isLast={i === RETENTION_OPTIONS.length - 1}
            onPress={() => setRetention(opt.value)}
          />
        ))}
      </SectionCard>
      <Mv3SettingsNote>
        Prompts and completions kept on this device for debugging — shorter is
        more private.
      </Mv3SettingsNote>

      <div style={rise(0.4)}>
        <GlassCard padding={0} radius={20} style={{ overflow: "hidden" }}>
          <button
            type="button"
            className="cue-pressable"
            onClick={() => {
              haptic.light();
              navigate(routes.guardrails);
            }}
            style={{ ...rowShell(true), cursor: "pointer" }}
          >
            <RowText
              name="Autonomy & trust rules"
              line="What Cue may do alone — lives in Rules"
            />
            <span style={{ color: "var(--mv3-faint)" }} aria-hidden>
              ›
            </span>
          </button>
        </GlassCard>
      </div>
      <Mv3SettingsNote>
        Biometric lock and system permissions are set from the desktop app.
      </Mv3SettingsNote>
    </Mv3SettingsScreen>
  );
}

// ---------------------------------------------------------------------------
// Schedules (settings/schedules) — LIST + enable/disable. Editor = desktop.
// ---------------------------------------------------------------------------

export function Mv3SchedulesLeaf() {
  const assistantId = useActiveAssistantId();
  const queryClient = useQueryClient();

  const queryKey = assistantSchedulesQueryKey(assistantId);
  const { data: schedules, isLoading, isError } = useQuery({
    queryKey,
    queryFn: () => fetchSchedules(assistantId),
    staleTime: 10_000,
  });

  // Mount-time snapshot (matches the desktop page's one-shot boundary).
  const [now] = useState(() => Date.now());

  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      toggleSchedule(assistantId, id, enabled),
    onMutate: async ({ id, enabled }) => {
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<Schedule[]>(queryKey);
      queryClient.setQueryData<Schedule[]>(queryKey, (prev) =>
        prev?.map((s) => (s.id === id ? { ...s, enabled } : s)),
      );
      return { previous };
    },
    onError: (_e, _v, ctx) => {
      haptic.error();
      if (ctx?.previous) queryClient.setQueryData(queryKey, ctx.previous);
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey }),
  });

  const list = schedules ?? [];
  const { recurring, upcomingOneTime, pastOneTime } = groupSchedules(
    list,
    now,
  );

  const renderRows = (rows: Schedule[]) =>
    rows.map((s, i) => (
      <ToggleRow
        key={s.id}
        name={s.name}
        line={s.cadenceDescription || s.description || undefined}
        on={s.enabled}
        isLast={i === rows.length - 1}
        onToggle={() =>
          toggleMutation.mutate({ id: s.id, enabled: !s.enabled })
        }
      />
    ));

  return (
    <Mv3SettingsScreen
      title="Schedules"
      sub={
        isLoading
          ? "Reading your schedules…"
          : `${recurring.length + upcomingOneTime.length} live · tap to pause or resume`
      }
      tint="teal"
      testId="mv3-settings-schedules"
    >
      {isError ? (
        <GlassCard>
          <div style={{ fontSize: 12.5, color: "#E5675B" }}>
            Couldn&rsquo;t load schedules — pull back and try again.
          </div>
        </GlassCard>
      ) : null}

      {!isLoading && list.length === 0 && !isError ? (
        <GlassCard>
          <div
            style={{
              fontSize: 12.5,
              color: "var(--mv3-muted)",
              lineHeight: 1.5,
            }}
          >
            No schedules yet — ask Cue to set one up (&ldquo;every weekday at
            8, brief me&rdquo;) and it shows up here.
          </div>
        </GlassCard>
      ) : null}

      {recurring.length > 0 ? (
        <SectionCard eyebrow="Recurring" delay={0.1}>
          {renderRows(recurring)}
        </SectionCard>
      ) : null}
      {upcomingOneTime.length > 0 ? (
        <SectionCard eyebrow="One-time" delay={0.25}>
          {renderRows(upcomingOneTime)}
        </SectionCard>
      ) : null}
      {pastOneTime.length > 0 ? (
        <Mv3SettingsNote>
          {pastOneTime.length} past one-time schedule
          {pastOneTime.length === 1 ? "" : "s"} — history on desktop.
        </Mv3SettingsNote>
      ) : null}
      <Mv3SettingsNote>
        Creating schedules and editing cadence, prompts or run history isn&rsquo;t
        touch-adapted yet — use desktop Settings → Schedules.
      </Mv3SettingsNote>
    </Mv3SettingsScreen>
  );
}

// ---------------------------------------------------------------------------
// Voice (settings/voice) — mic device + conversation timeout.
// ---------------------------------------------------------------------------

/** Same storage key the desktop voice page writes (module-local there). */
const LS_CONVERSATION_TIMEOUT = "vellum:voice:conversationTimeoutSeconds";

const TIMEOUT_OPTIONS = [
  { label: "5 seconds", value: "5" },
  { label: "10 seconds", value: "10" },
  { label: "15 seconds", value: "15" },
  { label: "30 seconds", value: "30" },
  { label: "60 seconds", value: "60" },
] as const;
type TimeoutValue = (typeof TIMEOUT_OPTIONS)[number]["value"];
const DEFAULT_TIMEOUT: TimeoutValue = "30";
const SYSTEM_DEFAULT_DEVICE = "";

export function Mv3VoiceLeaf() {
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();

  // --- microphone (mirrors the desktop MicrophoneCard) ---
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [needsPermission, setNeedsPermission] = useState(false);
  const [deviceId, setDeviceId] = useState<string>(() =>
    getPreferredInputDeviceId(),
  );

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      const inputs = all.filter((d) => d.kind === "audioinput");
      setNeedsPermission(inputs.length > 0 && inputs.every((d) => !d.label));
      setDevices(
        inputs.filter(
          (d) =>
            d.deviceId !== "" &&
            d.deviceId !== "default" &&
            d.deviceId !== "communications",
        ),
      );
    } catch {
      setDevices([]);
      setNeedsPermission(false);
    }
  }, []);

  const requestMicAccess = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      for (const track of stream.getTracks()) track.stop();
    } catch {
      /* denied — keep System Default */
    }
    void refreshDevices();
  }, [refreshDevices]);

  useEffect(() => {
    void refreshDevices();
    const mediaDevices = navigator.mediaDevices;
    if (!mediaDevices?.addEventListener) return;
    const onChange = () => void refreshDevices();
    mediaDevices.addEventListener("devicechange", onChange);
    return () => mediaDevices.removeEventListener("devicechange", onChange);
  }, [refreshDevices]);

  const micOptions = useMemo(
    () => [
      { value: SYSTEM_DEFAULT_DEVICE, label: "System default" },
      ...devices.map((d, i) => ({
        value: d.deviceId,
        label: d.label || `Microphone ${i + 1}`,
      })),
    ],
    [devices],
  );
  const selectedMic = micOptions.some((o) => o.value === deviceId)
    ? deviceId
    : SYSTEM_DEFAULT_DEVICE;

  const pickMic = (next: string) => {
    setDeviceId(next);
    if (next === SYSTEM_DEFAULT_DEVICE) {
      removeLocalSetting(LS_VOICE_INPUT_DEVICE);
    } else {
      setLocalSetting(LS_VOICE_INPUT_DEVICE, next);
    }
  };

  // --- conversation timeout (mirrors ConversationTimeoutCard) ---
  const [timeoutValue, setTimeoutValue] = useState<TimeoutValue>(() => {
    const raw = getLocalSetting(LS_CONVERSATION_TIMEOUT, DEFAULT_TIMEOUT);
    return (
      TIMEOUT_OPTIONS.find((o) => o.value === raw)?.value ?? DEFAULT_TIMEOUT
    );
  });
  const pickTimeout = (next: TimeoutValue) => {
    setTimeoutValue(next);
    setLocalSetting(LS_CONVERSATION_TIMEOUT, next);
    if (assistantId) {
      void settingsClientPut({
        path: { assistant_id: assistantId },
        body: { key: LS_CONVERSATION_TIMEOUT, value: next },
        throwOnError: true,
      }).catch((error) => {
        captureError(error, { context: "settings-conversation-timeout" });
      });
    }
  };

  return (
    <Mv3SettingsScreen
      title="Voice"
      sub="Dictation and live-voice input"
      tint="blue"
      testId="mv3-settings-voice"
    >
      <SectionCard eyebrow="Microphone" delay={0.1}>
        {micOptions.map((opt, i) => (
          <RadioRow
            key={opt.value || "system-default"}
            name={opt.label}
            selected={selectedMic === opt.value}
            isLast={i === micOptions.length - 1}
            onPress={() => pickMic(opt.value)}
          />
        ))}
      </SectionCard>
      {needsPermission ? (
        <button
          type="button"
          className="cue-pressable"
          onClick={() => {
            haptic.medium();
            void requestMicAccess();
          }}
          style={{
            fontSize: 13,
            fontWeight: 600,
            fontFamily: "inherit",
            color: "var(--mv3-text)",
            background: "var(--mv3-btn2-bg)",
            border: "1px solid var(--mv3-btn2-border)",
            borderRadius: 13,
            padding: 12,
            minHeight: 44,
            cursor: "pointer",
          }}
        >
          Allow microphone access to list devices
        </button>
      ) : null}

      <SectionCard eyebrow="Conversation timeout" delay={0.25}>
        {TIMEOUT_OPTIONS.map((opt, i) => (
          <RadioRow
            key={opt.value}
            name={opt.label}
            selected={timeoutValue === opt.value}
            isLast={i === TIMEOUT_OPTIONS.length - 1}
            onPress={() => pickTimeout(opt.value)}
          />
        ))}
      </SectionCard>
      <Mv3SettingsNote>
        How long Cue waits for you to start speaking before ending a voice
        turn. Push-to-talk shortcuts and speech models (STT/TTS) are set on
        desktop.
      </Mv3SettingsNote>
    </Mv3SettingsScreen>
  );
}

// ---------------------------------------------------------------------------
// Sounds (settings/sounds) — master switch, volume, per-event toggles.
// ---------------------------------------------------------------------------

export function Mv3SoundsLeaf() {
  const assistantId = useActiveAssistantId();
  const queryClient = useQueryClient();

  const configOptions = useMemo(
    () => soundsConfigGetOptions({ path: { assistant_id: assistantId } }),
    [assistantId],
  );
  const { data: rawConfig } = useQuery(configOptions);
  const config = rawConfig ?? defaultSoundsConfig();

  const sdkOptions = useMemo(
    () => ({ path: { assistant_id: assistantId } }),
    [assistantId],
  );

  const saveMutation = useMutation({
    ...soundsConfigPutMutation(sdkOptions),
    onMutate: async (variables) => {
      await queryClient.cancelQueries({ queryKey: configOptions.queryKey });
      const previous = queryClient.getQueryData(configOptions.queryKey);
      soundsConfigGetSetQueryData(queryClient, sdkOptions, variables.body);
      return { previous };
    },
    onError: (_error, _next, context) => {
      haptic.error();
      if (context?.previous !== undefined) {
        soundsConfigGetSetQueryData(queryClient, sdkOptions, context.previous);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: configOptions.queryKey });
    },
  });

  const updateConfig = useCallback(
    (producer: (prev: SoundsConfig) => SoundsConfig) => {
      const prev =
        queryClient.getQueryData(configOptions.queryKey) ??
        defaultSoundsConfig();
      saveMutation.mutate({
        path: { assistant_id: assistantId },
        body: producer(prev),
      });
    },
    [assistantId, configOptions.queryKey, queryClient, saveMutation],
  );

  const [draftVolume, setDraftVolume] = useState<number | null>(null);
  const displayVolume = draftVolume ?? config.volume;
  const commitVolume = (volume: number) => {
    setDraftVolume(null);
    if (volume !== config.volume) {
      updateConfig((prev) => ({ ...prev, volume }));
    }
  };

  return (
    <Mv3SettingsScreen
      title="Sounds"
      sub="Event-driven sound effects"
      tint="teal"
      testId="mv3-settings-sounds"
    >
      <SectionCard delay={0.1}>
        <ToggleRow
          name="Sound effects"
          line="Master switch for every event sound"
          on={config.globalEnabled}
          onToggle={() =>
            updateConfig((prev) => ({
              ...prev,
              globalEnabled: !prev.globalEnabled,
            }))
          }
        />
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "13px 15px",
            minHeight: 52,
            borderBottom: "1px solid var(--mv3-line)",
            opacity: config.globalEnabled ? 1 : 0.55,
          }}
        >
          <span style={{ fontSize: 13.5, fontWeight: 600, flexShrink: 0 }}>
            Volume
          </span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={displayVolume}
            disabled={!config.globalEnabled}
            onChange={(e) => setDraftVolume(parseFloat(e.target.value))}
            onPointerUp={(e) => commitVolume(parseFloat(e.currentTarget.value))}
            onKeyUp={(e) => commitVolume(parseFloat(e.currentTarget.value))}
            onBlur={(e) => commitVolume(parseFloat(e.currentTarget.value))}
            aria-label="Sound effect volume"
            style={{
              flex: 1,
              minHeight: 30,
              accentColor: "var(--mv3-accent)",
            }}
          />
          <span
            style={{
              fontSize: 12,
              fontFamily: "var(--mv3-mono)",
              color: "var(--mv3-muted)",
              width: 38,
              textAlign: "right",
              flexShrink: 0,
            }}
          >
            {Math.round(displayVolume * 100)}%
          </span>
        </div>
        <button
          type="button"
          disabled={!config.globalEnabled}
          onClick={() => {
            haptic.light();
            void getSoundManager().previewFallbackBlip(config.volume);
          }}
          style={{
            ...rowShell(true),
            cursor: config.globalEnabled ? "pointer" : "default",
            opacity: config.globalEnabled ? 1 : 0.55,
          }}
        >
          <RowText name="Preview" line="Play the default blip" />
          <span style={{ fontSize: 13, color: "var(--mv3-micro)" }}>▶</span>
        </button>
      </SectionCard>

      <SectionCard eyebrow="Sound events" delay={0.25}>
        {SOUND_EVENT_IDS.map((event: SoundEventId, i) => {
          const eventConfig =
            config.events[event] ?? { enabled: false, sounds: [] };
          return (
            <ToggleRow
              key={event}
              name={SOUND_EVENT_DISPLAY_NAMES[event] ?? event}
              line={
                eventConfig.sounds.length > 0
                  ? `${eventConfig.sounds.length} custom sound${
                      eventConfig.sounds.length === 1 ? "" : "s"
                    }`
                  : "Default blip"
              }
              on={eventConfig.enabled}
              disabled={!config.globalEnabled}
              isLast={i === SOUND_EVENT_IDS.length - 1}
              onToggle={() =>
                updateConfig((prev) => ({
                  ...prev,
                  events: {
                    ...prev.events,
                    [event]: {
                      ...(prev.events[event] ?? {
                        enabled: false,
                        sounds: [],
                      }),
                      enabled: !(prev.events[event]?.enabled ?? false),
                    },
                  },
                }))
              }
            />
          );
        })}
      </SectionCard>
      <Mv3SettingsNote>
        Picking custom sound files per event is a desktop affordance.
      </Mv3SettingsNote>
    </Mv3SettingsScreen>
  );
}

// ---------------------------------------------------------------------------
// Route → adapted leaf map (consumed by MobileSettingsLayout).
// ---------------------------------------------------------------------------

export const MOBILE_LEAF_PAGES: Record<string, () => React.JSX.Element> = {
  [routes.settings.general]: Mv3AppearanceLeaf,
  [routes.settings.ai]: Mv3AiLeaf,
  [routes.settings.privacy]: Mv3PrivacyLeaf,
  [routes.settings.schedules]: Mv3SchedulesLeaf,
  [routes.settings.voice]: Mv3VoiceLeaf,
  [routes.settings.sounds]: Mv3SoundsLeaf,
};
