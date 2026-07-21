/**
 * Real-model evaluation of the pre-run work-item assessment.
 *
 * The unit tests prove the plumbing with a stubbed assessor; they cannot say
 * whether a real model's verdicts are any good. This drives the deployed
 * instance with a fixture set drawn from the user's ACTUAL task history
 * (see the `expect` field for the verdict a person would give) and prints a
 * scorecard, so the decision to leave the gate armed is made on evidence.
 *
 * Usage: bun run qa/assessment-eval.ts
 */
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = process.env.CUE_BASE ?? "https://manav.justcue.app";
const token = readFileSync(
  path.join(os.homedir(), ".cue", "qa-actor-token"),
  "utf8",
).trim();

/**
 * Titles are real tasks pulled from the instance's work_items table. `expect`
 * is the verdict a reasonable person would give; `accept` widens that where
 * more than one verdict is defensible (asking instead of declining is never
 * counted as a failure — over-asking is the safe direction).
 */
const FIXTURES: {
  title: string;
  notes?: string;
  expect: string;
  accept?: string[];
}[] = [
  // --- should just run ---
  {
    title: "Please research fun activities for kids in Berawa, Bali.",
    expect: "execute",
  },
  {
    title:
      "Find some late-night restaurant options in Berawa, Bali. Include the address and what they are known for.",
    expect: "execute",
  },
  {
    title:
      "Build a comprehensive and sustainable strategy to lose 20 kg, covering diet, training and sleep.",
    expect: "execute",
  },
  {
    title: "Draft the weekly update for the Brinc portfolio founders",
    notes:
      "Cover: Q3 metrics collection, the two new hires, and the AEF capital call timing.",
    expect: "execute",
  },
  // --- a human has to do these ---
  { title: "Buy oat milk, spinach, and coffee beans", expect: "not_ai_task" },
  {
    title: "Complete biomarkers at Nirvana tomorrow",
    expect: "not_ai_task",
  },
  // --- money / signing: always the user's own action ---
  { title: "Pay Architect", expect: "not_ai_task", accept: ["blocked"] },
  {
    title: "wire the aef fund capital call",
    expect: "not_ai_task",
    accept: ["blocked"],
  },
  {
    title: "pay the bali home rennovation deposit",
    expect: "not_ai_task",
    accept: ["blocked"],
  },
  // --- underspecified: ask one question ---
  {
    title: "Finish pitch deck edits before Monday board call",
    expect: "clarify",
  },
  {
    title: "Follow up with Brinc portfolio founders on metrics",
    expect: "clarify",
    accept: ["blocked"],
  },
  { title: "review bali home rennovation quotes", expect: "clarify" },
  { title: "Send Q3 invoice to AEF fund", expect: "clarify" },
  // --- needs a capability that is not connected ---
  {
    title: "Call the dentist to book a cleaning for next week",
    expect: "blocked",
    accept: ["clarify"],
  },
];

async function api(method: string, route: string, body?: unknown) {
  const res = await fetch(`${BASE}/v1/${route}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${route} → ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

const created: { id: string; fx: (typeof FIXTURES)[number] }[] = [];
for (const fx of FIXTURES) {
  const item = await api("POST", "work-items", {
    title: `[EVAL] ${fx.title}`,
    ...(fx.notes ? { notes: fx.notes } : {}),
  });
  const id = item?.id ?? item?.item?.id;
  if (!id) throw new Error(`no id back for ${fx.title}: ${JSON.stringify(item)}`);
  created.push({ id, fx });
  await api("POST", `work-items/${id}/run`);
  process.stderr.write(".");
}
process.stderr.write("\ndispatched; waiting for assessments…\n");

// Poll until every item has been assessed (or we give up on it).
const deadline = Date.now() + 8 * 60_000;
const seen = new Map<string, Record<string, unknown>>();
while (Date.now() < deadline && seen.size < created.length) {
  await new Promise((r) => setTimeout(r, 5_000));
  // Fetch in parallel: polling serially took longer than the poll interval,
  // which is what made the first run look like a mass fail-open.
  const pending = created.filter(({ id }) => !seen.has(id));
  const items = await Promise.all(
    pending.map(({ id }) =>
      api("GET", `work-items/${id}`)
        .then((r) => [id, r?.item ?? r] as const)
        .catch(() => [id, null] as const),
    ),
  );
  for (const [id, got] of items) {
    if (got?.assessmentVerdict) seen.set(id, got);
  }
  process.stderr.write(`${seen.size}/${created.length} `);
}
process.stderr.write("\n\n");

let right = 0;
const rows: string[] = [];
for (const { id, fx } of created) {
  const got = seen.get(id);
  const verdict = (got?.assessmentVerdict as string) ?? "(none)";
  const ok = verdict === fx.expect || (fx.accept ?? []).includes(verdict);
  if (ok) right += 1;
  const detail =
    (got?.assessmentQuestion as string) ??
    (got?.assessmentMissing as string) ??
    (got?.assessmentPlan as string) ??
    "";
  rows.push(
    [
      ok ? "  ok " : "MISS ",
      `${verdict.padEnd(12)} (want ${fx.expect})`,
      `\n       task: ${fx.title}`,
      `\n       understood: ${got?.assessmentUnderstanding ?? "—"}`,
      `\n       said: ${detail || "—"}`,
      `  [conf ${got?.assessmentConfidence ?? "—"}]`,
    ].join(""),
  );
}
console.log(rows.join("\n\n"));
console.log(`\n=== ${right}/${created.length} verdicts defensible ===`);
console.log(created.map((c) => c.id).join(","));
