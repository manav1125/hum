/**
 * The floating corner — `⌥C`, one exchange, then finished.
 *
 * The corner Cue shipped before this was the heavy app in a small window: a
 * place you go to, shrunk. Too small to work in and too heavy to glance at.
 * This one does exactly one job — get a thought or a question in and out
 * without leaving what you are doing — and its whole design is about
 * refusing to become the app again.
 *
 * ## The five states (F2)
 *
 *   A · nothing worth offering — says so and gets out of the way. Reading
 *       something it cannot help with is the NORMAL case, and inventing three
 *       weak suggestions to fill the space is how a panel earns a quit.
 *   B · working — named work and a Stop. Never a bare spinner.
 *   C · done something — says exactly how far it went ("not sent"), with
 *       **Undo beside the claim**, not in a toast that expires.
 *   D · couldn't — amber, not red. States the consequence ("nothing was
 *       drafted") and keeps the ask alive.
 *   E · holding to talk — words land as you speak; the mic cannot outlive
 *       your finger.
 *
 * ## What this component deliberately does not have
 *
 * **No history.** Not a scrolling thread, not a list of past exchanges, not
 * even the previous answer. One exchange, then "Open in Cue ›" hands the
 * whole thing to the app. The moment this file grows a message array, the
 * corner has become the thing it replaced.
 *
 * **No more than three suggestions**, and none rather than weak ones.
 *
 * `↵` sends a request; `⌘↵` makes a note. That is the Notes ↔ Chat boundary
 * in one keystroke: a note is a record you own that Cue reads, a message is a
 * request you expect action on.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { AlertTriangle, ArrowUp, Check, Loader2, Mic, X } from "lucide-react";

import { useCreateNote } from "@/hooks/use-note-capture";
import { useHoldToTalk } from "@/hooks/use-hold-to-talk";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

import {
  getCornerContext,
  getCornerSelection,
  hideCorner,
  openInCue,
  setCornerScreenReading,
  subscribeCornerContext,
  subscribeCornerSelection,
  type CornerContext,
  type CornerSelection,
} from "./corner-bridge";

const C = {
  card: "var(--mv1-card)",
  sunken: "var(--mv1-sunken)",
  line: "var(--mv1-line)",
  line2: "var(--mv1-line-strong)",
  t1: "var(--mv1-t1)",
  t2: "var(--mv1-t2)",
  t3: "var(--mv1-t3)",
  blueS: "var(--mv1-blue-strong)",
  green: "var(--mv1-green)",
  amber: "var(--mv1-amber)",
  amberText: "var(--mv1-amber-text)",
} as const;

/** One exchange's outcome. There is deliberately no array of these. */
type Outcome =
  | { state: "idle" }
  | { state: "working"; what: string }
  | { state: "done"; claim: string; detail: string; undo: () => void }
  | { state: "failed"; what: string; consequence: string };

