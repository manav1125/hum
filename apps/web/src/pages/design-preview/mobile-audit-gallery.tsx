/**
 * Mobile-v3 audit harness — a backend-free preview that mounts the REAL
 * mobile-v3 page components at phone width so their layout can be measured
 * (`scrollWidth === clientWidth`, action-row bounds) without the app router,
 * auth, or a live daemon.
 *
 * Dev-only; never part of the product IA. Entry:
 *   /design-preview.html?gallery=mobile&screen=<key>
 * `?screen=` omitted renders an index of the available keys.
 *
 * Network is stubbed by swapping `globalThis.fetch` for a path-matching
 * responder (see `FIXTURES`) — every daemon/platform read resolves to canned
 * JSON so the surfaces render populated instead of in their empty state.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Component, lazy, Suspense, useEffect } from "react";
import { MemoryRouter, Route, Routes } from "react-router";

import { Mv3OverflowMenu, TabBarV3 } from "@/mobile-v3";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

/**
 * `?at=YYYY-MM-DDTHH:MM` — pin the wall clock.
 *
 * Added for the ritual slot, whose whole model is a function of the clock:
 * which of its three faces renders depends on the hour and the weekday, so
 * without this the harness could only ever show whichever face happened to be
 * due when someone opened it. Installed at MODULE scope, before `NOW` and
 * before any component reads a date — a `useEffect` would land after the first
 * render had already stamped the real time.
 *
 * Only the wall clock moves. Everything else is the real component.
 */
(() => {
  const raw = new URLSearchParams(globalThis.location?.search ?? "").get("at");
  if (!raw) return;
  const target = new Date(raw).getTime();
  if (Number.isNaN(target)) return;
  const Real = Date;
  const offset = target - Real.now();
  class Pinned extends Real {
    constructor(...args: unknown[]) {
      if (args.length === 0) super(Real.now() + offset);
      else super(...(args as []));
    }
    static now() {
      return Real.now() + offset;
    }
  }
  (globalThis as any).Date = Pinned;
})();

const ASSISTANT_ID = "a-preview";
const NOW = Date.now();
const MIN = 60_000;

/** A work item shaped like `workitemsGet`'s rows. */
function workItem(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "wi-1",
    taskId: "t-1",
    title: "Draft the Q3 partner-update email",
    notes: null,
    status: "running",
    priorityTier: 1,
    sortIndex: 1,
    projectId: "p-1",
    dueAt: NOW + 90 * MIN,
    labels: null,
    assignee: "cue",
    context: null,
    sourceContext: JSON.stringify({ sender: "Priya Raman" }),
    lastActivityAt: NOW - 12 * MIN,
    lastRunId: "r-1",
    lastRunConversationId: "c-1",
    lastRunStatus: "running",
    lastProgressNote: "Pulling the pipeline numbers from the CRM…",
    sourceType: "email",
    sourceId: "m-1",
    approvalStatus: null,
    autoRunEligibility: null,
    ranProvenance: null,
    completedElsewhere: false,
    // Pre-run assessment — null everywhere by default so the DEFAULT fixtures
    // exercise the "never assessed" path (surfaces must render as before).
    assessmentVerdict: null,
    assessmentUnderstanding: null,
    assessmentPlan: null,
    assessmentQuestion: null,
    assessmentMissing: null,
    assessmentConfidence: null,
    assessmentAt: null,
    createdAt: NOW - 40 * MIN,
    updatedAt: NOW - 12 * MIN,
    ...over,
  };
}

/** Real-world nasties: an unbroken URL/token and a very long title. */
const LONG_TITLE =
  "Reconcile the September invoices with the bank export and flag every unmatched row for Priya before Friday's close";
const UNBREAKABLE =
  "https://app.example.com/reports/2026-09/reconciliation?token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abcdefghijklmnop";

const WORK_ITEMS = [
  workItem({}),
  workItem({
    id: "wi-2",
    taskId: "t-2",
    title: "Reconcile the September invoices with the bank export",
    status: "awaiting_review",
    lastProgressNote: null,
    lastRunStatus: "succeeded",
    sourceType: "slack",
    sourceContext: JSON.stringify({ sender: "Finance channel" }),
  }),
  workItem({
    id: "wi-3",
    taskId: "t-3",
    title: "Summarise the customer-advisory-board transcript",
    status: "pending",
    projectId: null,
    lastProgressNote: null,
    lastRunConversationId: null,
    lastRunStatus: null,
  }),
  workItem({
    id: "wi-4",
    taskId: "t-4",
    title: "Ship the pricing-page copy revision",
    status: "done",
    ranProvenance: "auto",
    lastProgressNote: null,
  }),
  workItem({
    id: "wi-6",
    taskId: "t-6",
    title: "Draft the renewal note for Northwind",
    status: "queued",
    autoRunEligibility: "parked",
    lastProgressNote: null,
    lastRunConversationId: null,
    lastRunStatus: null,
  }),
  workItem({
    id: "wi-5",
    taskId: "t-5",
    title: "Chase the unsigned MSA from Northwind Logistics",
    status: "failed",
    lastProgressNote: null,
    lastRunStatus: "failed",
  }),
];

function project(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "p-1",
    title: "Partner growth & quarterly comms",
    emoji: "🤝",
    color: null,
    status: "active",
    category: "Growth",
    context: "Quarterly partner comms and pipeline hygiene",
    sortIndex: 1,
    pinned: 0,
    missionId: "m-1",
    createdAt: NOW - 30 * 24 * 60 * MIN,
    updatedAt: NOW - 2 * 60 * MIN,
    stats: {
      counts: {
        queued: 2,
        running: 1,
        awaiting_review: 1,
        done: 12,
        open: 4,
        total: 16,
      },
      nextTask: {
        id: "wi-1",
        title: "Draft the Q3 partner-update email",
        status: "running",
        dueAt: NOW + 90 * MIN,
        priorityTier: 1,
      },
    },
    ...over,
  };
}

const PROJECTS = [
  project({}),
  project({
    id: "p-2",
    title: "Finance operations — month-end close",
    emoji: "📊",
    category: "Operations",
    sortIndex: 2,
  }),
];

const EVENTS = [
  {
    id: "e-1",
    workItemId: "wi-1",
    kind: "created",
    fromStatus: null,
    toStatus: null,
    at: NOW - 40 * MIN,
    actor: "cue",
    detail: null,
  },
  {
    id: "e-2",
    workItemId: "wi-1",
    kind: "status_changed",
    fromStatus: "pending",
    toStatus: "queued",
    at: NOW - 30 * MIN,
    actor: "cue",
    detail: null,
  },
  {
    id: "e-3",
    workItemId: "wi-1",
    kind: "run_started",
    fromStatus: "queued",
    toStatus: "running",
    at: NOW - 22 * MIN,
    actor: "cue",
    detail: null,
  },
];

const MISSIONS = [
  {
    id: "m-1",
    title: "Grow partner-sourced pipeline",
    outcome: "Partner-sourced ARR up 30% by the end of Q4",
    metric: "partner_arr",
    horizon: NOW + 60 * 24 * 60 * MIN,
    status: "active",
    mode: "assist",
    brief: "Keep partner comms warm and surface every stalled deal.",
    cadence: "weekly",
    sweepAt: "09:00",
    budgetCents: 5000,
    spentCents: 1200,
    continuationSummary: null,
    pinned: 0,
    sortIndex: 1,
    lastCycleAt: NOW - 20 * 60 * MIN,
    createdAt: NOW - 20 * 24 * 60 * MIN,
    updatedAt: NOW - 60 * MIN,
    rollup: {
      projects: [
        {
          id: "p-1",
          title: "Partner growth & quarterly comms",
          emoji: "🤝",
          status: "active",
        },
      ],
      counts: {
        queued: 2,
        running: 1,
        awaiting_review: 1,
        done: 9,
        failed: 0,
        open: 4,
        total: 13,
      },
      spentCents: 1200,
      budgetCents: 5000,
    },
  },
];

