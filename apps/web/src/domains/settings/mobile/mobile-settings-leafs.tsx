/**
 * Mobile-v3 settings leafs (task #101 + the P2 polish sweep) — the
 * touch-adapted screens for the highest-value settings pages (parity-audit
 * §7 priority): AI models, Privacy, Schedules (list + the frame-40 editor
 * sheet), Voice, Sounds, Appearance, Integrations, Brand, Archive.
 *
 * Each leaf renders the SAME stores/mutations its desktop page uses (config
 * PATCH, device settings, `settings/client` KV, sounds config PUT, schedule
 * toggle/PATCH/DELETE, OAuth providers/connections, brand-profile activate,
 * conversation unarchive) in You-cluster row grammar. Anything a phone can't
 * sensibly edit (provider keys, PTT hotkey capture, per-event sound files)
 * stays on desktop and says so in a footnote. Desktop pages untouched.
 */
import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router";

import { getAssistant, type Assistant } from "@/assistant/api";
import {
  AUTO_PROFILE_NAME,
  gateAutoProfile,
  profilePickerLabel,
  visibleProfilesForPicker,
} from "@/assistant/profile-pickers";
import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { hideVendorUi, useManagedMode } from "@/assistant/use-managed-mode";
import { IntegrationIcon } from "@/components/integrations/integration-icon";
import { IntegrationDetailModal } from "@/domains/settings/components/integration-detail-modal";
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
import {
  formatNextRun,
  nextRunFromChipsInZone,
  parseCronToChips,
  resolveCronZone,
} from "@/domains/settings/utils/cron-chips";
import { formatTimeOfDay } from "@/domains/settings/utils/cron-builder";
import { groupSchedules } from "@/domains/settings/utils/schedule-formatters";
import {
  applyThemePreference,
  readStoredThemePreference,
  writeStoredThemePreference,
  type ThemePreference,
} from "@/domains/settings/utils/theme-preferences";
import { assistantsOauthConnectionsListOptions } from "@/generated/api/@tanstack/react-query.gen";
import type { OAuthConnection } from "@/generated/api/types.gen";
import {
  configGetOptions,
  configGetSetQueryData,
  oauthProvidersGetOptions,
  soundsConfigGetOptions,
  soundsConfigGetSetQueryData,
  soundsConfigPutMutation,
  useConfigPatchMutation,
} from "@/generated/daemon/@tanstack/react-query.gen";
import {
  conversationsByIdUnarchivePost,
  settingsClientPut,
} from "@/generated/daemon/sdk.gen";
import type { SoundsConfigGetResponse } from "@/generated/daemon/types.gen";
import { useArchivedConversationListQuery } from "@/hooks/conversation-queries";
import { usePlatformGate } from "@/hooks/use-platform-gate";
import { captureError } from "@/lib/sentry/capture-error";
import { assistantSchedulesQueryKey } from "@/lib/sync/query-tags";
import { GlassCard } from "@/mobile-v3/glass-card";
import { microLabel, rise } from "@/mobile-v3/mv3-kit";
import { Eyebrow, NavRow } from "@/mobile-v3/you/you-kit";
import {
  useActivateBrandProfile,
  useBrandProfiles,
  type BrandProfile,
} from "@/pages/brand-kit/use-brand-kit";
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
import type { Conversation } from "@/types/conversation-types";
import { invalidateConversationQueries } from "@/utils/conversation-cache";
import { routes } from "@/utils/routes";
import {
  LS_VOICE_INPUT_DEVICE,
  getPreferredInputDeviceId,
} from "@/utils/voice-input-device";

import {
  Mv3SettingsNote,
  Mv3SettingsScreen,
} from "@/domains/settings/mobile/mobile-settings-kit";
import { Mv3ScheduleEditorSheet } from "@/domains/settings/mobile/mobile-schedule-editor";

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

