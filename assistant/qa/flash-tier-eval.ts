/**
 * Flash-tier routing eval — ON vs OFF, against a locally hatched instance.
 *
 * Prereqs (see docs/perf-2026-07-20 flash-tier report):
 *   - a `vellum hatch --name flasheval` local instance whose llm config points
 *     at a working provider, with `llm.flashTier.model` set to a model id
 *     DISTINCT from the mainAgent model (so routing is observable).
 *   - `vellum` CLI on PATH; sqlite read access to the instance workspace DB.
 *
 * Usage:
 *   VW=~/.local/share/vellum/assistants/flasheval/.vellum/workspace \
 *     bun run qa/flash-tier-eval.ts [--arm on|off|both]
 *
 * For each case the script sends a message into a FRESH conversation
 * (unique --conversation-key), waits for the turn to finish, then scores:
 *   - correctness: regex over the final assistant text
 *   - routing: which model(s) served the turn's mainAgent calls
 *     (from llm_usage_events)
 *   - latency: last assistant message created_at − user message created_at
 *
 * The flash flag is toggled via `assistant config set llm.flashTier.enabled`.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { Database } from "bun:sqlite";

const VW = process.env.VW;
if (!VW) {
  console.error("Set VW to the instance workspace dir");
  process.exit(2);
}
const DB_PATH = path.join(VW, "data", "db", "assistant.db");
const ASSISTANT_CLI = path.join(import.meta.dir, "..", "src", "index.ts");
const TURN_TIMEOUT_MS = 120_000;

interface EvalCase {
  id: string;
  kind: "trivial" | "tool" | "non-trivial" | "followup";
  prompt: string;
  expect: RegExp;
  /** When ON, do we expect the flash model ("flash") or the main model ("main")? */
  expectedRouteOn: "flash" | "main";
  /** Reuse the conversation of this case id (multi-turn follow-up cases). */
  sameConversationAs?: string;
}

const CASES: EvalCase[] = [
  {
    id: "arith",
    kind: "trivial",
    prompt: "What is 6 multiplied by 7? Reply with only the number.",
    expect: /42/,
    expectedRouteOn: "flash",
  },
  {
    id: "spell",
    kind: "trivial",
    prompt:
      "Spell the word 'cue' backwards. Reply with only the reversed letters.",
    expect: /euc/i,
    expectedRouteOn: "flash",
  },
  {
    id: "color",
    kind: "trivial",
    prompt: "In one word, what color is a ripe banana?",
    expect: /yellow/i,
    expectedRouteOn: "flash",
  },
  {
    id: "french",
    kind: "trivial",
    prompt:
      "How do you say hello in French? Answer with the single French word only.",
    expect: /bonjour/i,
    expectedRouteOn: "flash",
  },
  {
    id: "sum",
    kind: "trivial",
    prompt: "What is 9 plus 5? Reply with only the number.",
    expect: /14/,
    expectedRouteOn: "flash",
  },
  {
    id: "bash-tool",
    kind: "tool",
    prompt:
      "Use your bash tool to run exactly this command: echo $((13*11)) — then tell me the exact number it printed.",
    expect: /143/,
    expectedRouteOn: "flash",
  },
  {
    id: "file-tool",
    kind: "tool",
    prompt:
      "Create a file named proof.txt in your workspace containing exactly the word pineapple. Then confirm you created it.",
    expect: /proof\.txt|pineapple|created|done/i,
    expectedRouteOn: "flash",
  },
  {
    id: "long",
    kind: "non-trivial",
    prompt:
      "I want to think through a planning question with you and it needs real care. Imagine a small startup with three engineers, one designer and one PM, currently shipping a weekly release train, and they are considering moving to continuous deployment. Walk me through, briefly, the two biggest risks of making that switch and one mitigation for each risk. Keep the whole answer under six sentences.",
    expect: /risk|deploy|test|rollback|mitigat/i,
    expectedRouteOn: "main",
  },
  {
    id: "followup",
    kind: "followup",
    sameConversationAs: "bash-tool",
    prompt: "Thanks. What number was that again? Reply with only the number.",
    expect: /143/,
    expectedRouteOn: "main",
  },
];

function sh(cmd: string, args: string[], env?: Record<string, string>) {
  const res = spawnSync(cmd, args, {
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 90_000,
  });
  if (res.status !== 0) {
    throw new Error(
      `${cmd} ${args.join(" ")} failed: ${res.stderr || res.stdout}`,
    );
  }
  return res.stdout;
}

function setFlash(enabled: boolean) {
  sh(
    "bun",
    [
      "run",
      ASSISTANT_CLI,
      "config",
      "set",
      "llm.flashTier.enabled",
      String(enabled),
    ],
    {
      VELLUM_WORKSPACE_DIR: VW!,
    },
  );
}

function db() {
  return new Database(DB_PATH, { readonly: true });
}

interface TurnResult {
  caseId: string;
  arm: "on" | "off";
  ok: boolean;
  answerSnippet: string;
  latencyMs: number;
  models: string[]; // distinct models that served mainAgent calls this turn
  routedFlash: boolean;
  routeCorrect: boolean | null;
  toolCalls: number;
}

const FLASH_MODEL_OUT = sh(
  "bun",
  ["run", ASSISTANT_CLI, "config", "get", "llm.flashTier.model"],
  {
    VELLUM_WORKSPACE_DIR: VW!,
  },
)
  .trim()
  .replace(/^"|"$/g, "");