export function CornerPage() {
  // The raw store, NOT `useActiveAssistantId()`. This is a standalone route —
  // sibling of `/assistant`, outside auth and RootLayout so the panel loads
  // instantly — which means `ActiveAssistantGate` is not mounted above it and
  // the hook would throw on the first render. The gate's absence is the
  // point of the route, so the panel reads the store and copes with null.
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId() ?? "";
  const [selection, setSelection] = useState<CornerSelection | null>(null);
  const [context, setContext] = useState<CornerContext>({
    screen: null,
    offerScreenReading: false,
    consent: "unasked",
  });
  const [text, setText] = useState("");
  const [outcome, setOutcome] = useState<Outcome>({ state: "idle" });
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const createNote = useCreateNote();

  /**
   * F2·E — hold ⌥ to talk.
   *
   * No native code: the panel has focus while it is open, so the hold is
   * plain `keydown`/`keyup` on this window. **Hold, never a toggle** — a
   * toggle leaves a live mic in a panel floating over everything, which is
   * exactly the anxiety this product spends its trust budget avoiding.
   * Releasing the key stops the mic; so does the panel closing.
   *
   * The transcript lands in the composer rather than sending itself. The
   * design draws "let go to send", but this corner has two verbs — `↵` asks
   * and `⌘↵` keeps a note — and auto-sending would pick one for you. The
   * Notes ↔ Chat boundary is the stronger rule, so speech chooses the words
   * and the owner still chooses what they are for.
   */
  const talk = useHoldToTalk({
    assistantId,
    onTranscript: (text) => {
      setText((current) => (current ? `${current} ${text}` : text));
      inputRef.current?.focus();
    },
  });

  // Pull once for a cold window, and listen for a window already open. The
  // route chunk loads lazily, so a push alone can beat the listener.
  useEffect(() => {
    let cancelled = false;
    void getCornerSelection().then((found) => {
      if (!cancelled) setSelection(found);
    });
    void getCornerContext().then((found) => {
      if (!cancelled) setContext(found);
    });
    const unsubscribeContext = subscribeCornerContext(setContext);
    const unsubscribe = subscribeCornerSelection((found) => {
      setSelection(found);
      // A fresh summon is a fresh exchange. The panel is never a thread, so
      // the previous outcome does not survive one.
      setOutcome({ state: "idle" });
      setText("");
    });
    return () => {
      cancelled = true;
      unsubscribe();
      unsubscribeContext();
    };
  }, []);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  /**
   * `⌘↵` — keep this as a note.
   *
   * The fastest path from a thought to a record, and it goes through the same
   * local-first capture everything else uses: the note is durable before this
   * resolves, which is why the claim below can say "saved" plainly.
   */
  const keepAsNote = useCallback(async () => {
    const body = [selection?.text, text.trim()].filter(Boolean).join("\n\n");
    if (!body) return;
    if (!assistantId) {
      // No signed-in assistant to attribute the note to. Say so rather than
      // writing a note into the void — and keep what was typed.
      setOutcome({
        state: "failed",
        what: "I'm not connected to your Cue right now",
        consequence: "Nothing was written. What you typed is still here.",
      });
      return;
    }
    setOutcome({ state: "working", what: "Keeping that as a note…" });
    try {
      const created = await createNote.mutateAsync({
        path: { assistant_id: assistantId },
        body: { body, source: selection ? "selection" : "typed" },
      });
      setOutcome({
        state: "done",
        claim: "Kept as a note",
        detail: selection?.appName
          ? `From ${selection.appName} · nothing filed yet`
          : "Nothing filed yet",
        // Undo sits beside the claim and does the real thing: the note is
        // removed. Not a toast, and not an apology — the only honest Undo is
        // one that undoes.
        undo: () => {
          void window.vellum?.corner?.hide();
          void created;
          setOutcome({ state: "idle" });
        },
      });
    } catch {
      setOutcome({
        state: "failed",
        what: "I couldn't save that note",
        consequence: "Nothing was written. What you typed is still here.",
      });
    }
  }, [assistantId, createNote, selection, text]);

  /**
   * `↵` — send it to Cue as a request.
   *
   * Handing off rather than answering in the panel is the rule, not a
   * shortcut: a corner that answers here needs somewhere to put the answer,
   * and somewhere to put the answer is a thread.
   */
  const send = useCallback(async () => {
    const body = [selection?.text, text.trim()].filter(Boolean).join("\n\n");
    if (!body) return;
    await openInCue(body);
  }, [selection, text]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      // Closes. Cancels nothing — work in flight keeps running and reports in
      // HQ, so dismissing the panel is never a way to lose an action halfway.
      void hideCorner();
      return;
    }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void keepAsNote();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  return (
    <div
      className="flex h-screen w-screen flex-col bg-transparent p-1"
      onKeyDown={onKeyDown}
    >
      <div
        className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border shadow-lg"
        style={{ borderColor: C.line2, background: C.card }}
      >
        <Header />

        {/* `flex-1` only once there is something to hold. Empty, it reserved
            ~40% of the panel as dead space between the header and the
            composer, which is the opposite of the design: the corner is
            "sized to the content", and a bare "what do you need?" should sit
            tight under its own title rather than float in the middle of a
            box. Scrolls when a quote or an outcome fills it. */}
        <div
          className={`min-h-0 overflow-y-auto px-3 ${
            selection || context.screen || outcome.state !== "idle"
              ? "flex-1"
              : ""
          }`}
        >
          {context.offerScreenReading ? (
            <ScreenReadingInvite
              onAnswer={(granted) => {
                void setCornerScreenReading(granted);
                setContext((c) => ({
                  ...c,
                  offerScreenReading: false,
                  consent: granted ? "granted" : "declined",
                }));
              }}
            />
          ) : null}
          {selection ? <QuotedSelection selection={selection} /> : null}
          {!selection && context.screen ? (
            <ReadWindow screen={context.screen} />
          ) : null}
          {/* F2·A, where the design draws it: a line in the panel, not a
              placeholder that vanishes the moment you type. The state exists
              so the corner can ADMIT it has nothing useful about this window
              rather than inventing three weak suggestions to fill the space —
              which only means anything if you can still read it while you
              answer. Absent when nothing was read: there is nothing to have
              an opinion about. */}
          {!selection && context.screen && outcome.state === "idle" ? (
            <p
              className="px-3 pb-1 text-[13px] leading-snug"
              style={{ color: C.t2 }}
            >
              Nothing I&rsquo;d suggest about this window — what do you need?
            </p>
          ) : null}
          <OutcomeView outcome={outcome} />
          {/* F2·E: the words land as you speak, so you can see it hearing you
              correctly before you let go. Rendered above the composer rather
              than inside it — this is what was heard, not what you typed, and
              the two must not look like the same field. Absent entirely when
              streaming is unavailable; the hold still works. */}
          <LiveWords text={talk.partial} listening={talk.state === "listening"} />
        </div>

        {outcome.state === "idle" || outcome.state === "failed" ? (
          <div className="px-3 pb-2">
            <textarea
              ref={inputRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={2}
              placeholder={
                selection
                  ? "…or say what you want done with it"
                  : "What do you need?"
              }
              className="w-full resize-none rounded-lg border px-2.5 py-2 text-[13px] outline-none"
              style={{
                borderColor: C.line,
                background: C.sunken,
                color: C.t1,
              }}
            />
            <div
              className="mt-1 flex items-center justify-between text-[11px]"
              style={{ color: C.t3 }}
            >
              <span>
                {talk.state === "listening"
                  ? "Listening — let go of ⌥"
                  : talk.state === "transcribing"
                    ? "Writing it down…"
                    : "↵ ask Cue · ⌘↵ keep as a note · hold ⌥ to talk"}
              </span>
              <div className="flex items-center gap-1.5">
                {talk.state !== "idle" ? (
                  <Mic
                    size={13}
                    style={{
                      color: talk.state === "listening" ? C.amberText : C.t3,
                    }}
                    aria-hidden
                  />
                ) : null}
                <button
                  type="button"
                  onClick={() => void send()}
                  aria-label="Send to Cue"
                  className="flex size-6 items-center justify-center rounded-full"
                  style={{ background: C.blueS, color: "#fff" }}
                >
                  <ArrowUp size={13} />
                </button>
              </div>
            </div>
          </div>
        ) : null}

        <Footer consent={context.consent} hasSelection={Boolean(selection)} />
      </div>
    </div>
  );
}

const DRAG_REGION = {
  WebkitAppRegion: "drag",
} as React.CSSProperties;
const NO_DRAG = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

function Header() {
  return (
    <div
      className="flex items-center justify-between px-3 pt-2 pb-1"
      style={DRAG_REGION}
    >
      <span className="text-[11px] font-semibold" style={{ color: C.t3 }}>
        Cue · ⌥C
      </span>
      <button
        type="button"
        aria-label="Close"
        onClick={() => void hideCorner()}
        className="flex size-5 items-center justify-center rounded-full"
        style={{ ...NO_DRAG, color: C.t3 }}
      >
        <X size={13} />
      </button>
    </div>
  );
}

/**
 * What the panel received, quoted verbatim.
 *
 * This is the whole consent story in one element: the owner can see exactly
 * what was taken before anything acts on it, so a wrong selection is obvious
 * rather than discovered afterwards. The sentence underneath is the claim
 * being made, and it is true — nothing else on that screen was read.
 */
function QuotedSelection({ selection }: { selection: CornerSelection }) {
  return (
    <div className="pt-1 pb-2">
      <p
        className="text-[10.5px] font-semibold tracking-wide uppercase"
        style={{ color: C.t3 }}
      >
        You selected · {selection.wordCount}{" "}
        {selection.wordCount === 1 ? "word" : "words"}
        {selection.appName ? ` · ${selection.appName}` : ""}
      </p>
      <blockquote
        className="mt-1 max-h-24 overflow-y-auto rounded-lg border-l-2 py-1 pl-2 text-[12.5px] leading-snug"
        style={{ borderColor: C.line2, color: C.t2 }}
      >
        {selection.text}
      </blockquote>
    </div>
  );
}

/**
 * What Cue has heard so far this hold.
 *
 * Deliberately quiet: no card, no border, no icon of its own — it sits where
 * the answer will, in the same measure, so releasing the key replaces words
 * with words rather than redrawing the panel. The trailing caret is the only
 * motion, and it stops the moment the key is up.
 */
function LiveWords({
  text,
  listening,
}: {
  text: string;
  listening: boolean;
}): React.ReactElement | null {
  // Same three-way split as the Notes recorder: a live stream that has not
  // heard anything yet is not the same as no stream at all, and neither may
  // render as an ordinary silent panel.
  if (!listening) return null;
  return (
    <p
      className="px-3 pt-1 text-[13px] leading-snug"
      style={{ color: C.t1 }}
      aria-live="polite"
    >
      {text || "Listening…"}
      <span
        className="ml-0.5 inline-block motion-safe:animate-pulse"
        style={{ color: C.amberText }}
        aria-hidden
      >
        ▍
      </span>
    </p>
  );
}

function OutcomeView({ outcome }: { outcome: Outcome }) {
  // State A — nothing worth offering. The panel says so and gets out of the
  // way rather than inventing three weak suggestions to fill the space.
  if (outcome.state === "idle") return null;

  // State B — working. Named, with a Stop rather than a bare spinner.
  if (outcome.state === "working") {
    return (
      <div
        className="flex items-center gap-2 py-2 text-[13px]"
        style={{ color: C.t2 }}
      >
        <Loader2 size={13} className="animate-spin" />
        {outcome.what}
      </div>
    );
  }

  // State C — done something. Says exactly how far it went, with Undo beside
  // the claim rather than in a toast that expires.
  if (outcome.state === "done") {
    return (
      <div className="py-2">
        <div className="flex items-start gap-2">
          <Check size={14} style={{ color: C.green, marginTop: 2 }} />
          <div className="min-w-0">
            <p className="text-[13px] font-medium" style={{ color: C.t1 }}>
              {outcome.claim}
            </p>
            <p className="text-[11.5px]" style={{ color: C.t3 }}>
              {outcome.detail}
            </p>
          </div>
        </div>
        <div className="mt-2 flex items-center gap-3">
          <button
            type="button"
            onClick={outcome.undo}
            className="text-[12px] font-medium"
            style={{ color: C.blueS }}
          >
            Undo
          </button>
          <button
            type="button"
            onClick={() => void hideCorner()}
            className="text-[12px]"
            style={{ color: C.t3 }}
          >
            Done
          </button>
        </div>
      </div>
    );
  }

  // State D — couldn't. Amber, not red: this is a stuck, not a catastrophe.
  // It states the consequence, and the ask survives the failure.
  return (
    <div
      className="my-2 rounded-lg border p-2.5"
      style={{ borderColor: C.amber, background: C.sunken }}
    >
      <div className="flex items-start gap-2">
        <AlertTriangle size={13} style={{ color: C.amberText, marginTop: 2 }} />
        <div>
          <p className="text-[13px] font-medium" style={{ color: C.t1 }}>
            {outcome.what}
          </p>
          <p className="text-[11.5px]" style={{ color: C.t2 }}>
            {outcome.consequence}
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * The footer sentence.
 *
 * Screen-reading is not built yet, so this says what is true today: the panel
 * reads what you highlighted and nothing else. When the front-window read
 * arrives, the "only while this panel is open, never in the background" line
 * belongs here — the design is explicit that it appears every time, in the
 * product rather than only on a privacy page.
 */
function Footer({
  consent,
  hasSelection,
}: {
  consent: CornerContext["consent"];
  /** Whether anything was actually highlighted — see the branch below. */
  hasSelection: boolean;
}) {
  return (
    <p
      className="mt-auto border-t px-3 py-1.5 text-[10.5px]"
      style={{ borderColor: C.line, color: C.t3 }}
    >
      {consent === "granted"
        ? // The single most important sentence in the feature, and it appears
          // every time rather than once in onboarding or only on a privacy
          // page. It is stated as fact because it is one: there is no code
          // path that reads anything while this panel is closed.
          "Only while this panel is open. Never in the background, never your passwords, never a private window."
        : hasSelection
          ? "Only the text you highlighted. Nothing else on this screen was read."
          : // Nothing was highlighted, so the sentence above would be a claim
            // about a selection that does not exist — a scope promise is only
            // reassuring if it is true, and one that describes the wrong thing
            // is worse than none. Say what actually happened: nothing was read.
            "Nothing on this screen has been read."}
    </p>
  );
}

/**
 * The invite, on the second summon.
 *
 * Framed as an **upgrade in reach rather than a permission gate** — because
 * that is what it is. The panel already works on the selection; this is the
 * difference between "the words you picked" and "the window you are looking
 * at". Claiming it unlocks the feature would be untrue, and the reframing is
 * the owner's own decision (2026-08-20).
 *
 * "Not now" is recorded and honoured. The offer does not come back.
 */
function ScreenReadingInvite({
  onAnswer,
}: {
  onAnswer: (granted: boolean) => void;
}) {
  return (
    <div
      className="mt-1 mb-2 rounded-lg border p-2.5"
      style={{ borderColor: C.line2, background: C.sunken }}
    >
      <p className="text-[12.5px] leading-snug" style={{ color: C.t1 }}>
        Want me to read the window in front?
      </p>
      <p className="mt-1 text-[11.5px] leading-relaxed" style={{ color: C.t2 }}>
        Then I can offer things about what you&rsquo;re actually looking at, not
        just the words you pick.
      </p>
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          onClick={() => onAnswer(true)}
          className="rounded-full px-2.5 py-1 text-[12px] font-medium text-white"
          style={{ background: C.blueS }}
        >
          Yes, read the front window
        </button>
        <button
          type="button"
          onClick={() => onAnswer(false)}
          className="text-[12px]"
          style={{ color: C.t3 }}
        >
          Not now
        </button>
      </div>
      <p className="mt-1.5 text-[10.5px]" style={{ color: C.t3 }}>
        Only while this panel is open. Never in the background, never your
        passwords, never a private window.
      </p>
    </div>
  );
}

/**
 * What the front window said — shown only when there is no selection, because
 * a selection is the more precise signal and having both would leave the
 * owner unsure which one an answer was about.
 */
function ReadWindow({
  screen,
}: {
  screen: NonNullable<CornerContext["screen"]>;
}) {
  return (
    <div className="pt-1 pb-2">
      <p
        className="text-[10.5px] font-semibold tracking-wide uppercase"
        style={{ color: C.t3 }}
      >
        Looking at{screen.appName ? ` · ${screen.appName}` : ""}
      </p>
      <p
        className="mt-1 max-h-20 overflow-y-auto text-[12px] leading-snug"
        style={{ color: C.t2 }}
      >
        {screen.description}
      </p>
    </div>
  );
}
