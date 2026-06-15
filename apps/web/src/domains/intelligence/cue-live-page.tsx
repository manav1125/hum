import {
  Check,
  Eye,
  Keyboard,
  Lightbulb,
  Lock,
  Mic,
  MousePointer2,
  ShieldCheck,
  Sparkles,
  Volume2,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import type {
  CueLiveStatus,
  CueLiveVoiceKeyField,
  CueLiveVoiceKeysStatus,
} from "@vellumai/ipc-contract";

import {
  getCueLiveStatus,
  getVoiceKeysStatus,
  isCueLiveAvailable,
  setCueLiveEnabled,
  setVoiceKey,
  summonCueLive,
} from "@/runtime/cue-live";

/** Split a hotkey accelerator ("Control+Option+Space") into keycaps. */
const KEYCAP_LABELS: Record<string, string> = {
  Control: "⌃",
  Ctrl: "⌃",
  Option: "⌥",
  Alt: "⌥",
  Command: "⌘",
  Cmd: "⌘",
  Shift: "⇧",
  Space: "Space",
};

function Keycaps({ hotkey }: { hotkey: string }) {
  const parts = hotkey.split("+");
  return (
    <span className="inline-flex items-center gap-1">
      {parts.map((part, i) => (
        <kbd
          key={`${part}-${i}`}
          className="inline-flex h-7 min-w-7 items-center justify-center rounded-md border border-border bg-muted px-2 font-sans text-sm font-medium text-foreground shadow-sm"
        >
          {KEYCAP_LABELS[part] ?? part}
        </kbd>
      ))}
    </span>
  );
}

interface FlowStep {
  readonly icon: typeof Keyboard;
  readonly title: string;
  readonly body: string;
}

const FLOW: readonly FlowStep[] = [
  {
    icon: Keyboard,
    title: "Ask",
    body: "Hold ⌃⌥ and speak your question, over any app on your Mac.",
  },
  {
    icon: Eye,
    title: "See",
    body: "Cue takes a screenshot and sends it, with your question, to your assistant.",
  },
  {
    icon: Lightbulb,
    title: "Reason",
    body: "Your local Claude looks at the screen and works out the answer and what to point at.",
  },
  {
    icon: Sparkles,
    title: "Point & speak",
    body: "The cursor flies to each thing it mentions and Cue answers out loud.",
  },
];

function FlowDiagram() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {FLOW.map((step, i) => {
        const Icon = step.icon;
        return (
          <div
            key={step.title}
            className="relative flex flex-col gap-2 rounded-xl border border-border bg-background p-4"
          >
            <div className="flex items-center gap-2">
              <span className="flex size-9 items-center justify-center rounded-lg bg-sky-500/10 text-sky-500">
                <Icon className="size-5" />
              </span>
              <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Step {i + 1}
              </span>
            </div>
            <h3 className="text-sm font-semibold text-foreground">
              {step.title}
            </h3>
            <p className="text-sm leading-snug text-muted-foreground">
              {step.body}
            </p>
          </div>
        );
      })}
    </div>
  );
}

/** A faithful mock of the native guide card the overlay draws. */
function GuideCardPreview() {
  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-border bg-muted/40 p-6">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        What you'll see on screen
      </span>
      <div className="relative">
        {/* The highlighted element */}
        <div className="rounded-lg border-2 border-sky-500 bg-sky-500/5 px-5 py-2.5 text-sm font-medium text-foreground">
          Send
        </div>
        {/* The Cue guide card, anchored below-right */}
        <div className="absolute left-6 top-full mt-2 w-56 rounded-lg border border-border bg-background p-3 shadow-lg">
          <div className="flex items-center gap-1.5 text-sky-500">
            <Sparkles className="size-3.5" />
            <span className="text-xs font-semibold">Cue</span>
          </div>
          <p className="mt-1 text-sm text-foreground">
            Click Send to send your message
          </p>
        </div>
      </div>
      <div className="h-20" aria-hidden />
    </div>
  );
}

function StatusPill({ ok, label }: { ok: boolean; label: string }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium"
      style={{
        color: ok
          ? "var(--system-positive-strong)"
          : "var(--system-mid-strong)",
        backgroundColor: ok
          ? "color-mix(in oklab, var(--system-positive-strong) 12%, transparent)"
          : "color-mix(in oklab, var(--system-mid-strong) 14%, transparent)",
      }}
    >
      <span
        className="size-1.5 rounded-full"
        style={{
          backgroundColor: ok
            ? "var(--system-positive-strong)"
            : "var(--system-mid-strong)",
        }}
      />
      {label}
    </span>
  );
}

