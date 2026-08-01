/**
 * Work-item PROVENANCE, in the user's words.
 *
 * The trust principle this implements (design 01 §5, §17, and the priority
 * list's "trust surfaced everywhere"): a user must always be able to ask "why
 * is this here, and what did Cue do to it?" and get an answer in one click. A
 * work item that arrived from a watcher, or that Cue auto-filed into a
 * project, has to say so — and say how sure it was, in words.
 *
 * Sibling of `work-vocabulary.ts`, and deliberately the same shape: that
 * module owns the words for a work item's STATE, this one owns the words for
 * its ORIGIN and for the judgements Cue made about it. Both exist for the same
 * reason — so a raw enum (`gmail_watcher`, `you_approved`) can never reach a
 * user, and so a new stored value cannot be added without someone deciding
 * what it is called.
 *
 * Three rules are encoded here rather than left to each surface.
 *
 * **Never assert provenance you do not have.** This is the one that matters
 * most. An item with a null `sourceType` returns `null` from `describeOrigin`
 * and its surface renders nothing — it does NOT fall back to "you added this".
 * Inventing provenance is worse than omitting it, because provenance is
 * precisely what a user checks when they already suspect something is wrong;
 * a confident wrong answer there costs more trust than a blank. The same rule
 * governs confidence: a null `autoFileConfidence` produces no confidence
 * phrase at all, never a guessed one.
 *
 * **Confidence is words, not a number.** "0.62" is the model's unit, not the
 * user's, and a percentage invites a precision the score does not have.
 *
 * **No colour-only meaning.** Every line carries a glyph, exactly as
 * `work-vocabulary.ts` does, so these read correctly in greyscale and to a
 * screen reader.
 *
 * A bare id is never rendered. `sourceId`, `originConversationId` and
 * `lastRunConversationId` are routing keys — they are used to build a link,
 * never shown as text.
 */

/**
 * The fields provenance is derived from. Declared structurally rather than as
 * one of the generated response types because three different endpoints return
 * the same work-item shape (`workitemsGet`, `projectsByIdWorkitemsGet`,
 * `workitemsByIdGet`) and every surface should be able to pass whichever it
 * holds. Everything is optional so an older daemon's narrower payload degrades
 * to "say less" rather than to a type error.
 */
export interface ProvenanceFields {
  /** Which channel the item arrived on. Null = we do not know. Say nothing. */
  sourceType?: string | null;
  /** JSON snapshot stamped at triage. Read for a sender name only. */
  sourceContext?: string | null;
  projectId?: string | null;
  /** "cue" = the auto-filer filed it; "user_unfiled" = the user pulled it out. */
  autoFiledBy?: string | null;
  /** The auto-filer's 0–1 score. Null = it did not record one. */
  autoFileConfidence?: number | null;
  ranProvenance?: "auto" | "you_approved" | "manual" | null;
  /** Routing key for "open the conversation" — never rendered as text. */
  originConversationId?: string | null;
  completedElsewhere?: boolean | null;
}

/** Tone name on the HQ palette (`C`), never a literal colour. */
export type ProvenanceTone = "blue" | "amber" | "green" | "violet" | "muted";

export interface ProvenanceLine {
  /** Stable key for lists and for tests. */
  id: "origin" | "sender" | "filing" | "run";
  /** The full sentence a user reads in the expanded panel. */
  text: string;
  /** The compact form for the inline pill. Sentence case, no trailing stop. */
  short: string;
  /** Carries the line without colour. Never omit. */
  glyph: string;
  tone: ProvenanceTone;
}

export interface ProvenanceTrace {
  origin: ProvenanceLine | null;
  sender: ProvenanceLine | null;
  filing: ProvenanceLine | null;
  run: ProvenanceLine | null;
  /** Every non-null line, in reading order. Empty = render nothing at all. */
  lines: ProvenanceLine[];
  /** Conversation to deep-link to, when the item names one. */
  originConversationId: string | null;
}

/* -------------------------------------------------------------------------- */
/* Channels                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Known channels, longest/most-specific token first — "gmail" must be tested
 * before "mail", and "voicemail" before either, or the label degrades to the
 * generic one. The glyph column matches `hq-kit`'s `sourceBadge`, so the pill
 * and the row's badge tile carry the same mark.
 */