/**
 * Path-suffix → JSON body. First match wins; `null` body means "fall through
 * to the generic empty shape".
 */
/** `?state=` knob so a screen's edge cases (empty / long / other status) can be
 *  measured without editing fixtures. */
const STATE = new URLSearchParams(globalThis.location?.search ?? "").get(
  "state",
);

/* ----------------------------- ritual-slot states -------------------------- */

/**
 * The ritual slot's four faces, driven from here because two of them are
 * decided by things a fixture alone cannot reach: the clock (`?at=`) and
 * device-local storage.
 *
 *   `?state=ritual-first`     — the first morning after a night with intake.
 *   `?state=ritual-orbit`     — the same first morning, but every lane is still
 *                               empty, so the slot has to ride ABOVE the
 *                               not-set-up takeover rather than be hidden by
 *                               it. This is the case R5 was overturned for.
 *   `?state=ritual-quiet`     — a night in which nothing arrived.
 *   `?state=ritual-untouched` — a fresh instance: the takeover keeps the
 *                               screen, and the slot renders nothing at all.
 *   `?state=ritual`           — an ordinary morning with work behind it.
 *
 * Pair any of them with `?at=2026-08-19T07:34` so the brief's window is open.
 */
const RITUAL_STATE = STATE?.startsWith("ritual") ? STATE : null;
/** A fresh instance: nothing watched, nothing in any lane. */
const RITUAL_UNTOUCHED = RITUAL_STATE === "ritual-untouched";
/** Intake happened, but nothing has reached a lane yet — the takeover state. */
const RITUAL_ORBIT = RITUAL_STATE === "ritual-orbit";
/** Every lane empty and no live source: what puts `EmptyOrbit` on the screen. */
const RITUAL_EMPTY_DECK = RITUAL_UNTOUCHED || RITUAL_ORBIT;
/** Nothing arrived overnight, but Cue was watching. */
const RITUAL_QUIET = RITUAL_STATE === "ritual-quiet";
/** This owner has never met a brief before. */
const RITUAL_FIRST =
  RITUAL_STATE === "ritual-first" || RITUAL_UNTOUCHED || RITUAL_ORBIT;

/**
 * "Has this owner seen a brief before" is device-local (design R4), so the
 * harness has to write it rather than serve it. Installed at module scope for
 * the same reason the clock pin is: the hook reads storage on its first
 * render, and an effect would land after that render had already decided.
 */
if (RITUAL_STATE) {
  try {
    if (RITUAL_FIRST) localStorage.removeItem("cue.mv3.ritual.first-brief");
    else localStorage.setItem("cue.mv3.ritual.first-brief", "2026-08-01");
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("cue.mv3.ritual.brief.")) localStorage.removeItem(key);
    }
  } catch {
    // A storage-less preview shows the first-brief face. Acceptable.
  }
}

/**
 * Six LIVE sources, plus one disabled and one failing — because a watcher that
 * EXISTS is not a watcher that WORKS, and "6 sources, no movement" may only
 * count the ones that could have moved. An untouched instance has none, which
 * is what puts `EmptyOrbit` on the screen with nothing above it; the
 * `ritual-orbit` state has the same zero LIVE count for the honest reason —
 * a night's intake landed and this morning the watcher is failing.
 */
const RITUAL_SOURCES = RITUAL_EMPTY_DECK
  ? []
  : [
      ...Array.from({ length: 6 }, (_, i) => ({
        id: `rw-${i}`,
        name: `Source ${i + 1}`,
        providerId: "gmail",
        enabled: true,
        pollIntervalMs: 900_000,
        intakeMode: "came_in",
        watermark: null,
        status: "ok",
        lastPollAt: Date.now() - 4 * 60_000,
        lastError: null,
        configJson: null,
        credentialService: "gmail",
        health: "ok",
      })),
      {
        id: "rw-off",
        name: "Paused source",
        providerId: "slack",
        enabled: false,
        pollIntervalMs: 300_000,
        intakeMode: "came_in",
        watermark: null,
        status: "paused",
        lastPollAt: null,
        lastError: null,
        configJson: null,
        credentialService: "slack",
        health: "unknown",
      },
      {
        id: "rw-bad",
        name: "Broken source",
        providerId: "github",
        enabled: true,
        pollIntervalMs: 300_000,
        intakeMode: "came_in",
        watermark: null,
        status: "error",
        lastPollAt: Date.now() - 90 * 60_000,
        lastError: "401 from GitHub",
        configJson: null,
        credentialService: "github",
        health: "reauth",
      },
    ];

/* ------------------------- pre-run assessment states ----------------------- */

/**
 * The four verdicts, one per fixture row, so a list can be measured with the
 * "waits on you" marks present. `?state=assess` uses short daemon copy;
 * `?state=assess-long` swaps in the pathological strings (a paragraph-long
 * question, an unbreakable URL) that must wrap rather than shear.
 */
const ASSESS_LONG_QUESTION =
  "Which of the three September bank exports should I reconcile against — the one Priya sent on the 18th, the corrected re-issue from the 22nd, or the consolidated file at " +
  UNBREAKABLE;
const ASSESS_LONG_MISSING =
  "The September bank export is not attached to this project, and the finance drive it usually arrives in is not connected: " +
  UNBREAKABLE;

function assessed(long: boolean): Record<string, Record<string, unknown>> {
  return {
    "wi-1": {
      assessmentVerdict: "execute",
      assessmentUnderstanding:
        "Write the Q3 partner update and send it to the partner list.",
      assessmentPlan: long
        ? `Read the pipeline numbers from the CRM, draft the email, and show it to you before sending. Source: ${UNBREAKABLE}`
        : "Read the pipeline numbers from the CRM, draft the email, and show it to you before sending.",
      assessmentConfidence: 0.9,
      assessmentAt: NOW - 14 * MIN,
    },
    "wi-2": {
      assessmentVerdict: "not_ai_task",
      assessmentUnderstanding:
        "Sit down with Priya and agree the two unmatched rows in person.",
      assessmentConfidence: 0.88,
      assessmentAt: NOW - 20 * MIN,
    },
    "wi-3": {
      assessmentVerdict: "clarify",
      assessmentQuestion: long
        ? ASSESS_LONG_QUESTION
        : "Which advisory-board session should I summarise — June or September?",
      assessmentUnderstanding: "Summarise the advisory-board transcript.",
      assessmentConfidence: 0.4,
      assessmentAt: NOW - 6 * MIN,
    },
    "wi-6": {
      assessmentVerdict: "clarify",
      assessmentQuestion: long
        ? ASSESS_LONG_QUESTION
        : "Should the renewal note go to Northwind's ops lead or their CFO?",
      assessmentConfidence: 0.55,
      assessmentAt: NOW - 9 * MIN,
    },
    "wi-5": {
      assessmentVerdict: "blocked",
      assessmentMissing: long
        ? ASSESS_LONG_MISSING
        : "No email account is connected, so I cannot chase Northwind.",
      assessmentConfidence: 0.8,
      assessmentAt: NOW - 3 * MIN,
    },
  };
}

/** Stamp the verdict map onto the fixture rows for the `assess*` states. */
function withAssessments(
  items: Record<string, unknown>[],
  long: boolean,
): Record<string, unknown>[] {
  const map = assessed(long);
  return items.map((i) => ({ ...i, ...(map[String(i.id)] ?? {}) }));
}

const LONG_EVENTS = Array.from({ length: 24 }, (_, i) => ({
  ...EVENTS[i % EVENTS.length],
  id: `e-long-${i}`,
  kind: `step_${i}`,
  fromStatus: null,
  toStatus: null,
  at: NOW - (40 - i) * MIN,
}));

const DAY = 24 * 60 * MIN;

/** `?state=people-degraded` drives the extraction-is-learning-nothing path. */
const PEOPLE_DEGRADED = STATE === "people-degraded";

