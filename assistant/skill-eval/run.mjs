/**
 * SkillOpt-style rollout + score driver.
 *
 *   node run.mjs <taskfile> [--split train|holdout|all] [--label baseline]
 *
 * Fans out every task as a concurrent rollout against the configured Cue
 * instance, waits for each to settle, scores it, and writes a results JSON to
 * results/<skill>-<label>.json plus a console summary. Compare two labels
 * (e.g. baseline vs edited) to gate a skill edit.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BASE, sendTask, waitForCompletion } from "./lib.mjs";
import { scoreAppBuilder } from "./score-app-builder.mjs";
import { scoreTasks } from "./score-tasks.mjs";
import { scoreWebResearch } from "./score-web-research.mjs";

const SCORERS = {
  "app-builder": scoreAppBuilder,
  tasks: scoreTasks,
  "web-research": scoreWebResearch,
};
const here = path.dirname(fileURLToPath(import.meta.url));

const [taskfile, ...rest] = process.argv.slice(2);
if (!taskfile) {
  console.error(
    "usage: node run.mjs <taskfile> [--split train|holdout|all] [--label baseline]",
  );
  process.exit(1);
}
const arg = (name, def) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 && rest[i + 1] ? rest[i + 1] : def;
};
const split = arg("split", "all");
const label = arg("label", "run");

const suite = JSON.parse(
  await (
    await import("node:fs/promises")
  ).readFile(
    path.isAbsolute(taskfile) ? taskfile : path.join(here, taskfile),
    "utf8",
  ),
);
const scorer = SCORERS[suite.skill];
if (!scorer) {
  console.error(`no scorer for skill "${suite.skill}"`);
  process.exit(1);
}
const tasks = suite.tasks.filter((t) => split === "all" || t.split === split);
const stamp = Math.floor(Date.now() / 1000);

console.error(
  `[${suite.skill}] ${label}: ${tasks.length} tasks against ${BASE}`,
);

// Roll out one task end-to-end (send → wait → score). Errors never throw.
async function rollout(t) {
  const key = `eval-${suite.skill}-${t.id}-${stamp}`;
  try {
    await sendTask(key, t.prompt);
    const messages = await waitForCompletion(t.prompt);
    const score = messages
      ? scorer(messages)
      : {
          total: 0,
          max: 10,
          parts: {},
          finalText: "(timeout — no transcript)",
        };
    // Tool names used, for the optimizer's failure analysis.
    const tools = messages
      ? [
          ...new Set(
            [...JSON.stringify(messages).matchAll(/"name":"([a-z_]+)"/g)].map(
              (m) => m[1],
            ),
          ),
        ]
      : [];
    return { id: t.id, split: t.split, prompt: t.prompt, tools, ...score };
  } catch (err) {
    return {
      id: t.id,
      split: t.split,
      prompt: t.prompt,
      tools: [],
      total: 0,
      max: 10,
      parts: {},
      finalText: `(rollout error: ${err.message})`,
    };
  }
}

// Cap concurrency: many simultaneous heavy builds overflow the runtime provider's
// context and skew scores. Batches of 3 keep load sane without serializing fully.
const CONCURRENCY = Number(process.env.CUE_EVAL_CONCURRENCY || 3);
const results = [];
for (let i = 0; i < tasks.length; i += CONCURRENCY) {
  const batch = tasks.slice(i, i + CONCURRENCY);
  results.push(...(await Promise.all(batch.map(rollout))));
}
const sum = results.reduce((s, r) => s + r.total, 0);
const maxSum = results.reduce((s, r) => s + r.max, 0);
const pct = maxSum ? Math.round((sum / maxSum) * 1000) / 10 : 0;

console.error(
  `\n=== ${suite.skill} / ${label} — ${pct}% (${sum}/${maxSum}) ===`,
);
for (const r of results) {
  const fails = Object.entries(r.parts)
    .filter(([, p]) => !p.pass)
    .map(([k]) => k)
    .join(",");
  console.error(
    `  ${r.id.padEnd(11)} ${String(r.total).padStart(2)}/${r.max} [${r.split}]` +
      (fails ? `  FAIL: ${fails}` : "  ✓") +
      `  — ${r.finalText.replace(/\n/g, " ").slice(0, 80)}`,
  );
}

mkdirSync(path.join(here, "results"), { recursive: true });
const out = path.join(here, "results", `${suite.skill}-${label}.json`);
writeFileSync(
  out,
  JSON.stringify(
    { skill: suite.skill, label, pct, sum, maxSum, results },
    null,
    2,
  ),
);
console.error(`\nwrote ${out}`);