const CHANNELS: { match: string[]; name: string; glyph: string }[] = [
  { match: ["gmail"], name: "Gmail", glyph: "✉" },
  { match: ["outlook"], name: "Outlook", glyph: "✉" },
  { match: ["slack"], name: "Slack", glyph: "#" },
  { match: ["github"], name: "GitHub", glyph: "◆" },
  { match: ["linear"], name: "Linear", glyph: "◆" },
  { match: ["notion"], name: "Notion", glyph: "◆" },
  { match: ["whatsapp"], name: "WhatsApp", glyph: "✆" },
  { match: ["telegram"], name: "Telegram", glyph: "✆" },
  { match: ["sms", "imessage"], name: "text message", glyph: "✆" },
  { match: ["calendar", "gcal"], name: "your calendar", glyph: "◱" },
  { match: ["voicemail"], name: "voicemail", glyph: "☎" },
  { match: ["meeting"], name: "a meeting", glyph: "☎" },
  { match: ["call", "voice", "transcript"], name: "a call", glyph: "☎" },
  { match: ["email", "mail"], name: "email", glyph: "✉" },
];

function channelFor(token: string): { name: string; glyph: string } | null {
  for (const c of CHANNELS) {
    if (c.match.some((m) => token.includes(m))) {
      return { name: c.name, glyph: c.glyph };
    }
  }
  return null;
}

/** `gmail_watcher` → `Gmail watcher`. Last resort — never the raw token. */
function humanise(raw: string): string {
  const words = raw.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  if (!words) return "";
  const lower = words.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

/* -------------------------------------------------------------------------- */
/* Origin                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Where this item came from, in user words.
 *
 * Returns **null** when `sourceType` is absent or blank. That is the
 * load-bearing case: the surface then renders no origin at all rather than
 * assuming the user typed it in. Do not add a fallback here.
 */
export function describeOrigin(item: ProvenanceFields): ProvenanceLine | null {
  const raw = (item.sourceType ?? "").trim();
  if (!raw) return null;
  const t = raw.toLowerCase();

  const channel = channelFor(t);

  // A watcher is a thing Cue set up and runs unattended, so it is named even
  // when the channel is known — "came in from Gmail" hides the fact that
  // nobody asked for this one.
  if (t.includes("watch")) {
    const text = channel
      ? `A watcher picked this up from ${channel.name}`
      : "A watcher picked this up";
    return {
      id: "origin",
      text,
      short: channel ? `Watcher · ${channel.name}` : "Watcher",
      glyph: "◉",
      tone: "amber",
    };
  }

  if (t.includes("schedul") || t.includes("cron") || t.includes("recurring")) {
    return {
      id: "origin",
      text: "A schedule you set up created this",
      short: "On a schedule",
      glyph: "◷",
      tone: "violet",
    };
  }

  if (t.includes("heartbeat") || t.includes("proactiv")) {
    return {
      id: "origin",
      text: "Cue raised this on its own, checking in on your work",
      short: "Cue raised this",
      glyph: "◇",
      tone: "violet",
    };
  }

  if (channel) {
    return {
      id: "origin",
      text: `Came in from ${channel.name}`,
      short: `From ${channel.name}`,
      glyph: channel.glyph,
      tone: "blue",
    };
  }

  if (t.includes("agent") || t.includes("subagent")) {
    return {
      id: "origin",
      text: "One of your agents created this",
      short: "From an agent",
      glyph: "⬡",
      tone: "violet",
    };
  }

  if (
    t.includes("chat") ||
    t.includes("conversation") ||
    t.includes("thread") ||
    t.includes("assistant")
  ) {
    return {
      id: "origin",
      text: "Cue created this from a conversation",
      short: "From a conversation",
      glyph: "◆",
      tone: "blue",
    };
  }

  if (
    t.includes("user") ||
    t.includes("manual") ||
    t.includes("capture") ||
    t.includes("quick_add") ||
    t.includes("quickadd") ||
    t.includes("you")
  ) {
    return {
      id: "origin",
      text: "You added this",
      short: "You added this",
      glyph: "✎",
      tone: "muted",
    };
  }

  // Present but unmapped. An unmapped source is a bug; shipping the raw token
  // is a worse one, so it is humanised — the same last resort
  // `work-vocabulary.ts` takes for an unmapped state.
  const humanised = humanise(raw);
  return {
    id: "origin",
    text: `Came in from ${humanised}`,
    short: `From ${humanised}`,
    glyph: "↳",
    tone: "muted",
  };
}

/**
 * The sender named in the triage-stamped `sourceContext` snapshot, when there
 * is one. A malformed or absent snapshot yields null — the origin line stands
 * alone rather than being padded out.
 */
export function describeSender(item: ProvenanceFields): ProvenanceLine | null {
  let sender: string | null = null;
  try {
    const raw = item.sourceContext
      ? (JSON.parse(item.sourceContext) as { sender?: unknown })
      : null;
    if (typeof raw?.sender === "string" && raw.sender.trim()) {
      sender = raw.sender.trim();
    }
  } catch {
    // Malformed snapshot — say nothing rather than guess a sender.
    return null;
  }
  if (!sender) return null;
  return {
    id: "sender",
    text: `Sent by ${sender}`,
    short: sender,
    glyph: "◍",
    tone: "muted",
  };
}

/* -------------------------------------------------------------------------- */
/* Filing — the judgement Cue made                                            */
/* -------------------------------------------------------------------------- */

/**
 * The auto-filer's 0–1 score, in words.
 *
 * Null in, null out — a missing score produces NO phrase, never a hedged one.
 * A score outside 0–1 is not on the scale this vocabulary describes, so it is
 * treated as absent for the same reason.
 */
export function confidenceWords(
  confidence: number | null | undefined,
): string | null {
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) {
    return null;
  }
  if (confidence < 0 || confidence > 1) return null;
  if (confidence >= 0.9) return "almost certain";
  if (confidence >= 0.75) return "confident";
  if (confidence >= 0.55) return "fairly sure";
  return "not very sure";
}

