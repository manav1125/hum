/**
 * Scorer for the `tasks` skill — task-capture reliability. Each prompt should
 * create a work item. All signals come from the transcript (tool RESULTS aren't
 * exposed, so success is inferred from the add tool firing + a genuine
 * confirmation with no failure/hallucination language).
 */

function lastAssistantText(messages) {
  const a = [...messages].reverse().find((m) => m.role === "assistant");
  return a ? (a.textSegments || []).join(" ") : "";
}

const ADD_RE = /"name":"(task_list_add|work_item_[a-z]*add|add_task)"/i;
const ERROR_RE =
  /HTTP \d{3}|provider returned (?:a )?(?:server )?error|rejected the request|The AI provider|context length|no endpoints/i;
// Phrases that mean the add FAILED (the model admitting it couldn't).
const FAILURE_RE =
  /unable to add|couldn't add|can't add|issue with the task|problem adding|failed to (?:add|create)|task management system/i;
// A real confirmation the item was saved.
const CONFIRM_RE =
  /added|saved|created|on your (?:task|to-?do)|to your (?:task|to-?do)|queued|added to your list|got it.{0,40}(?:task|to-?do|remind)/i;
// Inventing a specific place it "lives" that the skill says not to claim.
const FAKE_PLACE_RE =
  /in (?:your |the )?(?:My Day|Today tab|["'][A-Z][a-z]+["'] (?:tab|screen|list))/;

export function scoreTasks(messages) {
  const all = JSON.stringify(messages);
  const finalText = lastAssistantText(messages);

  const addCalled = ADD_RE.test(all);
  const noError = !ERROR_RE.test(all);
  const confirmed =
    !FAILURE_RE.test(finalText) &&
    CONFIRM_RE.test(finalText) &&
    finalText.length > 15;
  const noFakePlace = !FAKE_PLACE_RE.test(finalText);

  const parts = {
    addCalled: { pass: addCalled, weight: 3 },
    confirmed: { pass: confirmed, weight: 2 },
    noError: { pass: noError, weight: 1 },
    noFakePlace: { pass: noFakePlace, weight: 1 },
  };
  const total = Object.values(parts).reduce(
    (s, p) => s + (p.pass ? p.weight : 0),
    0,
  );
  const max = Object.values(parts).reduce((s, p) => s + p.weight, 0);
  return { total, max, parts, finalText: finalText.slice(0, 160) };
}
