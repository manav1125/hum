/**
 * Objective scorer for an app-builder build turn. Reads the conversation
 * transcript and returns a component breakdown + weighted total (max 10). Every
 * component is checkable from the transcript alone — no human judgement — which
 * is exactly the property SkillOpt needs to gate edits on.
 */

function lastAssistantText(messages) {
  const a = [...messages].reverse().find((m) => m.role === "assistant");
  if (!a) return "";
  return (a.textSegments || []).join(" ");
}

// A fake app "link" the model should never emit — a real defect we chase.
const FAKE_LINK_RE =
  /(preview|vellumapp|sandbox):\/+|!?\[[^\]]*\]\((?:preview:|sandbox:|[^)]*\/apps\/|[^)]*\/preview\/[0-9a-f-]{8,})/i;
const ERROR_RE =
  /HTTP \d{3}|provider returned (?:a )?(?:server )?error|rejected the request|The AI provider|context length|no endpoints/i;

export function scoreAppBuilder(messages) {
  const all = JSON.stringify(messages);
  const finalText = lastAssistantText(messages);

  const built = /"(?:name|toolName)":"app_create"/.test(all);
  // A rendered app surfaces as a `surface` block (surfaceType card) and/or an
  // app_open/app_refresh/ui_show tool call — any of these means the user got a
  // real openable app, not just prose.
  const surfaced =
    /"type":"surface"/.test(all) ||
    /"surfaceType":"card"/.test(all) ||
    /"name":"app_refresh"/.test(all) ||
    /"name":"app_open"/.test(all) ||
    /"name":"ui_show"/.test(all) ||
    /"auto_opened":true/.test(all);
  const noFakeLink = !FAKE_LINK_RE.test(finalText);
  const noError = !ERROR_RE.test(all);
  // Completed = ends on a substantive assistant hand-off, not mid-stream/stall.
  const completed =
    finalText.length > 40 &&
    !ERROR_RE.test(finalText) &&
    !/couldn't fit the next step|tried to compact/i.test(finalText);
  // Compile proxy: tool RESULTS aren't exposed over the messages API, so we
  // can't read compile_errors directly. A surfaced app card with no error in
  // the turn is the best available signal that the build actually compiled.
  const compiledOk = built && surfaced && noError;

  const parts = {
    built: { pass: built, weight: 2 },
    compiled: { pass: compiledOk, weight: 2 },
    surfaced: { pass: surfaced, weight: 1 },
    noFakeLink: { pass: noFakeLink, weight: 2 },
    completed: { pass: completed, weight: 2 },
    noError: { pass: noError, weight: 1 },
  };
  const total = Object.values(parts).reduce(
    (s, p) => s + (p.pass ? p.weight : 0),
    0,
  );
  const max = Object.values(parts).reduce((s, p) => s + p.weight, 0);
  return { total, max, parts, finalText: finalText.slice(0, 160) };
}