function RowText({ name, line }: { name: string; line?: React.ReactNode }) {
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

function StateChip({
  on,
  onText = "ON",
  offText = "OFF",
}: {
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

/** Radio-style row — one-of-N selection (retention, timeout, theme, mic).
 * `align: "trailing"` puts the ring on the RIGHT (round-4 frame 63 leaf
 * grammar — label first, control at the row's end); default stays leading
 * for the frame-20 rows already shipped. */
function RadioRow({
  name,
  line,
  selected,
  isLast,
  align = "leading",
  onPress,
}: {
  name: string;
  line?: React.ReactNode;
  selected: boolean;
  isLast?: boolean;
  align?: "leading" | "trailing";
  onPress: () => void;
}) {
  const ring = (
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
  );
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
      {align === "leading" ? ring : null}
      <RowText name={name} line={line} />
      {align === "trailing" ? ring : null}
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
        {/* Frame 63 leaf: labeled radio rows, ring at the row's end. Rows
            commit on tap — the full-leaf push made the choice deliberate. */}
        <div role="radiogroup" aria-label="Theme">
          {rows.map((row, i) => (
            <RadioRow
              key={row.value}
              name={row.name}
              line={row.line}
              selected={theme === row.value}
              isLast={i === rows.length - 1}
              align="trailing"
              onPress={() => pick(row.value)}
            />
          ))}
        </div>
      </SectionCard>
      <Mv3SettingsNote>
        Assistant name, timezone and software updates live in Settings → General
        on desktop.
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
  // Mirror the desktop twin (`domains/settings/ai/ai-page.tsx`). The You-screen
  // nav row is hidden on managed instances, but this route stays mounted and
  // is reachable by deep link and by back-nav, so gate the leaf itself — its
  // subtitle would otherwise read "Running on <model slug>". Per the
  // use-managed-mode flash policy, an unresolved flag renders nothing.
  const managed = useManagedMode();

  const { data: config, isLoading } = useQuery({
    ...configGetOptions({ path: { assistant_id: assistantId } }),
    staleTime: 30_000,
  });

  const activeProfile = config?.llm?.activeProfile ?? null;
  const defaultModel = config?.llm?.default?.model ?? null;
  const effort = (config?.llm?.default?.effort ?? null) as EffortOption | null;

  // The model the chat brain actually resolves to — mirror the daemon's
  // mainAgent precedence (llm-resolver.ts: default < callSites.mainAgent's
  // profile < callSites.mainAgent < activeProfile) instead of claiming
  // `llm.default.model` verbatim, which is a stale seed on most instances
  // (mobile UAT P1-14 "Running on llama3.2" while the brain was deepseek).
  // Env-level operator overrides aren't in the config document, so this is
  // the honest best the client can state.
  const effectiveModel = useMemo(() => {
    const profiles = config?.llm?.profiles ?? {};
    const activeProfileModel = activeProfile
      ? (profiles[activeProfile]?.model ?? null)
      : null;
    const mainSite = config?.llm?.callSites?.mainAgent;
    const mainSiteModel =
      mainSite?.model ??
      (mainSite?.profile ? (profiles[mainSite.profile]?.model ?? null) : null);
    return activeProfileModel ?? mainSiteModel ?? defaultModel;
  }, [config, activeProfile, defaultModel]);

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

  if (hideVendorUi(managed)) {
    return (
      <Mv3SettingsScreen
        title="AI models"
        sub={
          managed === true
            ? "Managed by Cue — nothing to set up here"
            : undefined
        }
        tint="blue"
        testId="mv3-settings-ai"
      >
        {null}
      </Mv3SettingsScreen>
    );
  }

  return (
    <Mv3SettingsScreen
      title="AI models"
      sub={
        activeProfile && effectiveModel
          ? `Running on ${effectiveModel}`
          : effectiveModel
            ? `No profile selected — using the instance default (${effectiveModel})`
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
                p.name === AUTO_PROFILE_NAME ? "Auto" : profilePickerLabel(p)
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
                  background: active ? "var(--mv3-text)" : "var(--mv3-btn2-bg)",
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
            savePreferenceToggle("share_diagnostics", next, hasPlatformSession);
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
// Schedules (settings/schedules) — list + toggle; rows open the v3 editor
// sheet (spec frame 40 — plain-language chips + time, cron as mono footnote).
// ---------------------------------------------------------------------------

const WEEKDAY_PLURALS = [
  "Sundays",
  "Mondays",
  "Tuesdays",
  "Wednesdays",
  "Thursdays",
  "Fridays",
  "Saturdays",
] as const;

/**
 * Local-timezone cadence line (UAT P2: rows used to echo the daemon's
 * cadenceDescription verbatim — "At 06:00 PM" in the DAEMON's zone, which
 * read as UTC soup). For the simple chip shapes we compute the next firing
 * instant in the daemon's zone and render its LOCAL wall time: "6:00 PM ·
 * daily". One-time rows render the local next-run; custom crons fall back
 * to the daemon description.
 */
function localCadenceLine(schedule: Schedule): string | undefined {
  if (schedule.isOneShot) {
    return schedule.nextRunAt
      ? `Once · ${formatNextRun(schedule.nextRunAt)}`
      : schedule.cadenceDescription || schedule.description || undefined;
  }
  const chips = parseCronToChips(schedule.cronExpression);
  if (chips.chip === "custom") {
    return schedule.cadenceDescription || schedule.description || undefined;
  }
  const zone = resolveCronZone({
    timezone: schedule.timezone ?? null,
    savedCron: schedule.cronExpression,
    nextRunAt: schedule.nextRunAt ?? null,
  });
  const next =
    nextRunFromChipsInZone(chips, zone) ??
    (schedule.nextRunAt ? new Date(schedule.nextRunAt) : null);
  const time = next
    ? formatTimeOfDay(next.getHours(), next.getMinutes())
    : formatTimeOfDay(chips.hour, chips.minute);
  const cadence =
    chips.chip === "daily"
      ? "daily"
      : chips.chip === "weekday"
        ? "weekdays"
        : (WEEKDAY_PLURALS[chips.weekday] ?? "weekly");
  return `${time} · ${cadence}`;
}

/**
 * Schedule row: the row body opens the editor sheet; the ON/OFF chip stays a
 * one-tap pause/resume (a real nested button, so the outer press target is a
 * div[role=button] rather than a button-in-button).
 */
function ScheduleRow({
  schedule,
  isLast,
  onOpen,
  onToggle,
}: {
  schedule: Schedule;
  isLast: boolean;
  onOpen: () => void;
  onToggle: () => void;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`Edit ${schedule.name}`}
      className="cue-pressable"
      onClick={() => {
        haptic.light();
        onOpen();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          haptic.light();
          onOpen();
        }
      }}
      style={{ ...rowShell(isLast), cursor: "pointer" }}
    >
      <RowText name={schedule.name} line={localCadenceLine(schedule)} />
      <button
        type="button"
        role="switch"
        aria-checked={schedule.enabled}
        aria-label={
          schedule.enabled
            ? `Pause ${schedule.name}`
            : `Resume ${schedule.name}`
        }
        onClick={(e) => {
          e.stopPropagation();
          haptic.light();
          onToggle();
        }}
        style={{
          background: "none",
          border: "none",
          // Small visual chip, ≥44pt hit area via padding + margin offset.
          padding: "14px 0 14px 14px",
          margin: "-14px 0",
          cursor: "pointer",
          flexShrink: 0,
        }}
      >
        <StateChip on={schedule.enabled} />
      </button>
      <span style={{ color: "var(--mv3-faint)" }} aria-hidden>
        ›
      </span>
    </div>
  );
}

export function Mv3SchedulesLeaf() {
  const assistantId = useActiveAssistantId();
  const queryClient = useQueryClient();

  const queryKey = assistantSchedulesQueryKey(assistantId);
  const {
    data: schedules,
    isLoading,
    isError,
  } = useQuery({
    queryKey,
    queryFn: () => fetchSchedules(assistantId),
    staleTime: 10_000,
  });

  // Mount-time snapshot (matches the desktop page's one-shot boundary).
  const [now] = useState(() => Date.now());

  // The v3 editor sheet (frame 40) — tracked by id so the open sheet follows
  // cache updates (optimistic toggle, post-save refetch).
  const [editingId, setEditingId] = useState<string | null>(null);

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
  const { recurring, upcomingOneTime, pastOneTime } = groupSchedules(list, now);

  const renderRows = (rows: Schedule[]) =>
    rows.map((s, i) => (
      <ScheduleRow
        key={s.id}
        schedule={s}
        isLast={i === rows.length - 1}
        onOpen={() => setEditingId(s.id)}
        onToggle={() =>
          toggleMutation.mutate({ id: s.id, enabled: !s.enabled })
        }
      />
    ));

  const editingSchedule = editingId
    ? (list.find((s) => s.id === editingId) ?? null)
    : null;

  return (
    <Mv3SettingsScreen
      title="Schedules"
      sub={
        isLoading
          ? "Reading your schedules…"
          : // "Live" counts ENABLED schedules only (UAT P2: a paused one was
            // counted as live).
            `${
              [...recurring, ...upcomingOneTime].filter((s) => s.enabled).length
            } live · tap a schedule to edit`
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
            No schedules yet — ask Cue to set one up (&ldquo;every weekday at 8,
            brief me&rdquo;) and it shows up here.
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
        Creating schedules and run history live on desktop — or ask Cue in chat
        (&ldquo;every weekday at 8, brief me&rdquo;).
      </Mv3SettingsNote>

      {editingSchedule ? (
        <Mv3ScheduleEditorSheet
          schedule={editingSchedule}
          assistantId={assistantId}
          onClose={() => setEditingId(null)}
        />
      ) : null}
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
        How long Cue waits for you to start speaking before ending a voice turn.
        Push-to-talk shortcuts and speech models (STT/TTS) are set on desktop.
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
          const eventConfig = config.events[event] ?? {
            enabled: false,
            sounds: [],
          };
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
// Integrations (settings/integrations) — the same providers/connections
// queries + detail modal the desktop page uses, in v3 row grammar.
// ---------------------------------------------------------------------------

type IntegrationFilter = "all" | "enabled" | "not-enabled";

const INTEGRATION_FILTERS: ReadonlyArray<{
  value: IntegrationFilter;
  label: string;
}> = [
  { value: "all", label: "All" },
  { value: "enabled", label: "Enabled" },
  { value: "not-enabled", label: "Not enabled" },
];

function connectionForProvider(
  connections: OAuthConnection[] | undefined,
  providerKey: string,
): OAuthConnection | null {
  return connections?.find((c) => c.provider === providerKey) ?? null;
}

export function Mv3IntegrationsLeaf() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const platformGate = usePlatformGate();

  const [assistant, setAssistant] = useState<Assistant | null>(null);
  const [assistantLoading, setAssistantLoading] = useState(true);
  // Self-host fallback: `getAssistant()` resolves from the resolved-assistants
  // LIST, which stays empty on a self-host gateway session (the lifecycle
  // short-circuit only sets the active id). The queries below need just the
  // id, so fall back to the store's active id rather than dead-ending on
  // "no assistant found".
  const storeAssistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const assistantId = assistant?.id ?? storeAssistantId;
  const [searchText, setSearchText] = useState("");
  const [filter, setFilter] = useState<IntegrationFilter>("all");
  const [selectedProviderKey, setSelectedProviderKey] = useState<string | null>(
    null,
  );
  // OAuth-callback outcome, shown inline (v3 grammar) instead of a toast.
  const [oauthNotice, setOauthNotice] = useState<{
    tone: "ok" | "error";
    text: string;
  } | null>(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const result = await getAssistant();
        if (active && result.ok) setAssistant(result.data);
      } catch (error) {
        captureError(error, { context: "integrations.getAssistant" });
      } finally {
        if (active) setAssistantLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const {
    data: providers,
    isLoading: providersLoading,
    isError: providersError,
  } = useQuery({
    ...oauthProvidersGetOptions({
      path: { assistant_id: assistantId ?? "" },
    }),
    select: (data) => data.providers,
    enabled: !!assistantId,
  });

  const { data: connections, isLoading: connectionsLoading } = useQuery({
    ...assistantsOauthConnectionsListOptions({
      path: { assistant_id: assistantId ?? "" },
    }),
    enabled: !!assistantId && platformGate === "full",
  });

  // OAuth callback query params → inline notice (same codes as desktop).
  useEffect(() => {
    const oauthStatus = searchParams.get("oauth_status");
    if (!oauthStatus) return;
    const oauthProvider = searchParams.get("oauth_provider");
    const providerLabel = oauthProvider
      ? oauthProvider.charAt(0).toUpperCase() + oauthProvider.slice(1)
      : null;
    if (oauthStatus === "connected") {
      haptic.success();
      setOauthNotice({
        tone: "ok",
        text: providerLabel
          ? `${providerLabel} account connected.`
          : "Account connected.",
      });
    } else if (oauthStatus === "error") {
      const code = searchParams.get("oauth_code") ?? "unknown";
      const messages: Record<string, string> = {
        denied: "Authorization was denied. Please try again.",
        state_invalid: "Authorization state was invalid. Please try again.",
        state_expired: "Authorization expired. Please try again.",
        exchange_failed: "Failed to complete authorization. Please try again.",
        identity_failed: "Failed to verify account identity. Please try again.",
      };
      haptic.error();
      setOauthNotice({
        tone: "error",
        text:
          messages[code] ??
          (providerLabel
            ? `Failed to connect ${providerLabel}.`
            : "Failed to connect. Please try again."),
      });
    }
    navigate(routes.settings.integrations, { replace: true });
  }, [searchParams, navigate]);

  const managedProviders = useMemo(
    () => providers?.filter((p) => p.supports_managed_mode) ?? [],
    [providers],
  );

  const filteredProviders = useMemo(() => {
    const needle = searchText.trim().toLowerCase();
    let list = managedProviders.filter((provider) => {
      if (!needle) return true;
      const name = (
        provider.display_name ?? provider.provider_key
      ).toLowerCase();
      const description = (provider.description ?? "").toLowerCase();
      return name.includes(needle) || description.includes(needle);
    });
    if (filter !== "all") {
      list = list.filter((provider) => {
        const connected = Boolean(
          connectionForProvider(connections, provider.provider_key)?.connected,
        );
        return filter === "enabled" ? connected : !connected;
      });
    }
    return [...list].sort((a, b) => {
      const aEnabled = Boolean(
        connectionForProvider(connections, a.provider_key)?.connected,
      );
      const bEnabled = Boolean(
        connectionForProvider(connections, b.provider_key)?.connected,
      );
      if (aEnabled !== bEnabled) return aEnabled ? -1 : 1;
      const aName = (a.display_name ?? a.provider_key).toLowerCase();
      const bName = (b.display_name ?? b.provider_key).toLowerCase();
      return aName.localeCompare(bName);
    });
  }, [managedProviders, connections, searchText, filter]);

  const loading =
    (assistantLoading && !assistantId) ||
    providersLoading ||
    connectionsLoading;
  const connectedCount = managedProviders.filter((p) =>
    Boolean(connectionForProvider(connections, p.provider_key)?.connected),
  ).length;

  const selectedProvider = useMemo(
    () =>
      selectedProviderKey
        ? (managedProviders.find(
            (p) => p.provider_key === selectedProviderKey,
          ) ?? null)
        : null,
    [managedProviders, selectedProviderKey],
  );

  return (
    <Mv3SettingsScreen
      title="Integrations"
      sub={
        loading
          ? "Loading your integrations…"
          : connectedCount > 0
            ? `${connectedCount} enabled · tap one to manage`
            : "Cue's native sign-ins — enable the tools it works through"
      }
      tint="blue"
      testId="mv3-settings-integrations"
    >
      {oauthNotice ? (
        <GlassCard padding="12px 14px" radius={16} style={rise(0.05)}>
          <button
            type="button"
            onClick={() => setOauthNotice(null)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 9,
              width: "100%",
              textAlign: "left",
              background: "none",
              border: "none",
              padding: 0,
              cursor: "pointer",
              fontFamily: "inherit",
            }}
          >
            <span
              aria-hidden
              style={{
                color:
                  oauthNotice.tone === "ok" ? "var(--mv3-green)" : "#E5675B",
                fontSize: 12,
              }}
            >
              {oauthNotice.tone === "ok" ? "✓" : "✕"}
            </span>
            <span style={{ fontSize: 12.5, color: "var(--mv3-text)", flex: 1 }}>
              {oauthNotice.text}
            </span>
            <span style={{ fontSize: 11, color: "var(--mv3-faint)" }}>
              dismiss
            </span>
          </button>
        </GlassCard>
      ) : null}

      <div style={rise(0.1)}>
        <input
          type="search"
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          placeholder="Search integrations"
          aria-label="Search integrations"
          style={{
            width: "100%",
            fontSize: 16,
            fontFamily: "inherit",
            color: "var(--mv3-text)",
            background: "var(--mv3-btn2-bg)",
            border: "1px solid var(--mv3-btn2-border)",
            borderRadius: 13,
            padding: "11px 14px",
            minHeight: 44,
            outline: "none",
          }}
        />
        <div
          role="radiogroup"
          aria-label="Filter integrations"
          style={{ display: "flex", gap: 7, marginTop: 9 }}
        >
          {INTEGRATION_FILTERS.map((opt) => {
            const active = filter === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => {
                  haptic.light();
                  setFilter(opt.value);
                }}
                style={{
                  fontSize: 12.5,
                  fontWeight: active ? 600 : 400,
                  fontFamily: "inherit",
                  color: active ? "var(--mv3-bg)" : "var(--mv3-muted)",
                  background: active ? "var(--mv3-text)" : "var(--mv3-btn2-bg)",
                  border: active
                    ? "1px solid transparent"
                    : "1px solid var(--mv3-btn2-border)",
                  borderRadius: 99,
                  padding: "7px 14px",
                  minHeight: 36,
                  cursor: "pointer",
                  WebkitTapHighlightColor: "transparent",
                }}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>

      {loading ? (
        <GlassCard>
          <div style={{ fontSize: 12.5, color: "var(--mv3-muted)" }}>
            Loading integrations…
          </div>
        </GlassCard>
      ) : providersError ? (
        <GlassCard>
          <div style={{ fontSize: 12.5, color: "#E5675B" }}>
            Couldn&rsquo;t load integrations — check the connection and try
            again.
          </div>
        </GlassCard>
      ) : !assistantId ? (
        <GlassCard>
          <div style={{ fontSize: 12.5, color: "var(--mv3-muted)" }}>
            No assistant found — hatch an assistant to connect integrations.
          </div>
        </GlassCard>
      ) : filteredProviders.length === 0 ? (
        <GlassCard>
          <div style={{ fontSize: 12.5, color: "var(--mv3-muted)" }}>
            {searchText.trim()
              ? `Nothing matched “${searchText.trim()}”.`
              : filter === "enabled"
                ? "No native integrations enabled yet — these are Cue's " +
                  "built-in sign-ins (Google, Slack…). Apps you connected " +
                  "in chat live in You → Connections."
                : filter === "not-enabled"
                  ? "Everything available is already enabled."
                  : "No integrations available."}
          </div>
        </GlassCard>
      ) : (
        <div style={rise(0.2)}>
          <GlassCard padding={0} radius={20} style={{ overflow: "hidden" }}>
            {filteredProviders.map((provider, i) => {
              const connected = Boolean(
                connectionForProvider(connections, provider.provider_key)
                  ?.connected,
              );
              const name = provider.display_name ?? provider.provider_key;
              return (
                <button
                  key={provider.provider_key}
                  type="button"
                  className="cue-pressable"
                  aria-label={connected ? `Manage ${name}` : `Enable ${name}`}
                  onClick={() => {
                    haptic.light();
                    setSelectedProviderKey(provider.provider_key);
                  }}
                  style={{
                    ...rowShell(i === filteredProviders.length - 1),
                    minHeight: 56,
                    cursor: "pointer",
                  }}
                >
                  <IntegrationIcon
                    providerKey={provider.provider_key}
                    displayName={name}
                    logoUrl={provider.logo_url}
                    size={30}
                  />
                  <RowText name={name} line={provider.description} />
                  {connected ? (
                    <StateChip on onText="ON" />
                  ) : (
                    <span
                      style={{
                        fontSize: 12,
                        color: "var(--mv3-micro)",
                        flexShrink: 0,
                      }}
                    >
                      Enable
                    </span>
                  )}
                  <span style={{ color: "var(--mv3-faint)" }} aria-hidden>
                    ›
                  </span>
                </button>
              );
            })}
          </GlassCard>
        </div>
      )}

      {/* Disambiguation (UAT P2): this leaf is the NATIVE integration
          sign-ins; Composio app connections are a separate store surfaced
          under You → Connections — link it so the two counts stop reading
          as a contradiction. */}
      <div style={rise(0.3)}>
        <GlassCard padding={0} radius={20} style={{ overflow: "hidden" }}>
          <button
            type="button"
            className="cue-pressable"
            onClick={() => {
              haptic.light();
              navigate(routes.connectors);
            }}
            style={{ ...rowShell(true), cursor: "pointer" }}
          >
            <RowText
              name="Connected apps"
              line="Apps linked in chat (Gmail, Slack…) live in You → Connections"
            />
            <span style={{ color: "var(--mv3-faint)" }} aria-hidden>
              ›
            </span>
          </button>
        </GlassCard>
      </div>

      <Mv3SettingsNote>
        Tip: you can also enable integrations by mentioning them in chat.
      </Mv3SettingsNote>

      {selectedProvider && assistantId ? (
        <IntegrationDetailModal
          assistantId={assistantId}
          providerKey={selectedProvider.provider_key}
          displayName={
            selectedProvider.display_name ?? selectedProvider.provider_key
          }
          description={selectedProvider.description}
          logoUrl={selectedProvider.logo_url}
          platformGate={platformGate}
          onClose={() => setSelectedProviderKey(null)}
        />
      ) : null}
    </Mv3SettingsScreen>
  );
}

// ---------------------------------------------------------------------------
// Brand (settings/brand) — saved kits as v3 rows (activate = the real
// mutation); the capture/edit studio opens on demand inside the same shell.
// ---------------------------------------------------------------------------

// Lazy: the studio (chooser → path → review) is a heavy flow the row view
// doesn't need; fetched only when the user opens it (or has no brand yet).
const BrandKitStudioLazy = lazy(() =>
  import("@/pages/brand-kit/brand-kit-page").then((m) => ({
    default: m.BrandKitStudio,
  })),
);

/** One saved brand kit as a v3 row — tap applies it everywhere. */
function BrandKitRow({
  profile,
  isLast,
  pending,
  onActivate,
}: {
  profile: BrandProfile;
  isLast: boolean;
  pending: boolean;
  onActivate: () => void;
}) {
  const applied = profile.isActive === 1;
  const swatches = [
    profile.palette?.primary,
    profile.palette?.accent,
    profile.palette?.bg,
  ].filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  return (
    <button
      type="button"
      role="radio"
      aria-checked={applied}
      aria-label={
        applied ? `${profile.name} — applied` : `Apply ${profile.name}`
      }
      disabled={pending}
      onClick={() => {
        if (applied) return;
        haptic.medium();
        onActivate();
      }}
      style={{
        ...rowShell(isLast),
        minHeight: 56,
        cursor: applied ? "default" : "pointer",
        opacity: pending ? 0.6 : 1,
      }}
    >
      <span aria-hidden style={{ display: "flex", gap: 3, flexShrink: 0 }}>
        {swatches.length > 0 ? (
          swatches.map((hex, i) => (
            <span
              key={`${hex}-${i}`}
              style={{
                width: 14,
                height: 14,
                borderRadius: 4,
                background: hex,
                border: "1px solid var(--mv3-card-border)",
              }}
            />
          ))
        ) : (
          <span
            style={{
              width: 14,
              height: 14,
              borderRadius: 4,
              background: "var(--mv3-btn2-bg)",
              border: "1px solid var(--mv3-btn2-border)",
            }}
          />
        )}
      </span>
      <RowText
        name={profile.name}
        line={
          [
            profile.fonts?.heading,
            profile.voice?.tone && profile.voice.tone.trim().length > 0
              ? profile.voice.tone
              : null,
          ]
            .filter(Boolean)
            .join(" · ") || undefined
        }
      />
      {applied ? (
        <StateChip on onText="APPLIED" />
      ) : (
        <span
          style={{ fontSize: 12, color: "var(--mv3-micro)", flexShrink: 0 }}
        >
          {pending ? "Applying…" : "Apply"}
        </span>
      )}
    </button>
  );
}

export function Mv3BrandLeaf() {
  const assistantId = useActiveAssistantId();
  const navigate = useNavigate();
  const { profiles, isLoading } = useBrandProfiles(assistantId);
  const activate = useActivateBrandProfile(assistantId);
  const [studioOpen, setStudioOpen] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);

  // No saved kit → straight into the capture flow (nothing to list); the
  // studio also opens on demand for edits/additions.
  const showStudio = studioOpen || (!isLoading && profiles.length === 0);

  return (
    <Mv3SettingsScreen
      title="Brand"
      sub={
        isLoading
          ? "Opening your brand…"
          : profiles.length > 0
            ? "Applied to every deck, doc & image Cue makes"
            : "Teach Cue your colors, fonts, logo and voice"
      }
      tint="lavender"
      testId="mv3-settings-brand"
    >
      {showStudio ? (
        <>
          {studioOpen ? (
            <div style={{ padding: "0 2px" }}>
              <button
                type="button"
                className="cue-pressable"
                onClick={() => {
                  haptic.light();
                  setStudioOpen(false);
                }}
                style={{
                  fontSize: 13,
                  color: "var(--mv3-micro)",
                  background: "none",
                  border: "none",
                  padding: "6px 0",
                  minHeight: 44,
                  cursor: "pointer",
                  fontFamily: "inherit",
                }}
              >
                ‹ Your brands
              </button>
            </div>
          ) : null}
          {/* Desktop-styled studio flow (chooser → extraction → review)
              inside the v3 push — functional on touch, full v3 adaptation
              pending. */}
          <div data-slot="mv3-brand-studio" style={{ paddingBottom: 8 }}>
            <Suspense
              fallback={
                <GlassCard>
                  <div style={{ fontSize: 12.5, color: "var(--mv3-muted)" }}>
                    Opening the brand studio…
                  </div>
                </GlassCard>
              }
            >
              <BrandKitStudioLazy compact onDone={() => setStudioOpen(false)} />
            </Suspense>
          </div>
        </>
      ) : isLoading ? (
        <GlassCard>
          <div style={{ fontSize: 12.5, color: "var(--mv3-muted)" }}>
            Loading your brand kits…
          </div>
        </GlassCard>
      ) : (
        <>
          <SectionCard eyebrow="Your brands" delay={0.1}>
            <div role="radiogroup" aria-label="Active brand">
              {profiles.map((profile, i) => (
                <BrandKitRow
                  key={profile.id}
                  profile={profile}
                  isLast={i === profiles.length - 1}
                  pending={activate.isPending && pendingId === profile.id}
                  onActivate={() => {
                    setPendingId(profile.id);
                    activate.mutate({
                      path: { assistant_id: assistantId, bid: profile.id },
                    } as never);
                  }}
                />
              ))}
            </div>
          </SectionCard>
          {activate.isError ? (
            <GlassCard>
              <div style={{ fontSize: 12.5, color: "#E5675B" }}>
                Couldn&rsquo;t apply that brand — try again.
              </div>
            </GlassCard>
          ) : null}

          <div style={rise(0.25)}>
            <GlassCard padding={0} radius={20} style={{ overflow: "hidden" }}>
              <NavRow
                icon={<span style={{ fontSize: 14 }}>✳</span>}
                iconBg="color-mix(in srgb, var(--mv3-accent) 14%, transparent)"
                label="View brand kit"
                meta="preview"
                onPress={() => navigate(routes.brandKit)}
              />
              <NavRow
                icon={<span style={{ fontSize: 14 }}>＋</span>}
                iconBg="color-mix(in srgb, var(--mv3-violet-fill, #7F77DD) 16%, transparent)"
                label="Add or edit a brand"
                isLast
                onPress={() => setStudioOpen(true)}
              />
            </GlassCard>
          </div>
          <Mv3SettingsNote>
            Applying a brand restyles every future deck, doc, dashboard and
            image.
          </Mv3SettingsNote>
        </>
      )}
    </Mv3SettingsScreen>
  );
}

// ---------------------------------------------------------------------------
// Archive (settings/archive) — archived conversations, one-tap unarchive
// (the same daemon route + cache invalidation the desktop page uses).
// ---------------------------------------------------------------------------

function archiveMeta(conversation: Conversation): string | undefined {
  const ts = conversation.createdAt;
  const date =
    ts != null && !Number.isNaN(new Date(ts).getTime())
      ? new Date(ts).toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          year: "numeric",
        })
      : null;
  const source = conversation.source ?? "vellum-assistant";
  return [date, source].filter(Boolean).join(" · ") || undefined;
}

export function Mv3ArchiveLeaf() {
  const queryClient = useQueryClient();
  const assistantId = useActiveAssistantId();

  const {
    conversations: archived,
    isLoading,
    isError,
    refetch,
  } = useArchivedConversationListQuery(assistantId);

  const [pendingId, setPendingId] = useState<string | null>(null);
  const [unarchiveError, setUnarchiveError] = useState(false);

  const handleUnarchive = useCallback(
    async (conversationId: string) => {
      setPendingId(conversationId);
      setUnarchiveError(false);
      try {
        await conversationsByIdUnarchivePost({
          path: { assistant_id: assistantId, id: conversationId },
          throwOnError: true,
        });
        haptic.success();
        // Unarchiving moves a row back into the active sidebar list, so
        // invalidate all conversation caches (same as desktop).
        void invalidateConversationQueries(queryClient, assistantId);
      } catch (error) {
        haptic.error();
        captureError(error, {
          context: "archive_settings_unarchive_conversation",
        });
        setUnarchiveError(true);
      } finally {
        setPendingId(null);
      }
    },
    [assistantId, queryClient],
  );

  return (
    <Mv3SettingsScreen
      title="Archive"
      sub={
        isLoading
          ? "Reading the archive…"
          : archived.length > 0
            ? `${archived.length} archived conversation${
                archived.length === 1 ? "" : "s"
              }`
            : "Conversations you archive land here"
      }
      tint="teal"
      testId="mv3-settings-archive"
    >
      {isError ? (
        <GlassCard>
          <div
            style={{
              fontSize: 12.5,
              color: "#E5675B",
              display: "flex",
              alignItems: "center",
              gap: 10,
            }}
          >
            <span style={{ flex: 1 }}>
              Couldn&rsquo;t load archived conversations.
            </span>
            <button
              type="button"
              onClick={() => {
                haptic.light();
                refetch();
              }}
              style={{
                fontSize: 12,
                color: "var(--mv3-micro)",
                background: "none",
                border: "none",
                padding: "6px 0",
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              Retry
            </button>
          </div>
        </GlassCard>
      ) : isLoading ? (
        <GlassCard>
          <div style={{ fontSize: 12.5, color: "var(--mv3-muted)" }}>
            Loading archived conversations…
          </div>
        </GlassCard>
      ) : archived.length === 0 ? (
        <GlassCard>
          <div
            style={{
              fontSize: 12.5,
              color: "var(--mv3-muted)",
              lineHeight: 1.5,
            }}
          >
            No archived conversations — archive a chat from its ⋯ menu and it
            shows up here.
          </div>
        </GlassCard>
      ) : (
        <div style={rise(0.1)}>
          <GlassCard padding={0} radius={20} style={{ overflow: "hidden" }}>
            {archived.map((conversation, i) => {
              const title =
                conversation.title && conversation.title.trim().length > 0
                  ? conversation.title
                  : "Untitled conversation";
              const pending = pendingId === conversation.conversationId;
              return (
                <div
                  key={conversation.conversationId}
                  style={rowShell(i === archived.length - 1)}
                >
                  <RowText name={title} line={archiveMeta(conversation)} />
                  <button
                    type="button"
                    disabled={pending}
                    aria-label={`Unarchive ${title}`}
                    onClick={() => {
                      haptic.light();
                      void handleUnarchive(conversation.conversationId);
                    }}
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      color: "var(--mv3-micro)",
                      background: "none",
                      border: "none",
                      // Small label, ≥44pt hit area via padding offsets.
                      padding: "14px 0 14px 14px",
                      margin: "-14px 0",
                      cursor: pending ? "default" : "pointer",
                      fontFamily: "inherit",
                      flexShrink: 0,
                      opacity: pending ? 0.6 : 1,
                    }}
                  >
                    {pending ? "Unarchiving…" : "Unarchive"}
                  </button>
                </div>
              );
            })}
          </GlassCard>
        </div>
      )}
      {unarchiveError ? (
        <GlassCard>
          <div style={{ fontSize: 12.5, color: "#E5675B" }}>
            Couldn&rsquo;t unarchive that conversation — try again.
          </div>
        </GlassCard>
      ) : null}
      <Mv3SettingsNote>
        Unarchiving returns a conversation to your chat list on every device.
      </Mv3SettingsNote>
    </Mv3SettingsScreen>
  );
}

// ---------------------------------------------------------------------------
// Notifications (settings/notifications) — frame 62.
//
// Platform-hosted sessions get the real organization-notifications page
// (lazy, inside the v3 shell). Self-host/cloud daemons that expose the
// device-push preference config (`notifications.push`, daemon ≥ the
// device-push wave) get the four category toggles + quiet hours wired to
// real config PATCH. Older daemons keep the honest degrade: no faked
// toggles — Cue reaches you through connected channels.
// ---------------------------------------------------------------------------

const NotificationsPageLazy = lazy(() =>
  import("@/domains/settings/pages/notifications-page").then((m) => ({
    default: m.NotificationsPage,
  })),
);

/** Local mirror of the daemon's `notifications.push` config (the generated
 * SDK types predate the schema — read/patch go through a cast). */
interface PushPrefs {
  categories: {
    needsYou: boolean;
    reviewReady: boolean;
    morningBrief: boolean;
    mentions: boolean;
  };
  quietHours: {
    start: string | null;
    end: string | null;
    timezone: string | null;
  };
}

type PushCategoryKey = keyof PushPrefs["categories"];

const PUSH_CATEGORY_ROWS: Array<{
  key: PushCategoryKey;
  name: string;
  line: string;
}> = [
  {
    key: "needsYou",
    name: "Needs you",
    line: "Approvals waiting on your decision",
  },
  {
    key: "reviewReady",
    name: "Review ready",
    line: "Background work finished, ready for review",
  },
  {
    key: "morningBrief",
    name: "Morning brief",
    line: "The daily overnight summary",
  },
  {
    key: "mentions",
    name: "Mentions",
    line: "Channel mentions — nothing sends these yet",
  },
];

function readPushPrefs(config: unknown): PushPrefs | null {
  const push = (
    config as { notifications?: { push?: Partial<PushPrefs> } } | undefined
  )?.notifications?.push;
  if (!push || typeof push !== "object" || !push.categories) return null;
  return {
    categories: {
      needsYou: push.categories.needsYou !== false,
      reviewReady: push.categories.reviewReady !== false,
      morningBrief: push.categories.morningBrief !== false,
      mentions: push.categories.mentions !== false,
    },
    quietHours: {
      start: push.quietHours?.start ?? null,
      end: push.quietHours?.end ?? null,
      timezone: push.quietHours?.timezone ?? null,
    },
  };
}

export function Mv3NotificationsLeaf() {
  const navigate = useNavigate();
  const platformNotifications =
    useClientFeatureFlagStore.use.platformNotifications();
  const platformGate = usePlatformGate({ platformHostedOnly: true });

  const assistantId = useActiveAssistantId();
  const queryClient = useQueryClient();
  const { data: config, isLoading } = useQuery({
    ...configGetOptions({ path: { assistant_id: assistantId } }),
    staleTime: 30_000,
  });
  const pushPrefs = readPushPrefs(config);

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

  const patchPush = (push: {
    categories?: Partial<PushPrefs["categories"]>;
    quietHours?: Partial<PushPrefs["quietHours"]>;
  }) => {
    if (configMutation.isPending) return;
    configMutation.mutate({
      path: { assistant_id: assistantId },
      // The generated body type predates notifications.push; the daemon's
      // config PATCH deep-merges and schema-validates server-side.
      body: { notifications: { push } } as unknown as Record<string, never>,
    });
  };

  const quietOn = Boolean(
    pushPrefs?.quietHours.start && pushPrefs?.quietHours.end,
  );

  if (platformNotifications && platformGate !== "gated") {
    return (
      <Mv3SettingsScreen
        title="Notifications"
        tint="lavender"
        testId="mv3-settings-notifications"
      >
        {/* Desktop-styled platform notifications panel inside the v3 push. */}
        <div data-slot="mv3-settings-desktop-leaf" style={{ paddingBottom: 8 }}>
          <Suspense
            fallback={
              <GlassCard>
                <div style={{ fontSize: 12.5, color: "var(--mv3-muted)" }}>
                  Loading notifications…
                </div>
              </GlassCard>
            }
          >
            <NotificationsPageLazy />
          </Suspense>
        </div>
      </Mv3SettingsScreen>
    );
  }

  if (pushPrefs) {
    const deviceTimezone = (() => {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone ?? null;
      } catch {
        return null;
      }
    })();

    return (
      <Mv3SettingsScreen
        title="Notifications"
        sub="What pages your phone"
        tint="lavender"
        testId="mv3-settings-notifications"
      >
        <SectionCard eyebrow="Push notifications" delay={0.1}>
          {PUSH_CATEGORY_ROWS.map((row, i) => (
            <ToggleRow
              key={row.key}
              name={row.name}
              line={row.line}
              on={pushPrefs.categories[row.key]}
              disabled={configMutation.isPending}
              isLast={i === PUSH_CATEGORY_ROWS.length - 1}
              onToggle={() =>
                patchPush({
                  categories: { [row.key]: !pushPrefs.categories[row.key] },
                })
              }
            />
          ))}
        </SectionCard>
        <SectionCard eyebrow="Quiet hours" delay={0.16}>
          <ToggleRow
            name="Quiet hours"
            line={
              quietOn
                ? `Pushes pause ${pushPrefs.quietHours.start} – ${pushPrefs.quietHours.end}`
                : "Pause pushes overnight"
            }
            on={quietOn}
            disabled={configMutation.isPending}
            isLast={!quietOn}
            onToggle={() =>
              patchPush({
                quietHours: quietOn
                  ? { start: null, end: null }
                  : { start: "22:00", end: "08:00", timezone: deviceTimezone },
              })
            }
          />
          {quietOn ? (
            <div style={{ ...rowShell(true) }}>
              <RowText name="Window" />
              <input
                type="time"
                aria-label="Quiet hours start"
                value={pushPrefs.quietHours.start ?? "22:00"}
                disabled={configMutation.isPending}
                onChange={(e) => {
                  if (e.target.value) {
                    patchPush({ quietHours: { start: e.target.value } });
                  }
                }}
                style={quietTimeInputStyle}
              />
              <span
                style={{ color: "var(--mv3-faint)", fontSize: 12 }}
                aria-hidden
              >
                –
              </span>
              <input
                type="time"
                aria-label="Quiet hours end"
                value={pushPrefs.quietHours.end ?? "08:00"}
                disabled={configMutation.isPending}
                onChange={(e) => {
                  if (e.target.value) {
                    patchPush({ quietHours: { end: e.target.value } });
                  }
                }}
                style={quietTimeInputStyle}
              />
            </div>
          ) : null}
        </SectionCard>
        <SectionCard eyebrow="Also reaches you" delay={0.22}>
          <button
            type="button"
            className="cue-pressable"
            onClick={() => {
              haptic.light();
              navigate(routes.contacts.root);
            }}
            style={{ ...rowShell(true), cursor: "pointer" }}
          >
            <RowText
              name="Connected channels"
              line="Telegram · WhatsApp · email — instant, where you already are"
            />
            <span style={{ color: "var(--mv3-faint)" }} aria-hidden>
              ›
            </span>
          </button>
        </SectionCard>
        <Mv3SettingsNote>
          Pushes land on phones with the Cue app installed. During quiet hours
          nothing pages your phone — approvals and review items still wait for
          you in-app.
        </Mv3SettingsNote>
      </Mv3SettingsScreen>
    );
  }

  return (
    <Mv3SettingsScreen
      title="Notifications"
      sub="How Cue reaches you"
      tint="lavender"
      testId="mv3-settings-notifications"
    >
      <SectionCard eyebrow="How Cue reaches you" delay={0.1}>
        <button
          type="button"
          className="cue-pressable"
          onClick={() => {
            haptic.light();
            navigate(routes.contacts.root);
          }}
          style={{ ...rowShell(false), cursor: "pointer" }}
        >
          <RowText
            name="Connected channels"
            line="Telegram · WhatsApp · email — instant, where you already are"
          />
          <span style={{ color: "var(--mv3-faint)" }} aria-hidden>
            ›
          </span>
        </button>
        <button
          type="button"
          className="cue-pressable"
          onClick={() => {
            haptic.light();
            navigate(routes.home);
          }}
          style={{ ...rowShell(true), cursor: "pointer" }}
        >
          <RowText
            name="In-app"
            line="Approvals and review items surface on Today"
          />
          <span style={{ color: "var(--mv3-faint)" }} aria-hidden>
            ›
          </span>
        </button>
      </SectionCard>
      <Mv3SettingsNote>
        {isLoading
          ? "Checking this instance's push support…"
          : "This instance doesn't send device push notifications yet, so there are no notification toggles to set here — anything urgent arrives through your connected channels."}
      </Mv3SettingsNote>
    </Mv3SettingsScreen>
  );
}

const quietTimeInputStyle: React.CSSProperties = {
  fontFamily: "inherit",
  fontSize: 12.5,
  color: "var(--mv3-text)",
  background: "color-mix(in srgb, var(--mv3-text) 6%, transparent)",
  border: "1px solid var(--mv3-line)",
  borderRadius: 8,
  padding: "5px 7px",
  colorScheme: "dark light",
  flexShrink: 0,
};

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
  [routes.settings.integrations]: Mv3IntegrationsLeaf,
  [routes.settings.brand]: Mv3BrandLeaf,
  [routes.settings.archive]: Mv3ArchiveLeaf,
  [routes.settings.notifications]: Mv3NotificationsLeaf,
};
