/**
 * Automated reflect + edit — the SkillOpt "propose a bounded edit" step.
 *
 *   node optimize.mjs <skill> [--label baseline]
 *
 * Reads the scored results for <skill> (results/<skill>-<label>.json), gathers
 * the FAILING rollouts (prompt + which rubric components failed + what the model
 * actually said), sends them plus the current SKILL.md to an optimizer LLM, and
 * asks for ONE bounded edit (a "textual learning rate" — a small insert, not a
 * rewrite). It writes the proposal to proposals/<skill>-<ts>.md for a human to
 * review, apply, redeploy, and then GATE with run.mjs. It deliberately does NOT
 * auto-apply: SkillLens shows ~25% of skill edits cause negative transfer, so
 * every edit must be gated against a real re-run before it ships.
 *
 * Optimizer model via CUE_EVAL_OPTIMIZER_MODEL (default deepseek/deepseek-v4-flash).
 * Point it at a stronger model for bigger gains (SkillOpt: stronger optimizer wins).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SKILL_MD = {
  "app-builder": "../src/config/bundled-skills/app-builder/SKILL.md",
  tasks: "../src/config/bundled-skills/tasks/SKILL.md",
  "web-research": "../src/config/bundled-skills/web-research/SKILL.md",
};

const [skill, ...rest] = process.argv.slice(2);
if (!skill || !SKILL_MD[skill]) {
  console.error(
    `usage: node optimize.mjs <${Object.keys(SKILL_MD).join("|")}> [--label baseline]`,
  );
  process.exit(1);
}
const li = rest.indexOf("--label");
const label = li >= 0 && rest[li + 1] ? rest[li + 1] : "baseline";

const results = JSON.parse(
  readFileSync(path.join(here, "results", `${skill}-${label}.json`), "utf8"),
);
const failing = results.results.filter((r) => r.total < r.max);
if (failing.length === 0) {
  console.error(
    `No failing tasks in ${skill}-${label} (${results.pct}%). Nothing to optimize.`,
  );
  process.exit(0);
}

const skillMd = readFileSync(path.join(here, SKILL_MD[skill]), "utf8");
const failReport = failing
  .map((r) => {
    const failed = Object.entries(r.parts || {})
      .filter(([, p]) => !p.pass)
      .map(([k]) => k)
      .join(", ");
    return `- Task "${r.prompt}"\n  failed: ${failed || "(scored 0)"}\n  tools used: ${(r.tools || []).join(", ") || "none"}\n  model said: "${(r.finalText || "").slice(0, 200)}"`;
  })
  .join("\n");

const OPTIMIZER =
  process.env.CUE_EVAL_OPTIMIZER_MODEL || "deepseek/deepseek-v4-flash";
const KEY =
  process.env.CUE_EVAL_OPENROUTER_KEY?.trim() ||
  readFileSync(
    path.join(os.homedir(), ".cue", "qa-openrouter-key"),
    "utf8",
  ).trim();

const SYSTEM =
  "You optimize a coding agent's natural-language SKILL.md by proposing ONE bounded edit that fixes the observed failures. This is a 'textual learning rate': a SMALL, surgical insert — not a rewrite — so existing working rules survive. Do not restate rules already present. Output only the requested JSON.";

const USER = `Here is the current SKILL.md for the "${skill}" skill:

<skill_md>
${skillMd.slice(0, 12000)}
</skill_md>

These rollouts FAILED on a scored eval (each is a real user turn; "failed" lists which rubric checks the model missed, and "model said" is what it actually produced):

${failReport}

Diagnose the DOMINANT failure mode, then propose ONE bounded edit to the SKILL.md that would fix it without rewriting working rules. Return ONLY JSON:
{
  "diagnosis": "<one sentence: the dominant failure mode across these rollouts>",
  "anchorLine": "<an EXISTING unique line from the SKILL.md, copied verbatim, after which the new block should be inserted>",
  "insertBlock": "<the new markdown block to insert — imperative, specific to the failure, a few sentences max>"
}`;

async function callOptimizer() {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: OPTIMIZER,
          messages: [
            { role: "system", content: SYSTEM },
            { role: "user", content: USER },
          ],
          response_format: { type: "json_object" },
          max_tokens: 1200,
          provider: {
            order: ["DeepInfra", "StreamLake"],
            allow_fallbacks: true,
          },
        }),
        signal: AbortSignal.timeout(90_000),
      });
      const j = await r.json();
      const content = j.choices?.[0]?.message?.content;
      if (!content) throw new Error("empty optimizer response");
      const m = content.match(/\{[\s\S]*\}/);
      return JSON.parse(m ? m[0] : content);
    } catch (err) {
      if (i === 2) throw err;
      await new Promise((res) => setTimeout(res, 3000));
    }
  }
}

console.error(
  `[optimize] ${skill}: reflecting on ${failing.length} failing rollouts via ${OPTIMIZER}…`,
);
const proposal = await callOptimizer();

const ts = new Date().toISOString().replace(/[:.]/g, "-");
const anchorFound = skillMd.includes((proposal.anchorLine || "").trim());
const out = `# Proposed skill edit — ${skill} (from ${skill}-${label}.json, ${results.pct}%)

Optimizer: ${OPTIMIZER}
Failing tasks reflected on: ${failing.map((r) => r.id).join(", ")}

## Diagnosis
${proposal.diagnosis}

## Insert anchor (found in SKILL.md: ${anchorFound ? "YES ✓" : "NO ✗ — reconcile by hand"})
\`\`\`
${proposal.anchorLine}
\`\`\`

## Proposed block to insert after the anchor
${proposal.insertBlock}

---
Review this. If it's sound: apply the insert to the SKILL.md, redeploy the daemon,
then GATE it: \`node run.mjs tasks/${skill}.json --label edited\` and keep only if
the held-out score rises (SkillLens: ~25% of edits regress — never ship ungated).
`;

mkdirSync(path.join(here, "proposals"), { recursive: true });
const file = path.join(here, "proposals", `${skill}-${ts}.md`);
writeFileSync(file, out);
console.error(`\n${out}\nwrote ${file}`);