/**
 * Four contacts chosen to cover every branch People can take: a rich
 * relationship, a thin one, a long gap, and someone Cue knows nothing about.
 * Names and addresses are invented; the `example.com` convention is enforced
 * by a pre-commit hook.
 */
const PREVIEW_CONTACTS = [
  {
    id: "c-1",
    displayName: "Rowan Vale",
    role: "counsel",
    contactType: "human",
    notes: null,
    interactionCount: 47,
    lastInteraction: NOW - 2 * 60 * MIN,
    channels: [],
  },
  {
    id: "c-2",
    displayName: "Imani Rooke",
    role: "procurement",
    contactType: "human",
    notes: null,
    interactionCount: 31,
    lastInteraction: NOW - 2 * DAY,
    channels: [],
  },
  {
    id: "c-3",
    displayName: "Sasha Quill",
    role: "partner",
    contactType: "human",
    notes: null,
    interactionCount: 9,
    lastInteraction: NOW - 11 * DAY,
    channels: [],
  },
  {
    id: "c-4",
    displayName: "Devon Marsh",
    role: "partnerships",
    contactType: "human",
    notes: null,
    interactionCount: 0,
    lastInteraction: null,
    channels: [],
  },
];

const CONTACT_MEMORY = [
  {
    id: "cm-1",
    contactId: "c-1",
    statement: "Handles the redlines",
    kind: "fact",
    source: "from_conversation",
    sourceRef: null,
    confidence: 0.9,
    createdAt: NOW - 120 * DAY,
    lastSeenAt: NOW,
  },
  {
    id: "cm-2",
    contactId: "c-1",
    statement: "Replies before 10am, never after 6",
    kind: "preference",
    source: "from_conversation",
    sourceRef: null,
    confidence: 0.8,
    createdAt: NOW - 90 * DAY,
    lastSeenAt: NOW,
  },
  {
    id: "cm-3",
    contactId: "c-1",
    statement: "Prefers email over chat for anything contractual",
    kind: "preference",
    source: "from_conversation",
    sourceRef: null,
    confidence: 0.8,
    createdAt: NOW - 40 * DAY,
    lastSeenAt: NOW,
  },
  {
    id: "cm-4",
    contactId: "c-2",
    statement:
      "Decides the renewal, and cares about per-seat pricing above all",
    kind: "fact",
    source: "from_conversation",
    sourceRef: null,
    confidence: 0.9,
    createdAt: NOW - 60 * DAY,
    lastSeenAt: NOW,
  },
];

/** Two rules you told Cue, two things it worked out. */
const PREVIEW_MEMORY_ITEMS = [
  {
    id: "n-1",
    kind: "behavioral",
    subject: "meetings",
    statement: "Never book meetings before 9am",
    status: "active",
    confidence: 0.95,
    importance: 0.8,
    firstSeenAt: NOW - 50 * DAY,
    lastSeenAt: NOW,
    sourceType: "direct",
    reinforcementCount: 0,
    accessCount: null,
    lastUsedAt: null,
  },
  {
    id: "n-2",
    kind: "procedural",
    subject: "discounts",
    statement: "Never discount below 15% without asking",
    status: "active",
    confidence: 0.9,
    importance: 0.9,
    firstSeenAt: NOW - 30 * DAY,
    lastSeenAt: NOW,
    sourceType: "direct",
    reinforcementCount: 2,
    accessCount: null,
    lastUsedAt: null,
  },
  {
    id: "n-3",
    kind: "semantic",
    subject: "acme",
    statement: "Imani decides; Rowan executes",
    status: "active",
    confidence: 0.7,
    importance: 0.6,
    firstSeenAt: NOW - 2 * DAY,
    lastSeenAt: NOW,
    sourceType: "inferred",
    reinforcementCount: 0,
    accessCount: null,
    lastUsedAt: null,
  },
  {
    id: "n-4",
    kind: "behavioral",
    subject: "mornings",
    statement: "You clear the deck between 8 and 9am",
    status: "active",
    confidence: 0.8,
    importance: 0.5,
    firstSeenAt: NOW - 1 * DAY,
    lastSeenAt: NOW,
    sourceType: "observed",
    reinforcementCount: 0,
    accessCount: null,
    lastUsedAt: null,
  },
];

/** One healthy source, one healthy source, one that needs reconnecting. */
const PREVIEW_WATCHERS = [
  {
    id: "wa-1",
    name: "Gmail",
    providerId: "gmail",
    enabled: true,
    pollIntervalMs: 300_000,
    intakeMode: "all",
    watermark: null,
    status: "ok",
    lastPollAt: NOW - 4 * MIN,
    lastError: null,
    configJson: null,
    credentialService: "gmail",
    health: "ok",
  },
  {
    id: "wa-2",
    name: "Google Calendar",
    providerId: "google-calendar",
    enabled: true,
    pollIntervalMs: 600_000,
    intakeMode: "all",
    watermark: null,
    status: "ok",
    lastPollAt: NOW - 9 * MIN,
    lastError: null,
    configJson: null,
    credentialService: "googlecalendar",
    health: "ok",
  },
  {
    id: "wa-3",
    name: "Slack",
    providerId: "slack",
    enabled: true,
    pollIntervalMs: 300_000,
    intakeMode: "all",
    watermark: null,
    status: "error",
    lastPollAt: NOW - 3 * DAY,
    lastError: "Provider rejected the connection (HTTP 401) — reconnect to fix",
    configJson: null,
    credentialService: "slack",
    health: "reauth",
  },
];

/** 200 rows — the endpoint's hard cap, so the "sample" copy is exercised. */
const PREVIEW_ARRIVALS = Array.from({ length: 200 }, (_, i) => ({
  id: `ar-${i}`,
  channel: i % 3 === 0 ? "watcher:google-calendar" : "watcher:gmail",
  externalId: `x-${i}`,
  watcherId: null,
  eventId: null,
  title: "An arrival",
  senderAddress: null,
  senderName: null,
  snippet: null,
  sourceContext: null,
  disposition: i % 2 === 0 ? "filed" : "surfaced",
  reason: null,
  // A realistic mix: mostly rules, a fail-open tail, a few real verdicts —
  // the shape production actually has (246 rule / 156 fallback / 14 model).
  decidedBy: i % 7 === 0 ? "fallback" : i % 11 === 0 ? "model" : "rule",
  ruleId: null,
  confidence: null,
  workItemId: i % 2 === 0 ? null : `wi-${i}`,
  reversedAt: null,
  reversedBy: null,
  createdAt: NOW - i * 60 * MIN,
  updatedAt: NOW,
}));