async function runCase(
  c: EvalCase,
  arm: "on" | "off",
  convKeys: Map<string, string>,
): Promise<TurnResult> {
  const convKey = c.sameConversationAs
    ? convKeys.get(c.sameConversationAs)!
    : `flash-eval-${arm}-${c.id}-${Date.now()}`;
  convKeys.set(c.id, convKey);

  const d = db();
  const before = d
    .query("SELECT COALESCE(MAX(created_at),0) t FROM messages")
    .get() as { t: number };
  const sentAt = Date.now();
  sh("vellum", [
    "message",
    "flasheval",
    "--conversation-key",
    convKey,
    c.prompt,
  ]);

  // Poll for the turn to complete: the last message in the conversation is an
  // assistant message with a text block, and no new message for 3s.
  let conversationId: string | null = null;
  let finalText = "";
  let lastAssistantAt = 0;
  let userMsgAt = 0;
  const deadline = Date.now() + TURN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await Bun.sleep(1500);
    if (!conversationId) {
      const row = d
        .query(
          `SELECT conversation_id cid, created_at t FROM messages
           WHERE role='user' AND created_at > ? AND content LIKE ?
           ORDER BY created_at ASC LIMIT 1`,
        )
        .get(before.t, `%${c.prompt.slice(0, 40).replace(/[%_]/g, "")}%`) as {
        cid: string;
        t: number;
      } | null;
      if (!row) continue;
      conversationId = row.cid;
      userMsgAt = row.t;
    }
    const last = d
      .query(
        `SELECT role, content, created_at t FROM messages
         WHERE conversation_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1`,
      )
      .get(conversationId) as {
      role: string;
      content: string;
      t: number;
    } | null;
    if (!last || last.role !== "assistant") continue;
    const blocks = JSON.parse(last.content) as Array<{
      type: string;
      text?: string;
    }>;
    const text = blocks
      .filter((b) => b.type === "text" && b.text)
      .map((b) => b.text)
      .join("\n");
    const hasToolUse = blocks.some((b) => b.type === "tool_use");
    if (!text || hasToolUse) continue; // still mid-loop
    if (last.t === lastAssistantAt) {
      finalText = text;
      break; // stable for one extra poll → turn done
    }
    lastAssistantAt = last.t;
  }

  const usage = conversationId
    ? (d
        .query(
          `SELECT model, COUNT(*) n FROM llm_usage_events
           WHERE conversation_id=? AND call_site='mainAgent' AND created_at >= ?
           GROUP BY model`,
        )
        .all(conversationId, sentAt - 5000) as Array<{
        model: string;
        n: number;
      }>)
    : [];
  const toolCalls = conversationId
    ? (
        d
          .query(
            `SELECT COUNT(*) n FROM messages WHERE conversation_id=? AND created_at > ? AND content LIKE '%"tool_use"%'`,
          )
          .get(conversationId, before.t) as { n: number }
      ).n
    : 0;
  d.close();

  const models = usage.map((u) => u.model);
  const routedFlash = models.includes(FLASH_MODEL_OUT);
  const routeCorrect =
    arm === "off"
      ? !routedFlash
      : c.expectedRouteOn === "flash"
        ? routedFlash
        : !routedFlash;
  return {
    caseId: c.id,
    arm,
    ok: c.expect.test(finalText),
    answerSnippet: finalText.replace(/\s+/g, " ").slice(0, 60),
    latencyMs: lastAssistantAt && userMsgAt ? lastAssistantAt - userMsgAt : -1,
    models,
    routedFlash,
    routeCorrect,
    toolCalls,
  };
}

const armArg = process.argv.includes("--arm")
  ? process.argv[process.argv.indexOf("--arm") + 1]
  : "both";
const arms: Array<"off" | "on"> =
  armArg === "both" ? ["off", "on"] : [armArg as "off" | "on"];

const results: TurnResult[] = [];
for (const arm of arms) {
  setFlash(arm === "on");
  await Bun.sleep(3000); // let the config watcher settle
  console.log(
    `\n=== arm: flashTier ${arm.toUpperCase()} (flash model: ${FLASH_MODEL_OUT}) ===`,
  );
  const convKeys = new Map<string, string>();
  for (const c of CASES) {
    try {
      const r = await runCase(c, arm, convKeys);
      results.push(r);
      console.log(
        `[${arm}] ${c.id.padEnd(10)} ok=${r.ok ? "Y" : "N"} route=${r.routedFlash ? "flash" : "main"}${r.routeCorrect === false ? " (UNEXPECTED)" : ""} latency=${r.latencyMs}ms tools=${r.toolCalls} models=${r.models.join("+") || "?"} :: ${r.answerSnippet}`,
      );
    } catch (err) {
      console.log(`[${arm}] ${c.id} ERROR ${String(err).slice(0, 120)}`);
      results.push({
        caseId: c.id,
        arm,
        ok: false,
        answerSnippet: "ERROR",
        latencyMs: -1,
        models: [],
        routedFlash: false,
        routeCorrect: null,
        toolCalls: 0,
      });
    }
  }
}
setFlash(false); // always leave the flag OFF

// Summary table
console.log("\n=== summary (case | OFF ok/lat | ON ok/lat | ON route) ===");
for (const c of CASES) {
  const off = results.find((r) => r.caseId === c.id && r.arm === "off");
  const on = results.find((r) => r.caseId === c.id && r.arm === "on");
  console.log(
    `${c.id.padEnd(10)} | ${off ? `${off.ok ? "pass" : "FAIL"} ${off.latencyMs}ms` : "-"} | ${on ? `${on.ok ? "pass" : "FAIL"} ${on.latencyMs}ms` : "-"} | ${on ? `${on.routedFlash ? "flash" : "main"}${on.routeCorrect === false ? " UNEXPECTED" : ""}` : "-"}`,
  );
}
