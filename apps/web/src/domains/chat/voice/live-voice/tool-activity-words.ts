/**
 * What to SAY while the call is thinking — v35's "the tool it's touching named
 * in words" ("Checking the pricing model…").
 *
 * The rule this file exists to enforce: **the words are chosen from a real tool
 * name, or they are not chosen at all.** The daemon sends the registered name
 * of a tool that actually started executing (`tool_activity`, see
 * `protocol.ts`); this maps that name to a phrase describing what that tool
 * does. It never guesses, never interpolates the user's content into a
 * sentence, and never invents an object for a verb — "Checking the pricing
 * model…" while the turn is searching the web is a caption that is confidently
 * wrong, which is the defect class the whole surface is being rebuilt to avoid.
 *
 * There are therefore three honest outcomes, and the caller must be able to
 * tell them apart:
 *
 *  1. A tool ran and we have words for it → the phrase.
 *  2. A tool ran and we have no words for it → {@link UNNAMED_TOOL_WORDS}.
 *     "Using a tool…" is a smaller claim than a guess, and still true.
 *  3. No tool event at all → `null`, and the caller says what it does know,
 *     which is that Cue is thinking. This is the resting case on the realtime
 *     engine (whose function calls never leave the provider session) and
 *     against any daemon that does not send the frame.
 *
 * Adding a tool here is a copy decision, not a mechanical one: only add a
 * phrase you would be willing to show a user at the exact moment that tool is
 * running.
 */

/** Case 2 — a tool is genuinely running, but this file has no phrase for it. */
export const UNNAMED_TOOL_WORDS = "Using a tool…";

/** Case 3 — nothing is known beyond the phase itself. */
export const THINKING_WORDS = "Thinking…";

/**
 * Registered tool name → what to say while it runs. Names are the real ones
 * (`assistant/src/tools/**`, and the bundled skills' `TOOLS.json`), so a rename
 * on the daemon side degrades to {@link UNNAMED_TOOL_WORDS} rather than to a
 * wrong sentence.
 */
const TOOL_WORDS: Readonly<Record<string, string>> = {
  // Looking things up
  web_search: "Searching the web…",
  web_fetch: "Reading the page…",
  recall: "Looking through what it remembers…",
  remember: "Saving that to memory…",

  // Your lists and your time
  task_list_add: "Adding that to your list…",
  task_list_show: "Checking your list…",
  task_list_update: "Updating your list…",
  task_list_remove: "Taking that off your list…",
  task_queue_run: "Starting that off…",
  schedule_create: "Setting the reminder…",
  schedule_list: "Checking what's scheduled…",
  schedule_update: "Moving the reminder…",
  schedule_delete: "Cancelling the reminder…",
  followup_create: "Noting the follow-up…",
  followup_list: "Checking your follow-ups…",
  followup_resolve: "Closing the follow-up…",

  // People and messages
  contact_search: "Looking up the contact…",
  contact_merge: "Merging the contacts…",
  google_contacts: "Checking your contacts…",
  messaging_list_conversations: "Checking your messages…",
  messaging_read: "Reading the message…",
  messaging_search: "Searching your messages…",
  messaging_send: "Sending the message…",
  messaging_draft: "Drafting the reply…",
  messaging_mark_read: "Marking it read…",
  messaging_archive_by_sender: "Filing those messages…",
  messaging_sender_digest: "Going through that sender…",
  messaging_analyze_style: "Reading how you write…",

  // Files and the workspace
  file_read: "Reading the file…",
  file_list: "Looking through your files…",
  file_write: "Writing the file…",
  file_edit: "Editing the file…",
  host_file_read: "Reading the file…",
  host_file_write: "Writing the file…",
  host_file_edit: "Editing the file…",
  bash: "Running a command…",
  host_bash: "Running a command…",

  // Connected apps
  make_authenticated_request: "Calling a connected app…",
  run_authenticated_command: "Calling a connected app…",
  COMPOSIO_SEARCH_TOOLS: "Finding the right connected app…",
  COMPOSIO_EXECUTE_TOOL: "Working in a connected app…",
  COMPOSIO_MULTI_EXECUTE_TOOL: "Working in your connected apps…",

  // Its own capabilities
  skill_search: "Finding the right skill…",
  skill_load: "Loading the skill…",
  skill_execute: "Running the skill…",

  // What it puts on screen
  ui_show: "Putting that on screen…",
  ui_update: "Updating what's on screen…",
  ui_dismiss: "Clearing the screen…",

  // Asking you
  ask_question: "Checking with you…",
};

/**
 * The words for the thinking state.
 *
 * @param toolName registered tool name from a `tool_activity` frame, or `null`
 *   when the client has not been told anything.
 * @returns a phrase safe to show at this instant, or `null` when the only
 *   honest thing to say is that it is thinking (see {@link THINKING_WORDS}).
 */
export function toolActivityWords(toolName: string | null): string | null {
  if (!toolName) return null;
  const trimmed = toolName.trim();
  if (!trimmed) return null;
  return TOOL_WORDS[trimmed] ?? UNNAMED_TOOL_WORDS;
}

/**
 * The label the thinking state renders — always a real sentence, never empty,
 * so a missing signal degrades to a truthful wait instead of a blank screen.
 */
export function thinkingLabel(toolName: string | null): string {
  return toolActivityWords(toolName) ?? THINKING_WORDS;
}