const FIXTURES: [RegExp, () => unknown][] = [
  [
    /\/work-items\/[^/]+\/events$/,
    () => ({
      events: STATE === "long" ? LONG_EVENTS : STATE === "empty" ? [] : EVENTS,
    }),
  ],
  [
    /\/work-items\/[^/]+\/output$/,
    () => ({
      output: {
        summary:
          "Reconciled 42 of 44 September invoices against the bank export. Two rows need a human call: an unmatched $1,240 ACH credit and a duplicated vendor reference.",
        highlights: [
          "42/44 matched automatically",
          "Unmatched: ACH credit $1,240 (2026-09-18)",
          "Duplicate vendor ref NW-2291 appears twice",
        ],
      },
    }),
  ],
  [
    /\/work-items$/,
    () => ({
      items:
        STATE === "assess" || STATE === "assess-long"
          ? withAssessments(WORK_ITEMS, STATE === "assess-long")
          : STATE === "review"
            ? [
                { ...WORK_ITEMS[0], status: "awaiting_review" },
                ...WORK_ITEMS.slice(1),
              ]
            : STATE === "stress"
              ? WORK_ITEMS.map((w) => ({
                  ...w,
                  title: `${LONG_TITLE} ${UNBREAKABLE}`,
                  lastProgressNote: `Fetching ${UNBREAKABLE}`,
                  sourceContext: JSON.stringify({
                    // Long local part, reserved domain: the fixture is here to
                    // stress unbreakable-string truncation, and the repo's
                    // generic-examples rule wants the domain to be example.com.
                    sender:
                      "priya.raman.northwind.logistics.international@example.com",
                  }),
                }))
              : WORK_ITEMS,
    }),
  ],
  [
    /\/projects\/[^/]+\/work-items$/,
    () => ({
      items:
        STATE === "assess" || STATE === "assess-long"
          ? withAssessments(WORK_ITEMS, STATE === "assess-long")
          : WORK_ITEMS,
    }),
  ],
  [/\/projects$/, () => ({ projects: PROJECTS })],
  [/\/missions\/[^/]+\/events$/, () => ({ events: [] })],
  [/\/missions\/[^/]+$/, () => ({ mission: MISSIONS[0] })],
  [/\/missions$/, () => ({ missions: MISSIONS })],
  [/\/schedules$/, () => ({ schedules: [] })],
  [/\/activity$/, () => ({ items: [], events: [] })],
  [
    /\/agents$/,
    () => ({
      agents: [
        {
          id: "ag-1",
          name: "Ops",
          role: "Keeps the operational loop tidy",
          status: "active",
          modelPin: null,
          toolScopes: null,
          budgetCents: 5000,
          spentCents: 900,
          createdAt: NOW,
          updatedAt: NOW,
        },
        {
          id: "ag-2",
          name: "Growth",
          role: "Runs partner and lifecycle outreach",
          status: "paused",
          modelPin: null,
          toolScopes: null,
          budgetCents: 3000,
          spentCents: 2900,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
    }),
  ],
  [/\/agents\/spend$/, () => ({ agents: [] })],
  [
    /\/guardrails$/,
    () => ({
      checkpoints: [
        {
          id: "cp-1",
          template: "send_message",
          label: "Ask before sending anything on my behalf",
          pattern: "autonomy:message",
          scope: "everywhere",
          thresholdCents: null,
          enabled: 1,
          isDefault: 1,
          enforced: true,
          enforcedVia: "permission-checker",
          createdAt: NOW,
          updatedAt: NOW,
        },
        {
          id: "cp-2",
          template: "spend_over",
          label: "Ask before spending more than $20",
          pattern: "autonomy:money",
          scope: "everywhere",
          thresholdCents: 2000,
          enabled: 1,
          isDefault: 1,
          enforced: true,
          enforcedVia: "permission-checker",
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
      agents: [],
      ledger: {
        recentActs: [
          {
            id: "act-1",
            agent: "Ops",
            workItemId: "wi-4",
            missionId: "m-1",
            kind: "run_completed",
            title: "Ship the pricing-page copy revision",
            reversed: 0,
            reversedAt: null,
            estMinutesSaved: 25,
            costCents: 9,
            model: "claude-haiku-4-5",
            createdAt: NOW - 3 * 60 * MIN,
          },
        ],
        heldItems: [],
        summary: {
          actCount: 14,
          reversedCount: 1,
          heldCount: 0,
          estMinutesSaved: 320,
          totalCents: 640,
          byModel: [
            {
              model: "claude-haiku-4-5",
              costCents: 640,
              calls: 210,
              share: 1,
            },
          ],
          byMission: [
            {
              missionId: "m-1",
              missionTitle: "Grow partner-sourced pipeline",
              costCents: 420,
              runs: 9,
            },
          ],
        },
      },
    }),
  ],
  [
    /\/skills$/,
    () => ({
      skills: [
        {
          id: "sk-1",
          name: "Competitive brief",
          description:
            "Research competitors and produce a positioning and messaging comparison with content gaps.",
          emoji: "🔭",
          kind: "installed",
          status: "enabled",
          category: "Research",
          origin: "vellum",
        },
        {
          id: "sk-2",
          name: "Month-end close checklist",
          description:
            "Reconcile invoices against the bank export and flag every unmatched row.",
          emoji: "📚",
          kind: "catalog",
          status: "available",
          category: "Finance & operations",
          origin: "vellum",
        },
      ],
    }),
  ],
  [
    /\/skills\/categories$/,
    () => ({ categories: ["Research", "Finance & operations", "Growth"] }),
  ],
  [
    /\/plugins$/,
    () => ({
      plugins: [
        {
          id: "cue-slack-bridge",
          name: "cue-slack-bridge",
          description:
            "Bridges Slack channels into the inbound pipeline with per-channel triage rules.",
          version: "1.4.2",
          disabled: false,
        },
        {
          id: "cue-calendar-sync",
          name: "cue-calendar-sync",
          description: "Two-way calendar sync for scheduled runs.",
          version: "0.9.0",
          disabled: true,
        },
      ],
    }),
  ],
  [
    /\/connector-apps$/,
    () => ({
      configured: true,
      source: "composio",
      apps: [
        {
          slug: "gmail",
          name: "Gmail",
          category: "Email",
          connected: true,
          health: { status: "ok", lastSuccessAt: new Date(NOW).toISOString() },
        },
        {
          slug: "slack",
          name: "Slack",
          category: "Messaging",
          connected: true,
          health: {
            status: "attention",
            lastError: "The workspace revoked the token — reconnect Slack.",
          },
        },
        {
          slug: "google-calendar",
          name: "Google Calendar",
          category: "Scheduling",
          connected: false,
        },
      ],
    }),
  ],
  [
    /\/trust\/rules$/,
    () => ({
      rules: [
        {
          id: "tr-1",
          triggerType: "sender",
          triggerValue: "Priya Raman",
          action: "auto_confirm",
          label: "Auto-confirm anything Priya Raman sends",
          enabled: 1,
          sourceWorkItemId: null,
          sourceTaskId: null,
          createdAt: NOW,
          updatedAt: NOW,
        },
      ],
    }),
  ],
  [
    /\/acts$/,
    () => ({
      acts: [
        {
          id: "act-1",
          agent: "Ops",
          workItemId: "wi-4",
          missionId: "m-1",
          kind: "run_completed",
          title: "Ship the pricing-page copy revision",
          reversed: 0,
          reversedAt: null,
          estMinutesSaved: 25,
          costCents: 9,
          model: "claude-haiku-4-5",
          createdAt: NOW - 3 * 60 * MIN,
        },
        {
          id: "act-2",
          agent: "Growth",
          workItemId: "wi-2",
          missionId: "m-1",
          kind: "message_drafted",
          title: "Reconcile the September invoices with the bank export",
          reversed: 1,
          reversedAt: NOW - 30 * MIN,
          estMinutesSaved: 40,
          costCents: 14,
          model: "claude-haiku-4-5",
          createdAt: NOW - 5 * 60 * MIN,
        },
      ],
    }),
  ],
  [
    /\/conversations$/,
    () => ({
      conversations: [
        {
          id: "c-1",
          title: "Q3 partner-update email — draft and tone pass",
          createdAt: NOW - 3 * 60 * MIN,
          updatedAt: NOW - 12 * MIN,
          lastMessageAt: NOW - 12 * MIN,
          conversationType: "standard",
          source: "web",
        },
        {
          id: "c-2",
          title: "Month-end close: unmatched ACH credit investigation",
          createdAt: NOW - 26 * 60 * MIN,
          updatedAt: NOW - 90 * MIN,
          lastMessageAt: NOW - 90 * MIN,
          conversationType: "background",
          source: "schedule",
        },
      ],
    }),
  ],
  // The watcher/playbook routes answer with bare arrays, not envelopes.
  [
    /\/watchers\/list$/,
    () =>
      RITUAL_STATE
        ? RITUAL_SOURCES
        : [
            {
              id: "w-1",
              name: "Contracts inbox — unsigned older than 5 days",
              providerId: "gmail",
              enabled: true,
              pollIntervalMs: 900_000,
              intakeMode: "came_in",
              watermark: null,
              status: "ok",
              lastPollAt: NOW - 6 * MIN,
              lastError: null,
              configJson: null,
              credentialService: "gmail",
              health: "ok",
            },
            {
              id: "w-2",
              name: "Finance Slack channel",
              providerId: "slack",
              enabled: false,
              pollIntervalMs: 300_000,
              intakeMode: "came_in",
              watermark: null,
              status: "reauth",
              lastPollAt: NOW - 3 * 60 * MIN,
              lastError: "The workspace revoked the token — reconnect Slack.",
              configJson: null,
              credentialService: "slack",
              health: "reauth",
            },
          ],
  ],
  [/\/watchers\/providers$/, () => []],
  [
    /\/playbooks\/list$/,
    () => [
      {
        id: "pb-1",
        name: "Weekly partner digest",
        triggerText: "Every Monday at 09:00",
        channel: "email",
        watcherId: "w-1",
        action: "draft_and_send",
        autonomyLevel: "draft",
        priority: 1,
        enabled: true,
        lastFiredAt: NOW - 26 * 60 * MIN,
        effectiveAutonomy: "draft",
        autonomyCeiling: "auto",
        autonomyCapped: false,
        globalDial: "assist",
      },
    ],
  ],
  // ── handoff-2026-08-03 · People · Memory · Watching · Weekly ──────────
  // Four contacts covering all four relationship states AND all four
  // "what Cue has learned" outcomes, because those splits are the whole
  // point of those screens.
  [
    /\/people\/memory\/health$/,
    () => ({
      conversationRuns: 40,
      conversationsIdentified: 12,
      consecutiveUnidentified: 0,
      sweeps: 5,
      lastSweepAt: NOW,
      lastSweepExamined: 8,
      lastSweepSaved: 3,
      consecutiveUnproductiveSweeps: 0,
      contactsProvisioned: 4,
      factsWritten: 14,
      degraded: PEOPLE_DEGRADED,
      degradedReason: PEOPLE_DEGRADED
        ? "the extraction budget expired before the model replied"
        : null,
    }),
  ],
  // Per contact, so the harness shows all four "what Cue has learned"
  // outcomes side by side instead of one of them four times.
  [/\/contacts\/c-1\/memory$/, () => ({ ok: true, memory: CONTACT_MEMORY })],
  [
    /\/contacts\/c-2\/memory$/,
    () => ({ ok: true, memory: [CONTACT_MEMORY[3]] }),
  ],
  [/\/contacts\/[^/]+\/memory$/, () => ({ ok: true, memory: [] })],
  [
    /\/contacts\/[^/]+\/dossier$/,
    () => ({
      ok: true,
      dossier: {
        contactId: "c-1",
        displayName: PREVIEW_CONTACTS[0]!.displayName,
        contactType: "human",
        role: "counsel",
        relationship: {
          contactId: "c-1",
          score: 62,
          tier: "building",
          lastInteractionAt: NOW - 2 * 60 * MIN,
          interactionCount: 47,
          updatedAt: NOW,
        },
        memory: CONTACT_MEMORY,
        reachability: [
          {
            channelId: "ch-1",
            type: "email",
            address: "rowan@example.com",
            isPrimary: true,
            status: "active",
            reachable: true,
            lastSeenAt: NOW,
          },
        ],
        interactions: [
          {
            kind: "conversation",
            conversationId: "c-1",
            channel: "email",
            title: "Redlines — one open point on term length",
            at: NOW - 2 * 60 * MIN,
          },
        ],
        interactionsDegraded: false,
      },
    }),
  ],
  [/\/contacts$/, () => ({ ok: true, contacts: PREVIEW_CONTACTS })],
  [
    /\/memory-items$/,
    () => ({ items: PREVIEW_MEMORY_ITEMS, total: PREVIEW_MEMORY_ITEMS.length }),
  ],
  [/\/watchers\/list$/, () => PREVIEW_WATCHERS],
  [
    /\/watchers\/providers$/,
    () => [
      { id: "gmail", displayName: "Gmail", requiredCredentialService: "gmail" },
      {
        id: "google-calendar",
        displayName: "Google Calendar",
        requiredCredentialService: "googlecalendar",
      },
      { id: "slack", displayName: "Slack", requiredCredentialService: "slack" },
    ],
  ],
  [
    /\/arrivals\/summary$/,
    () =>
      // The ritual states read ONE NIGHT, not the Watching page's week — the
      // first-brief face says "one night in", so it has to be counted over
      // one. Zeroes on an untouched instance, which is precisely why the slot
      // stays silent there rather than introducing Cue with "no things".
      RITUAL_STATE
        ? {
            since: NOW - 24 * 60 * MIN,
            until: NOW,
            windowHours: 24,
            bound: "trailing_window",
            timeZone: null,
            arrived: RITUAL_UNTOUCHED ? 0 : 41,
            filed: RITUAL_UNTOUCHED ? 0 : 29,
            kept: RITUAL_UNTOUCHED ? 0 : 12,
            reversed: 0,
            topFiledReasons: [],
          }
        : {
            since: NOW - 7 * DAY,
            until: NOW,
            windowHours: 168,
            arrived: 415,
            filed: 166,
            kept: 249,
            reversed: 0,
            topFiledReasons: [
              { reason: "newsletter from a mailing list", count: 88 },
              { reason: "automated build notification", count: 41 },
              { reason: "receipt from a no-reply sender", count: 22 },
            ],
          },
  ],
  [
    /\/arrivals\/comprehension\/health$/,
    () => ({
      census: {
        since: NOW - 30 * DAY,
        total: 70,
        withDeadline: 12,
        byStatus: {
          comprehended: 21,
          low_confidence: 15,
          failed: 27,
          skipped: 7,
        },
      },
      lastBatchAt: NOW - 20 * MIN,
      lastBatchCandidates: 6,
      lastBatchComprehended: 1,
      consecutiveUnproductiveBatches: 2,
      unproductiveWarnAt: 5,
      totalBatches: 718,
      totalComprehended: 21,
    }),
  ],
  [/\/arrivals$/, () => ({ arrivals: PREVIEW_ARRIVALS })],
  [
    /\/connector-apps$/,
    () => ({
      configured: true,
      source: "composio",
      apps: [
        { slug: "gmail", name: "Gmail", category: "email", connected: true },
        {
          slug: "googlecalendar",
          name: "Google Calendar",
          category: "calendar",
          connected: true,
        },
        { slug: "notion", name: "Notion", category: "docs", connected: true },
        {
          slug: "googledrive",
          name: "Google Drive",
          category: "docs",
          connected: true,
        },
      ],
    }),
  ],
  [
    /\/acts\/summary$/,
    () => ({ acts: 61, reversed: 2, estMinutesSaved: 420, byAgent: [] }),
  ],
  [
    /\/usage\/totals$/,
    () => ({
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheCreationTokens: 0,
      totalCacheReadTokens: 0,
      totalEstimatedCostUsd: 18.4,
      eventCount: 1218,
      pricedEventCount: 1218,
      unpricedEventCount: 0,
    }),
  ],
  [
    /\/ledger\/autonomy$/,
    () => ({
      entries: [],
      summary: {
        total: 9,
        executed: 8,
        parked: 1,
        denied: 0,
        failed: 0,
        executedUnattended: 3,
        executedWithoutApproval: 2,
        byClass: [],
      },
      window: { days: 7, from: NOW - 7 * DAY },
    }),
  ],
  [
    // The REAL wire contract (`runtime/routes/morning-brief-routes.ts`, and
    // `mobile-v3/brief/use-morning-brief.ts`'s narrowing of it): a flat object
    // with `overnight` / `ask` / `day`, not a nested `brief` envelope.
    //
    // This fixture used to answer `{ brief: { greeting, summary, sections } }`,
    // which `normalizeMorningBrief` reads as a brief with nothing in it — so
    // the harness's Brief screen had been previewing the ALL-QUIET story while
    // looking like it was previewing a populated one. A fixture in the wrong
    // shape is worse than a missing one: the surface renders, so nobody looks.
    /\/brief\/morning$/,
    () =>
      // An all-quiet night is a payload with NOTHING in it, not a missing
      // payload — the whole of R3. Omit-rather-than-fake governs absent data;
      // it has nothing to say about uneventful data.
      RITUAL_QUIET || RITUAL_UNTOUCHED
        ? {
            generatedAt: new Date(NOW).toISOString(),
            since: new Date(NOW - 24 * 60 * MIN).toISOString(),
            overnight: [],
            ask: null,
            day: [],
            calendarAvailable: true,
          }
        : {
            generatedAt: new Date(NOW).toISOString(),
            since: new Date(NOW - 24 * 60 * MIN).toISOString(),
            overnight: [
              {
                id: "ov-1",
                title: "Drafted the Northwind renewal reply",
                project: "Northwind",
                agent: "Ops",
                state: "done",
                kind: "work_item",
                completedAt: new Date(NOW - 5 * 60 * MIN).toISOString(),
              },
              {
                id: "ov-2",
                title: "Reconciled the September invoices",
                state: "done",
                kind: "work_item",
                completedAt: new Date(NOW - 4 * 60 * MIN).toISOString(),
              },
              {
                id: "ov-3",
                title: "Swept the inbox",
                state: "done",
                kind: "inbox_cleanup",
                counts: { archived: 41, drafted: 3, keptImportant: 6 },
                completedAt: new Date(NOW - 3 * 60 * MIN).toISOString(),
              },
              {
                id: "ov-4",
                title: "Built the Q3 partner deck outline",
                state: "done",
                kind: "work_item",
                completedAt: new Date(NOW - 2 * 60 * MIN).toISOString(),
              },
            ],
            ask: {
              id: "ask-1",
              kind: "approval",
              title: "Send the Northwind renewal reply",
              project: "Northwind",
              actions: [
                {
                  id: "ok",
                  label: "Approve",
                  kind: "approve",
                  endpoint: "/v1/x",
                  method: "POST",
                },
              ],
            },
            day: [
              {
                title: "Pipeline review",
                kind: "event",
                time: new Date(new Date().setHours(10, 30, 0, 0)).toISOString(),
              },
            ],
            calendarAvailable: true,
          },
  ],
  [
    // `acts` is a NUMBER on this route. The generic fallback body answers
    // `acts: []`, which the weekly's `acts.data?.acts ?? 0` happily accepts and
    // then adds to a count — string-concatenating an array into "N things
    // moved". A typed contract deserves a typed fixture.
    /\/acts\/summary$/,
    () => ({ acts: 7, reversed: 1, window: { days: 7 } }),
  ],
];

function mockBody(url: string): unknown {
  for (const [re, make] of FIXTURES) {
    if (re.test(url.split("?")[0] ?? url)) return make();
  }
  // Generic shape: every list-ish accessor in the app reads `?? []`.
  return {
    items: [],
    events: [],
    conversations: [],
    // `contacts` and `documents` are read as `data.contacts.length` /
    // `data.documents.length` by `useCueCounts`, which the ⋯ menu calls. Their
    // absence from this fallback threw inside the FIXED chrome — outside the
    // route's boundary — and blanked every `overflow: true` screen entirely.
    contacts: [],
    documents: [],
    skills: [],
    categories: [],
    plugins: [],
    apps: [],
    connections: [],
    schedules: [],
    agents: [],
    acts: [],
    rules: [],
    memories: [],
    entries: [],
    sources: [],
    installed: [],
    profiles: [],
    results: [],
    ok: true,
  };
}

let installed = false;
function installMockFetch(): void {
  if (installed) return;
  installed = true;
  const real = globalThis.fetch.bind(globalThis);
  globalThis.fetch = ((input: any, init?: any) => {
    const url = typeof input === "string" ? input : (input?.url ?? "");
    // `window.__mockCalls` is the debugging hook: it tells you which endpoints
    // a surface actually reads, so a blank screen can be traced to a missing
    // fixture rather than guessed at.
    ((globalThis as any).__mockCalls ??= []).push(url);
    if (typeof url === "string" && url.includes("/v1/")) {
      return Promise.resolve(
        new Response(JSON.stringify(mockBody(url)), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    return real(input, init);
  }) as typeof fetch;
}

const WatchLivePage = lazy(() =>
  import("@/mobile-v3/watch/watch-live-page").then((m) => ({
    default: m.WatchLivePage,
  })),
);
const ReviewQueuePage = lazy(() =>
  import("@/mobile-v3/review/review-queue-page").then((m) => ({
    default: m.ReviewQueuePage,
  })),
);
const ReviewIndexPage = lazy(() =>
  import("@/mobile-v3/review/review-index-page").then((m) => ({
    default: m.ReviewIndexPage,
  })),
);
const CameInPage = lazy(() =>
  import("@/mobile-v3/triage/came-in-page").then((m) => ({
    default: m.CameInPage,
  })),
);
const BriefPage = lazy(() =>
  import("@/mobile-v3/brief/brief-page").then((m) => ({
    default: m.BriefPage,
  })),
);
const Mv3Today = lazy(() =>
  import("@/mobile-v3/today/mv3-today").then((m) => ({ default: m.Mv3Today })),
);
const Mv3MissionDetail = lazy(() =>
  import("@/mobile-v3/mission/mission-detail-page").then((m) => ({
    default: m.Mv3MissionDetail,
  })),
);
const Mv3ProjectDetail = lazy(() =>
  import("@/pages/projects/mv3-project-detail").then((m) => ({
    default: m.Mv3ProjectDetail,
  })),
);
const Mv3Projects = lazy(() =>
  import("@/pages/projects/mv3-projects").then((m) => ({
    default: m.Mv3Projects,
  })),
);
const Mv3AllWork = lazy(() =>
  import("@/pages/projects/mv3-all-work").then((m) => ({
    default: m.Mv3AllWork,
  })),
);
const Mv3CueScreen = lazy(() =>
  import("@/mobile-v3/you/cue-screen").then((m) => ({
    default: m.Mv3CueScreen,
  })),
);
const Mv3AgentsPage = lazy(() =>
  import("@/mobile-v3/you/agents-page").then((m) => ({
    default: m.Mv3AgentsPage,
  })),
);
const Mv3SkillsPage = lazy(() =>
  import("@/mobile-v3/you/skills-page").then((m) => ({
    default: m.Mv3SkillsPage,
  })),
);
const Mv3PluginsPage = lazy(() =>
  import("@/mobile-v3/you/plugins-page").then((m) => ({
    default: m.Mv3PluginsPage,
  })),
);
const Mv3ConnectionsPage = lazy(() =>
  import("@/mobile-v3/you/connections-page").then((m) => ({
    default: m.Mv3ConnectionsPage,
  })),
);
const Mv3AutomationsPage = lazy(() =>
  import("@/mobile-v3/you/automations-page").then((m) => ({
    default: m.Mv3AutomationsPage,
  })),
);
const Mv3RulesPage = lazy(() =>
  import("@/mobile-v3/you/rules-page").then((m) => ({
    default: m.Mv3RulesPage,
  })),
);
const Mv3MemoryPage = lazy(() =>
  import("@/mobile-v3/memory/mv3-memory-page-v24").then((m) => ({
    default: m.Mv3MemoryV24Page,
  })),
);
// v22 M3 / v24 F4 · F5 · F3 — the handoff-2026-08-03 screens.
const Mv3PeoplePage = lazy(() =>
  import("@/mobile-v3/people/mv3-people-page").then((m) => ({
    default: m.Mv3PeoplePage,
  })),
);
const Mv3PersonPage = lazy(() =>
  import("@/mobile-v3/people/mv3-person-page").then((m) => ({
    default: m.Mv3PersonPage,
  })),
);
const Mv3WatchingPage = lazy(() =>
  import("@/mobile-v3/watching/mv3-watching-page").then((m) => ({
    default: m.Mv3WatchingPage,
  })),
);
const Mv3WeeklyPage = lazy(() =>
  import("@/mobile-v3/weekly/mv3-weekly-page").then((m) => ({
    default: m.Mv3WeeklyPage,
  })),
);
const Mv3RitualsArchivePage = lazy(() =>
  import("@/mobile-v3/rituals/rituals-archive-page").then((m) => ({
    default: m.Mv3RitualsArchivePage,
  })),
);
const Mv3LedgerPage = lazy(() =>
  import("@/mobile-v3/you/ledger-page").then((m) => ({
    default: m.Mv3LedgerPage,
  })),
);
const Mv3ExplorePage = lazy(() =>
  import("@/mobile-v3/you/explore-page").then((m) => ({
    default: m.Mv3ExplorePage,
  })),
);
const Mv3IdentityPage = lazy(() =>
  import("@/mobile-v3/you/identity-page").then((m) => ({
    default: m.Mv3IdentityPage,
  })),
);
const ChatsIndexPage = lazy(() =>
  import("@/mobile-v3/chats/chats-index-page").then((m) => ({
    default: m.ChatsIndexPage,
  })),
);
const OrganizerRemotePage = lazy(() =>
  import("@/mobile-v3/organizer/organizer-remote-page").then((m) => ({
    default: m.OrganizerRemotePage,
  })),
);

const Mv3TaskSheet = lazy(() =>
  import("@/pages/projects/mv3-task-sheet").then((m) => ({
    default: m.Mv3TaskSheet,
  })),
);

/**
 * The task sheet, held open on ONE fixture item, so each pre-run verdict's
 * affordances can be measured at 390px. `?state=execute|clarify|not_ai|blocked`
 * picks the verdict; `?state=assess-long` (or `long`) drives the pathological
 * daemon copy through the clarify path. Anything else = no verdict at all,
 * which must render exactly as the sheet did before assessment existed.
 */
function TaskSheetPreview() {
  const long = STATE === "assess-long" || STATE === "long";
  const map = assessed(long);
  const pick: Record<string, string> = {
    execute: "wi-1",
    not_ai: "wi-2",
    clarify: "wi-3",
    blocked: "wi-5",
    "assess-long": "wi-3",
    long: "wi-3",
  };
  const id = pick[STATE ?? ""] ?? null;
  const base = workItem({
    id: "wi-3",
    title: "Summarise the customer-advisory-board transcript",
    status: "queued",
    lastProgressNote: null,
    lastRunConversationId: null,
  });
  const item = id ? { ...base, id, ...(map[id] ?? {}) } : base;
  return (
    <Mv3TaskSheet
      assistantId={ASSISTANT_ID}
      item={item as any}
      projects={PROJECTS as any}
      onClose={() => {}}
      onAttachKnowledge={() => {}}
    />
  );
}

/** Today takes its rows as PROPS (not through the fetch stub), so the
 *  `assess*` states are applied here too. */
const TODAY_ITEMS =
  STATE === "assess" || STATE === "assess-long"
    ? withAssessments(WORK_ITEMS, STATE === "assess-long")
    : WORK_ITEMS;

interface Screen {
  key: string;
  label: string;
  /** Initial MemoryRouter entry; the route pattern is derived from `route`. */
  entry: string;
  route: string;
  element: React.ReactNode;
  /** Whether the real shell shows the tab bar on this surface. */
  tabBar?: boolean;
  /**
   * Whether the real shell shows the ☰ / ⓜ corner chrome here — i.e. whether
   * this key is one of `root-layout`'s `MV3_OVERFLOW_SURFACES`. Worth having
   * in the harness because the corners are fixed-position and overlap the
   * screen's own header: the collision between the live affordance and Today's
   * decorative avatar chip was invisible to every screen-only preview.
   */
  overflow?: boolean;
}

const SCREENS: Screen[] = [
  {
    key: "watch-live",
    label: "Watch live (run)",
    entry: "/assistant/work/wi-1/live",
    route: "/assistant/work/:workItemId/live",
    element: <WatchLivePage />,
    tabBar: true,
  },
  {
    key: "today",
    label: "Today / HQ",
    entry: "/assistant/hq",
    route: "/assistant/hq",
    element: (
      <Mv3Today
        assistantId={ASSISTANT_ID}
        userName="Manav"
        move={
          RITUAL_EMPTY_DECK
            ? ({ hasMove: false } as any)
            : {
                hasMove: true,
                itemId: "wi-2",
                kind: "work_item",
                headline:
                  "Reconcile the September invoices with the bank export",
                reasoning:
                  "Two rows still need a human call and the close is Friday.",
                actions: [
                  { id: "a1", label: "Review", kind: "open_thread" },
                  { id: "a2", label: "Snooze", kind: "snooze" },
                ],
              }
        }
        review={
          RITUAL_EMPTY_DECK
            ? []
            : (TODAY_ITEMS.filter((i) => i.status === "awaiting_review") as any)
        }
        running={
          RITUAL_EMPTY_DECK
            ? []
            : (TODAY_ITEMS.filter((i) => i.status === "running") as any)
        }
        cameIn={
          RITUAL_EMPTY_DECK
            ? []
            : (TODAY_ITEMS.filter((i) => i.status === "pending") as any)
        }
        done={
          RITUAL_EMPTY_DECK
            ? []
            : (TODAY_ITEMS.filter((i) => i.status === "done") as any)
        }
        doneError={false}
        reviewError={false}
        glanceCount={
          RITUAL_EMPTY_DECK
            ? 0
            : TODAY_ITEMS.filter((i) => i.status === "awaiting_review").length +
              1
        }
        missions={[]}
        missionsError={false}
        day={null}
        lifeGroups={[]}
        arrivals={{ total: 0, filed: 0, kept: 0 }}
        arrivalsError={false}
        waiting={[]}
        schedules={[]}
        schedulesError={false}
        // Zero on an untouched instance is what puts `EmptyOrbit` on the
        // screen — the state R5's condition is about.
        watchingCount={RITUAL_EMPTY_DECK ? 0 : 2}
        heartbeatRuns={1851}
        degraded={false}
      />
    ),
    tabBar: true,
    overflow: true,
  },
  {
    key: "review-queue",
    label: "Review pager",
    entry: "/assistant/review-queue",
    route: "/assistant/review-queue",
    element: <ReviewQueuePage />,
    tabBar: true,
  },
  {
    key: "review-index",
    label: "Review index",
    entry: "/assistant/review",
    route: "/assistant/review",
    element: <ReviewIndexPage />,
    tabBar: true,
  },
  {
    key: "came-in",
    label: "Came in today (triage)",
    entry: "/assistant/came-in",
    route: "/assistant/came-in",
    element: <CameInPage />,
    tabBar: true,
  },
  {
    key: "brief",
    label: "Morning brief",
    entry: "/assistant/brief",
    route: "/assistant/brief",
    element: <BriefPage />,
  },
  {
    key: "mission",
    label: "Mission detail",
    entry: "/assistant/missions/m-1",
    route: "/assistant/missions/:missionId",
    element: <Mv3MissionDetail missionId="m-1" />,
    tabBar: true,
  },
  {
    key: "projects",
    label: "Projects",
    entry: "/assistant/projects",
    route: "/assistant/projects",
    element: <Mv3Projects />,
    tabBar: true,
    overflow: true,
  },
  {
    key: "project-detail",
    label: "Project detail",
    entry: "/assistant/projects/p-1",
    route: "/assistant/projects/:projectId",
    element: <Mv3ProjectDetail />,
    tabBar: true,
  },
  {
    key: "all-work",
    label: "All work",
    entry: "/assistant/work",
    route: "/assistant/work",
    element: <Mv3AllWork />,
    tabBar: true,
    // No `overflow` — `/assistant/work` is NOT one of the chrome's routes, and
    // a harness that paints chrome production does not paint is worse than no
    // harness.
  },
  {
    key: "task-sheet",
    label: "Task sheet (pre-run assessment)",
    entry: "/assistant/work",
    route: "/assistant/work",
    element: <TaskSheetPreview />,
  },
  {
    key: "chats",
    label: "Chats index",
    entry: "/assistant/conversations",
    route: "/assistant/conversations",
    element: <ChatsIndexPage />,
    tabBar: true,
    overflow: true,
  },
  {
    // Was "You" at /assistant/channels. Design R2: one name on both
    // platforms, and the hub moved to its real URL.
    key: "your-cue",
    label: "Your Cue",
    entry: "/assistant/your-cue",
    route: "/assistant/your-cue",
    element: <Mv3CueScreen />,
    tabBar: true,
  },
  {
    key: "agents",
    label: "You › Agents",
    entry: "/assistant/agents",
    route: "/assistant/agents",
    element: <Mv3AgentsPage />,
    tabBar: true,
  },
  {
    key: "skills",
    label: "You › Skills",
    entry: "/assistant/skills",
    route: "/assistant/skills",
    element: <Mv3SkillsPage assistantId={ASSISTANT_ID} />,
    tabBar: true,
  },
  {
    key: "plugins",
    label: "You › Plugins",
    entry: "/assistant/plugins",
    route: "/assistant/plugins",
    element: <Mv3PluginsPage assistantId={ASSISTANT_ID} />,
    tabBar: true,
  },
  {
    key: "connections",
    label: "You › Connections",
    entry: "/assistant/connections",
    route: "/assistant/connections",
    element: <Mv3ConnectionsPage />,
    tabBar: true,
  },
  {
    key: "automations",
    label: "You › Automations",
    entry: "/assistant/automations",
    route: "/assistant/automations",
    element: <Mv3AutomationsPage />,
    tabBar: true,
  },
  {
    key: "rules",
    label: "You › Rules",
    entry: "/assistant/rules",
    route: "/assistant/rules",
    element: <Mv3RulesPage />,
    tabBar: true,
  },
  {
    key: "memory",
    label: "Memory (v24 F6)",
    entry: "/assistant/memory",
    route: "/assistant/memory",
    element: <Mv3MemoryPage />,
    tabBar: true,
  },
  {
    key: "ledger",
    label: "You › Ledger",
    entry: "/assistant/ledger",
    route: "/assistant/ledger",
    element: <Mv3LedgerPage />,
    tabBar: true,
  },
  {
    key: "explore",
    label: "Explore",
    entry: "/assistant/explore",
    route: "/assistant/explore",
    element: <Mv3ExplorePage />,
    tabBar: true,
  },
  {
    key: "identity",
    label: "Identity",
    entry: "/assistant/identity",
    route: "/assistant/identity",
    element: <Mv3IdentityPage assistantId={ASSISTANT_ID} />,
    tabBar: true,
  },
  {
    key: "people",
    label: "People (v22 M3)",
    entry: "/assistant/people",
    route: "/assistant/people",
    element: <Mv3PeoplePage />,
    tabBar: true,
    // No `overflow` — `/assistant/people` is not one of `corner-chrome`'s
    // MV3_OVERFLOW_SURFACES, and a harness that paints chrome production
    // doesn't paint is worse than no harness.
  },
  {
    key: "person",
    label: "A person (v24 F4)",
    entry: "/assistant/people/c-1",
    route: "/assistant/people/:contactId",
    element: <Mv3PersonPage />,
    tabBar: true,
  },
  {
    key: "watching",
    label: "Watching (v24 F5)",
    entry: "/assistant/watching",
    route: "/assistant/watching",
    element: <Mv3WatchingPage />,
    tabBar: true,
  },
  {
    key: "weekly",
    label: "Weekly review (v24 F3)",
    entry: "/assistant/weekly",
    route: "/assistant/weekly",
    element: <Mv3WeeklyPage />,
    tabBar: false,
  },
  {
    // The SECONDARY door to the two rituals (v43 R1). The primary one is the
    // slot at the top of Today — pin the clock with `?at=` to see its faces,
    // and add `&state=ritual-first|ritual-quiet|ritual-untouched|ritual` for
    // the two R3/R5 faces, the suppressed instance, and an ordinary morning.
    key: "rituals",
    label: "Briefs & reviews (archive)",
    entry: "/assistant/rituals",
    route: "/assistant/rituals",
    element: <Mv3RitualsArchivePage />,
    tabBar: false,
    // Not one of `MV3_OVERFLOW_SURFACES` — it is reached FROM the ⋯ menu, so
    // it carries no second copy of it. (Marked `true` first time round, which
    // is exactly the collision `corner-chrome.ts` exists to prevent: the ☰
    // button landed on the header's first line.)
    overflow: false,
  },
  {
    key: "organizer",
    label: "Organizer remote",
    entry: "/assistant/organizer",
    route: "/assistant/organizer",
    element: <OrganizerRemotePage />,
    tabBar: true,
  },
];

/** Surfaces a render crash instead of a blank screen (fixture mismatches). */
class Boundary extends Component<
  { children: React.ReactNode },
  { err: string | null }
> {
  state = { err: null as string | null };
  static getDerivedStateFromError(e: unknown) {
    return { err: e instanceof Error ? `${e.message}\n${e.stack}` : String(e) };
  }
  render() {
    if (this.state.err)
      return (
        <pre
          data-slot="preview-error"
          style={{ padding: 16, fontSize: 11, whiteSpace: "pre-wrap" }}
        >
          {this.state.err}
        </pre>
      );
    return this.props.children;
  }
}

function Index() {
  return (
    <div style={{ padding: 24, fontFamily: "system-ui" }}>
      <h1 style={{ fontSize: 18, marginBottom: 12 }}>Mobile audit harness</h1>
      <ul style={{ lineHeight: 1.9 }}>
        {SCREENS.map((s) => (
          <li key={s.key}>
            <a href={`?gallery=mobile&screen=${s.key}`}>{s.label}</a>{" "}
            <code style={{ opacity: 0.5 }}>{s.key}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Module scope on purpose: child effects run BEFORE the parent's, so a
// useEffect here would install the stub after the first queries have already
// fired against the real network.
installMockFetch();
useResolvedAssistantsStore.setState({ activeAssistantId: ASSISTANT_ID });

const client = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
});

export function MobileAuditGallery() {
  const params = new URLSearchParams(globalThis.location?.search ?? "");
  const key = params.get("screen");
  const screen = SCREENS.find((s) => s.key === key);
  const theme = params.get("theme") ?? "light";

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  if (!screen) return <Index />;

  // Mirrors `root-layout`'s app-shell box so measurements match production.
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[screen.entry]}>
        <div
          data-slot="root-layout"
          className="app-shell"
          style={{
            background: "var(--surface-base)",
            height: "100dvh",
            paddingBottom:
              "var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))",
            paddingLeft:
              "var(--safe-area-inset-left, env(safe-area-inset-left, 0px))",
            paddingRight:
              "var(--safe-area-inset-right, env(safe-area-inset-right, 0px))",
            isolation: "isolate",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div
            className="flex min-w-0 flex-col overflow-hidden w-full"
            style={{ flex: "1 1 0%", minHeight: 0 }}
          >
            <Suspense fallback={<div />}>
              <Boundary>
                <Routes>
                  <Route path={screen.route} element={screen.element} />
                  <Route path="*" element={<div>no route</div>} />
                </Routes>
              </Boundary>
            </Suspense>
          </div>
          {/*
            The fixed chrome gets its own boundary.

            It used to sit outside one, so a crash anywhere in the ⋯ menu's
            import graph — which reaches into Create and the chat composer —
            blanked the ENTIRE preview with no message, for every screen marked
            `overflow`. The screen under test was fine; you just could not see
            it, or tell that the chrome was the reason.
          */}
          {screen.overflow ? (
            <Boundary>
              <Mv3OverflowMenu />
            </Boundary>
          ) : null}
          {screen.tabBar ? (
            <Boundary>
              <TabBarV3 />
            </Boundary>
          ) : null}
          <div id="viewport-overlays" />
        </div>
      </MemoryRouter>
    </QueryClientProvider>
  );
}
