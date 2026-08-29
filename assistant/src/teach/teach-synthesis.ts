/**
 * Turning a demonstration into a skill.
 *
 * ## Why this wakes the agent instead of calling a model directly
 *
 * A bespoke "summarise this transcript into SKILL.md" call would be shorter,
 * and it would be the wrong shape. Writing a skill is not a summarisation
 * task: it needs to know which of the owner's existing skills already cover
 * this, what the managed-skill format requires, and what the workspace calls
 * the things on screen. The agent already knows all of that, and
 * `scaffold_managed_skill` already carries the permission check, the approval
 * card, and the write. Reimplementing the tail of that here would create a
 * second way to author a skill, and the two would drift.
 *
 * It also gives the owner the thing they actually want after a demonstration:
 * a conversation. The draft lands in a real thread, so "no, the second step is
 * only when the invoice is overdue" is a reply rather than a bug report.
 *
 * ## What the agent is given
 *
 * A transcript, and the honest limits of it. Screen observation reads what was
 * visible, so the transcript is a record of what the screen SHOWED, not of
 * what the owner intended. The prompt says so, and tells the agent to ask
 * rather than invent when a step's purpose is not evident — a skill that
 * confidently encodes a guessed intention is worse than one that asks a
 * question, because it will be run unattended later.
 */

import { getLogger } from "../util/logger.js";
import type { TeachStep } from "./teach-session.js";

const log = getLogger("teach-synthesis");

/**
 * Cap on transcript characters handed to the agent.
 *
 * Screen descriptions are verbose and repetitive; a long demonstration can
 * outrun the context window, and the failure mode there is a truncated prompt
 * whose tail — the end of the procedure — is silently missing. Trimming here,
 * with a visible marker, means the agent knows the middle was elided instead
 * of believing the workflow ended early.
 */
const MAX_TRANSCRIPT_CHARS = 60_000;

export interface TeachTimeline {
  sessionId: string;
  goal: string;
  startedAt: string;
  steps: TeachStep[];
  droppedSteps: number;
}

/**
 * Render the demonstration as a numbered transcript.
 *
 * Keeps the head and the tail when it must trim: the opening steps establish
 * what is being worked on and the closing steps are how the task completes.
 * The middle of a long demonstration is usually the repetitive part, which is
 * the least costly thing to lose and the easiest for the agent to infer.
 */
export function renderTeachTranscript(timeline: TeachTimeline): string {
  const lines = timeline.steps.map((s) => {
    const where = s.appName ? ` [${s.appName}]` : "";
    return `${s.index}. (+${s.offsetSeconds}s)${where} ${s.description}`;
  });

  let body = lines.join("\n");
  if (body.length > MAX_TRANSCRIPT_CHARS) {
    const half = Math.floor(MAX_TRANSCRIPT_CHARS / 2);
    const head = body.slice(0, half);
    const tail = body.slice(body.length - half);
    body = `${head}\n\n[... middle of the demonstration elided to fit; the steps above and below are contiguous with their own ends ...]\n\n${tail}`;
  }

  if (timeline.droppedSteps > 0) {
    body += `\n\n[${timeline.droppedSteps} further step(s) were not recorded: the demonstration exceeded the retention cap.]`;
  }
  return body;
}

/**
 * The prompt handed to the agent after a demonstration.
 *
 * Deliberately does not instruct "create the skill" unconditionally. A
 * demonstration that captured nothing legible, or that shows two unrelated
 * tasks, should end in a question, and an instruction to produce a skill
 * regardless is exactly how a system ends up with confident nonsense in its
 * skill library.
 */
export function buildTeachPrompt(timeline: TeachTimeline): string {
  const stepCount = timeline.steps.length;
  return [
    `The owner just demonstrated a task on their screen so you can learn it.`,
    ``,
    `What they said they were showing you: ${timeline.goal || "(they did not say)"}`,
    `Steps observed: ${stepCount}`,
    ``,
    `Below is what the screen showed, in order. Two things about this record:`,
    `it is what was VISIBLE, not what the owner intended, and the timing`,
    `between steps is real, so a long gap usually means they were reading or`,
    `deciding rather than that a step is missing.`,
    ``,
    `--- demonstration transcript ---`,
    renderTeachTranscript(timeline),
    `--- end of transcript ---`,
    ``,
    `Write this up as a reusable skill with scaffold_managed_skill:`,
    ``,
    `- Describe the PROCEDURE, not the specific data. "Open the invoice for`,
    `  the named customer" is a skill; "Open the invoice for Acme Ltd" is a`,
    `  transcript. Turn the concrete values you saw into inputs.`,
    `- Say what the task is FOR in the description, so you can recognise when`,
    `  to offer it later.`,
    `- Note the tools or apps it needs, and any point where it would have to`,
    `  stop and ask a person.`,
    ``,
    `If the transcript does not actually show a coherent, repeatable task —`,
    `it captured too little, or it shows several unrelated things — say so and`,
    `ask what they meant to demonstrate. Do not invent the missing half. This`,
    `skill may later run without anyone watching, so a guessed step is a guess`,
    `that gets executed.`,
  ].join("\n");
}

export const TEACH_SYNTHESIS_SOURCE = "teach_demonstration";

/**
 * Tools the synthesis turn may use.
 *
 * Only skill authoring. A demonstration is consent to be watched and to have a
 * skill written; it is not consent to act on what was seen. An agent that
 * could send mail here would be acting on the contents of the owner's screen
 * as a side effect of teaching.
 */
export const TEACH_SYNTHESIS_ALLOWED_TOOLS = [
  "scaffold_managed_skill",
  "ask_question",
] as const;

export function logTeachSynthesisStart(timeline: TeachTimeline): void {
  log.info(
    {
      sessionId: timeline.sessionId,
      steps: timeline.steps.length,
      droppedSteps: timeline.droppedSteps,
    },
    "Synthesising a skill from a demonstration",
  );
}
