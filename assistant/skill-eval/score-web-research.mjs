/**
 * Scorer for the `web-research` skill — did the agent actually search the live
 * web and answer with a real source. All signals from the transcript.
 */

function lastAssistantText(messages) {
  const a = [...messages].reverse().find((m) => m.role === "assistant");
  return a ? (a.textSegments || []).join(" ") : "";
}

const SEARCH_RE =
  /"name":"(web_search|tavily_search|search_web|brave_search)"/i;
const KEY_ERROR_RE =
  /isn'?t configured|not configured|missing (?:the )?(?:api )?keys?|no (?:web )?search|search (?:capability|isn'?t|is not) (?:available|configured)|set (?:that|it) up/i;
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