function Toggle({
  on,
  busy,
  onChange,
}: {
  on: boolean;
  busy: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={busy}
      onClick={() => onChange(!on)}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
        on ? "bg-sky-500" : "bg-muted-foreground/30"
      }`}
    >
      <span
        className={`inline-block size-5 transform rounded-full bg-white shadow transition-transform ${
          on ? "translate-x-[22px]" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

function LiveControls() {
  const [status, setStatus] = useState<CueLiveStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [summonNote, setSummonNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setStatus(await getCueLiveStatus());
  }, []);

  useEffect(() => {
    void refresh();
    // Re-poll while mounted so the Accessibility pill reflects a grant the
    // user just made in System Settings without needing a navigation.
    const id = setInterval(() => void refresh(), 3000);
    return () => clearInterval(id);
  }, [refresh]);

  const handleToggle = async (next: boolean) => {
    setBusy(true);
    const updated = await setCueLiveEnabled(next);
    if (updated) setStatus(updated);
    setBusy(false);
  };

  const handleSummon = async () => {
    setSummonNote(null);
    await summonCueLive();
    setSummonNote(
      "Summoned — move your cursor over a button or field and look for the Cue card.",
    );
  };

  if (!status) return null;

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-border bg-background p-5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="text-sm font-semibold text-foreground">Cue Live</h3>
          <p className="text-sm text-muted-foreground">
            {status.enabled
              ? "Running — summon it anywhere with the hotkey."
              : "Turned off."}
          </p>
        </div>
        <Toggle on={status.enabled} busy={busy} onChange={handleToggle} />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <StatusPill
          ok={status.accessibilityTrusted}
          label={
            status.accessibilityTrusted
              ? "Accessibility granted"
              : "Needs Accessibility permission"
          }
        />
        <span className="inline-flex items-center gap-2 rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground">
          Summon
          <Keycaps hotkey={status.hotkey} />
        </span>
      </div>

      {status.enabled && !status.accessibilityTrusted && (
        <p
          className="rounded-lg px-3 py-2 text-xs leading-relaxed"
          style={{
            color: "var(--system-mid-strong)",
            backgroundColor:
              "color-mix(in oklab, var(--system-mid-strong) 12%, transparent)",
          }}
        >
          To arm the summon hotkey, enable <strong>Cue</strong> under System
          Settings → Privacy &amp; Security → Accessibility. Until then, use the
          “Try it” button below or the tray’s “Summon Cue Live”.
        </p>
      )}

      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={!status.enabled}
          onClick={handleSummon}
          className="inline-flex items-center gap-1.5 rounded-lg bg-sky-500 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-sky-600 disabled:opacity-50"
        >
          <Zap className="size-4" />
          Try it now
        </button>
        {summonNote && (
          <span className="text-xs text-muted-foreground">{summonNote}</span>
        )}
      </div>
    </div>
  );
}

function UnavailableNotice() {
  return (
    <div className="flex items-center gap-3 rounded-xl border border-border bg-muted/40 p-5">
      <MousePointer2 className="size-5 text-muted-foreground" />
      <p className="text-sm text-muted-foreground">
        Cue Live is a macOS desktop feature. Open Cue on your Mac to turn it on
        and summon it over any app.
      </p>
    </div>
  );
}

const PRIVACY_POINTS: readonly { icon: typeof Lock; text: string }[] = [
  {
    icon: Eye,
    text: "When you ask, Cue takes one screenshot of your screen and sends it — with your question — to your configured model (Claude) to answer.",
  },
  {
    icon: Lock,
    text: "It only captures on a summon, never continuously. Your voice goes to AssemblyAI for transcription and replies are voiced by ElevenLabs, using the keys you provide.",
  },
  {
    icon: ShieldCheck,
    text: "Keys are stored encrypted in your macOS Keychain and handed only to the local helper — never shown back in the app. Cue Live guides and points; it doesn't click or type for you.",
  },
];