/**
 * What Cue did with the item once it had it — filed it, was told to unfile it,
 * or scored it and declined to guess.
 *
 * `projectTitle` is the destination in the user's words; without it the line
 * still tells the truth, just less specifically. Never pass an id here.
 */
export function describeFiling(
  item: ProvenanceFields,
  projectTitle?: string | null,
): ProvenanceLine | null {
  const where = projectTitle?.trim() ? projectTitle.trim() : null;

  if (item.autoFiledBy === "cue" && item.projectId != null) {
    const sureness = confidenceWords(item.autoFileConfidence);
    const base = where
      ? `Cue filed this into ${where} itself`
      : "Cue filed this into a project itself";
    return {
      id: "filing",
      // No score, no claim about the score — the filing is still stated.
      text: sureness ? `${base} — it was ${sureness}` : base,
      short: where ? `Cue filed it · ${where}` : "Cue filed it",
      glyph: "✨",
      tone: "blue",
    };
  }

  if (item.autoFiledBy === "user_unfiled") {
    return {
      id: "filing",
      text: "You took this out of its project, so Cue will not re-file it",
      short: "You unfiled it",
      glyph: "✎",
      tone: "muted",
    };
  }

  // Scored but left alone: `autoFileConfidence` present while both `projectId`
  // and `autoFiledBy` stay null is the daemon's below-confidence stamp. Cue
  // looked and was not sure — which is a thing worth saying, because the
  // alternative is an item that looks unhandled for no visible reason.
  if (
    item.projectId == null &&
    item.autoFiledBy == null &&
    typeof item.autoFileConfidence === "number"
  ) {
    return {
      id: "filing",
      text: "Cue was not sure where this belongs, so it left the filing to you",
      short: "Cue was not sure",
      glyph: "?",
      tone: "amber",
    };
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* Run                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Who actually did the work. `null` — not yet run — says nothing; a run that
 * has not happened is not a fact about the item.
 *
 * Cue must never take credit for work it did not do, so `manual` reads as the
 * user's, and the `completedElsewhere` marker is named explicitly.
 */
export function describeRun(item: ProvenanceFields): ProvenanceLine | null {
  switch (item.ranProvenance) {
    case "auto":
      return {
        id: "run",
        text: "Cue ran this on its own",
        short: "Cue ran it",
        glyph: "◐",
        tone: "blue",
      };
    case "you_approved":
      return {
        id: "run",
        text: "Cue ran this after you approved it",
        short: "You approved the run",
        glyph: "✓",
        tone: "green",
      };
    case "manual":
      return {
        id: "run",
        text: item.completedElsewhere
          ? "You did this yourself, outside Cue"
          : "You did this yourself",
        short: "You did it",
        glyph: "✎",
        tone: "muted",
      };
    default:
      return null;
  }
}

/* -------------------------------------------------------------------------- */
/* The whole trace                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Everything provenance can honestly say about one item.
 *
 * `lines` is empty when the item carries no provenance at all — surfaces MUST
 * treat that as "render nothing", which is what `<ProvenanceTrace/>` does.
 */
export function describeProvenance(
  item: ProvenanceFields,
  projectTitle?: string | null,
): ProvenanceTrace {
  const origin = describeOrigin(item);
  // A sender without an origin would be a floating fact ("Sent by Sarah" —
  // over what?), so it rides with the origin line or not at all.
  const sender = origin ? describeSender(item) : null;
  const filing = describeFiling(item, projectTitle);
  const run = describeRun(item);
  return {
    origin,
    sender,
    filing,
    run,
    lines: [origin, sender, filing, run].filter(
      (l): l is ProvenanceLine => l != null,
    ),
    originConversationId: item.originConversationId?.trim()
      ? item.originConversationId
      : null,
  };
}
