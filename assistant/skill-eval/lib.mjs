/**
 * Shared helpers for the skill-eval harness: talk to a running Cue instance
 * over its actor API, drive one user turn per task, and pull the resulting
 * transcript back for scoring.
 *
 * Config via env (with sane local defaults):
 *   CUE_EVAL_BASE   — instance base URL (default https://manav.justcue.app)
 *   CUE_EVAL_TOKEN  — actor bearer token (default: contents of ~/.cue/qa-actor-token)
 */

import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const BASE =
  process.env.CUE_EVAL_BASE?.trim() || "https://manav.justcue.app";
const API = `${BASE}/v1/assistants/self`;

function loadToken() {
  const fromEnv = process.env.CUE_EVAL_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  return readFileSync(
    path.join(os.homedir(), ".cue", "qa-actor-token"),
    "utf8",
  ).trim();
}
const TOKEN = loadToken();
const H = {
  Authorization: `Bearer ${TOKEN}`,
  "Content-Type": "application/json",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * fetch with retries + a longer connect timeout. The eval fans out many
 * concurrent long-poll loops, so transient connect timeouts are expected;
 * they must never crash a run. Returns null after exhausting retries.
 */
async function robustFetch(url, opts = {}, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      return await fetch(url, {
        ...opts,
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      if (i === tries - 1) return null;
      await sleep(2000 * (i + 1));
    }
  }
  return null;
}

/** Send one user turn on a fresh conversation keyed by `key`. */
export async function sendTask(key, content) {
  const r = await robustFetch(`${API}/messages`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({
      content,
      sourceChannel: "vellum",
      interface: "vellum",
      conversationKey: key,
    }),
  });
  if (!r || !r.ok)
    throw new Error(`sendTask ${key} -> ${r ? r.status : "network"}`);
  return r.status;
}

/** Full message list for a conversation id. Never throws. */
async function messages(conversationId) {
  const r = await robustFetch(
    `${API}/messages?conversationId=${conversationId}&limit=80`,
    { headers: H },
  );
  if (!r || !r.ok) return [];
  try {
    const j = await r.json();
    return j.messages || [];
  } catch {
    return [];
  }
}

/** Find the conversation whose first user message matches `prompt`. */
async function findConversation(prompt) {
  const r = await robustFetch(`${API}/conversations?limit=20`, { headers: H });
  if (!r || !r.ok) return null;
  const j = await r.json();
  // Use a wide needle so a per-run nonce appended to the prompt (uniquify mode)
  // actually disambiguates this run's conversation from prior identical prompts.
  const needle = prompt.slice(0, 120).toLowerCase();
  for (const c of j.conversations || []) {
    const ms = await messages(c.id);
    const u = ms.find((m) => m.role === "user");
    if (!u) continue;
    const ut = (u.textSegments || []).join(" ").toLowerCase();
    if (ut.includes(needle)) return { id: c.id, messages: ms };
  }
  return null;
}

/**
 * Poll until a task's conversation is "settled". A build is a SINGLE streaming
 * assistant message whose `contentBlocks` grow over 1–3 min while the message
 * COUNT stays constant — so settle-detection must watch the transcript's content
 * signature (total serialized size), not the message count. Settled = the
 * signature stops changing for `quietMs` AND the newest message is an assistant
 * turn. Returns the full transcript or null on timeout.
 */
export async function waitForCompletion(
  prompt,
  { maxMs = 420_000, quietMs = 60_000, pollMs = 6_000 } = {},
) {
  const start = Date.now();
  let lastSig = "";
  let lastChange = Date.now();
  let convId = null;
  while (Date.now() - start < maxMs) {
    await sleep(pollMs);
    let ms;
    if (convId) {
      ms = await messages(convId);
    } else {
      const found = await findConversation(prompt);
      if (found) {
        convId = found.id;
        ms = found.messages;
      }
    }
    if (!ms || ms.length === 0) continue;
    const sig = `${ms.length}:${JSON.stringify(ms).length}`;
    if (sig !== lastSig) {
      lastSig = sig;
      lastChange = Date.now();
      continue;
    }
    // A turn that ends on a tool_use/surface block is still running (waiting on
    // a tool result or the next step). It's only done when the newest assistant
    // message's LAST content block is text AND the transcript has been quiet —
    // this is what stops us scoring a mid-build snapshot during a long pause.
    const last = ms[ms.length - 1];
    const blocks = last?.contentBlocks || [];
    const lastBlockType = blocks.length ? blocks[blocks.length - 1].type : null;
    const endsOnText = last?.role === "assistant" && lastBlockType === "text";
    const settled = endsOnText && Date.now() - lastChange >= quietMs;
    if (settled) return ms;
  }
  return convId ? await messages(convId) : null;
}