function SecretKeyField({
  field,
  icon: Icon,
  label,
  help,
  link,
  configured,
  onSaved,
}: {
  field: CueLiveVoiceKeyField;
  icon: typeof Mic;
  label: string;
  help: string;
  link: string;
  configured: boolean;
  onSaved: (status: CueLiveVoiceKeysStatus | null) => void;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  const save = async (next: string | null) => {
    setBusy(true);
    onSaved(await setVoiceKey(field, next));
    setValue("");
    setBusy(false);
  };

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-border bg-background p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Icon className="size-4 text-sky-500" />
          <span className="text-sm font-semibold text-foreground">{label}</span>
        </div>
        {configured && (
          <span className="inline-flex items-center gap-1 text-xs font-medium text-sky-500">
            <Check className="size-3.5" /> Saved
          </span>
        )}
      </div>
      <p className="text-xs leading-snug text-muted-foreground">
        {help}{" "}
        <a
          href={link}
          target="_blank"
          rel="noreferrer"
          className="text-sky-500 underline"
        >
          Get a key
        </a>
      </p>
      <div className="flex items-center gap-2">
        <input
          type="password"
          value={value}
          disabled={busy}
          placeholder={configured ? "•••••••• (saved)" : "Paste API key"}
          onChange={(e) => setValue(e.target.value)}
          className="min-w-0 flex-1 rounded-lg border border-border bg-muted/40 px-3 py-1.5 text-sm text-foreground outline-none focus:border-sky-500"
        />
        <button
          type="button"
          disabled={busy || !value.trim()}
          onClick={() => void save(value)}
          className="rounded-lg bg-sky-500 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-sky-600 disabled:opacity-50"
        >
          Save
        </button>
        {configured && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void save(null)}
            className="rounded-lg border border-border px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
}

function VoiceKeysSection() {
  const [status, setStatus] = useState<CueLiveVoiceKeysStatus | null>(null);
  const [voiceId, setVoiceId] = useState("");
  const [savingVoiceId, setSavingVoiceId] = useState(false);

  useEffect(() => {
    void (async () => {
      const s = await getVoiceKeysStatus();
      setStatus(s);
      setVoiceId(s?.elevenLabsVoiceId ?? "");
    })();
  }, []);

  // Voice keys IPC absent (older preload) — hide the section entirely.
  if (status === null) return null;

  const saveVoiceId = async () => {
    setSavingVoiceId(true);
    setStatus(await setVoiceKey("elevenLabsVoiceId", voiceId || null));
    setSavingVoiceId(false);
  };

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-foreground">Voice setup</h2>
        <p className="text-sm text-muted-foreground">
          Cue Live talks with you using your own API keys. Paste them once —
          they're stored encrypted in your Keychain. Until they're set, summon
          still works silently (it shows the answer as a card).
        </p>
      </div>
      <SecretKeyField
        field="assemblyAi"
        icon={Mic}
        label="AssemblyAI — speech to text"
        help="Lets you hold ⌃⌥ and ask out loud."
        link="https://www.assemblyai.com/dashboard/api-keys"
        configured={status.hasAssemblyAi}
        onSaved={setStatus}
      />
      <SecretKeyField
        field="elevenLabs"
        icon={Volume2}
        label="ElevenLabs — text to speech"
        help="Lets Cue answer back in a natural voice."
        link="https://elevenlabs.io/app/settings/api-keys"
        configured={status.hasElevenLabs}
        onSaved={setStatus}
      />
      <div className="flex flex-col gap-2 rounded-xl border border-border bg-background p-4">
        <span className="text-sm font-semibold text-foreground">
          ElevenLabs voice (optional)
        </span>
        <p className="text-xs leading-snug text-muted-foreground">
          A voice ID from your ElevenLabs voice library. Leave blank for the
          default voice.
        </p>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={voiceId}
            disabled={savingVoiceId}
            placeholder="e.g. 21m00Tcm4TlvDq8ikWAM"
            onChange={(e) => setVoiceId(e.target.value)}
            className="min-w-0 flex-1 rounded-lg border border-border bg-muted/40 px-3 py-1.5 text-sm text-foreground outline-none focus:border-sky-500"
          />
          <button
            type="button"
            disabled={savingVoiceId}
            onClick={() => void saveVoiceId()}
            className="rounded-lg bg-sky-500 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-sky-600 disabled:opacity-50"
          >
            Save
          </button>
        </div>
      </div>
    </section>
  );
}

export function CueLivePage() {
  const available = isCueLiveAvailable();

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 py-8">
      {/* Hero */}
      <header className="flex flex-col gap-3">
        <span className="inline-flex w-fit items-center gap-1.5 rounded-full bg-sky-500/10 px-2.5 py-1 text-xs font-semibold text-sky-500">
          <Sparkles className="size-3.5" />
          Cue Live
        </span>
        <h1 className="text-2xl font-semibold text-foreground">
          An AI teacher that lives next to your cursor
        </h1>
        <p className="text-base leading-relaxed text-muted-foreground">
          Hold ⌃⌥ and ask out loud — Cue looks at your screen, answers in your
          ear, and flies the cursor to whatever it's talking about. A guide that
          points, not a take-over.
        </p>
      </header>

      {/* Live controls (desktop) or notice */}
      {available ? <LiveControls /> : <UnavailableNotice />}

      {/* Voice keys */}
      {available && <VoiceKeysSection />}

      {/* How it works */}
      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold text-foreground">How it works</h2>
        <FlowDiagram />
      </section>

      {/* On-screen preview */}
      <section className="flex flex-col gap-4">
        <GuideCardPreview />
      </section>

      {/* Privacy */}
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold text-foreground">
          What Cue can and can't see
        </h2>
        <ul className="flex flex-col gap-2">
          {PRIVACY_POINTS.map(({ icon: Icon, text }) => (
            <li
              key={text}
              className="flex items-start gap-3 rounded-lg border border-border bg-background p-3"
            >
              <Icon className="mt-0.5 size-4 shrink-0 text-sky-500" />
              <span className="text-sm leading-snug text-muted-foreground">
                {text}
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
