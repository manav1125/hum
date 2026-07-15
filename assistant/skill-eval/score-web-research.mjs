/**
 * Scorer for the `web-research` skill — did the agent actually search the live
 * web and answer with a real source. All signals from the transcript.
 */

function lastAssistantText(messages) {
  const a = [...messages].reverse().find((m) => m.role === "assistant");
  return a ? (a.textSegments || []).join(" ") : "";
}

// Search fires either as a top-level tool OR inside skill_execute as
// `"tool":"tavily_search"`.
const SEARCH_RE =
  /"(?:name|tool)":"(web_search|tavily_search|search_web|brave_search|perplexity_search)"/i;
// Only clear-cut "search is broken / no key" admissions — kept tight so it
// doesn't false-positive on ordinary prose.
const KEY_ERROR_RE =
  /(?:web ?search|search (?:tool|capability|provider))[^.]{0,40}(?:isn'?t|is not|not)\s+(?:configured|available|set up)|missing (?:the )?(?:api )?keys? for|no search provider|couldn'?t (?:fetch|run|perform)[^.]{0,30}search/i;
const ERROR_RE =
  /HTTP \d{3}|provider returned (?:a )?(?:server )?error|rejected the request/i;
// A citation: a URL, or a markdown link, or a bracketed source.
const SOURCE_RE =
  /https?:\/\/[^\s)]+|\]\((https?:)?\/\/|\[(?:source|wikipedia|[^\]]*\.(?:com|org|ai|io|net))\]/i;

export function scoreWebResearch(messages) {
  const all = JSON.stringify(messages);
  const finalText = lastAssistantText(messages);

  const searchCalled = SEARCH_RE.test(all);
  const noKeyError = !KEY_ERROR_RE.test(all);
  const hasSource = SOURCE_RE.test(finalText);
  const answered =
    finalText.length > 40 &&
    !ERROR_RE.test(finalText) &&
    !KEY_ERROR_RE.test(finalText);

  const parts = {
    searchCalled: { pass: searchCalled, weight: 2 },
    hasSource: { pass: hasSource, weight: 2 },
    answered: { pass: answered, weight: 2 },
    noKeyError: { pass: noKeyError, weight: 1 },
  };
  const total = Object.values(parts).reduce(
    (s, p) => s + (p.pass ? p.weight : 0),
    0,
  );
  const max = Object.values(parts).reduce((s, p) => s + p.weight, 0);
  return { total, max, parts, finalText: finalText.slice(0, 160) };
}
