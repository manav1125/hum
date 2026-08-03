// Slash command catalog — web-platform subset of ChatSlashCommandCatalog.allCommands.

/** Matches a bare `/` or `/filter` occupying the entire input. */
export const SLASH_PREFIX_RE = /^\/(\w*)$/;

export type SlashCommandSelectionBehavior = "autoSend" | "insertTrailingSpace";

export interface SlashCommand {
  name: string;
  description: string;
  selectionBehavior: SlashCommandSelectionBehavior;
  /**
   * The command's output names the inference vendor. The daemon refuses
   * these on a managed instance (`daemon/conversation-slash.ts`), so the
   * popup must not advertise them there either — every entry in this menu
   * is one click from being sent, and `autoSend` means no confirmation
   * step in which a user could reconsider.
   */
  vendorDisclosing?: boolean;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    name: "commands",
    description: "List all available commands",
    selectionBehavior: "autoSend",
  },
  {
    name: "compact",
    description: "Force context compaction immediately",
    selectionBehavior: "autoSend",
  },
  {
    name: "clean",
    description:
      "Strip injected runtime context and reset memory injection state",
    selectionBehavior: "autoSend",
  },
  {
    name: "models",
    description: "List all available models",
    selectionBehavior: "autoSend",
    vendorDisclosing: true,
  },
  {
    name: "status",
    description: "Show conversation status and context usage",
    selectionBehavior: "autoSend",
  },
  {
    name: "btw",
    description: "Ask a side question while the assistant is working",
    selectionBehavior: "insertTrailingSpace",
  },
  {
    name: "background",
    description: "Hand this off to a background run instead of a chat turn",
    selectionBehavior: "insertTrailingSpace",
  },
  {
    name: "later",
    description: "Same as /background — hand it off and read the result later",
    selectionBehavior: "insertTrailingSpace",
  },
];

// ---------------------------------------------------------------------------
// Background-run commands
// ---------------------------------------------------------------------------

/**
 * `/background` and `/later` are handled ENTIRELY on the client: they never
 * reach the daemon's chat endpoint as text. The composer strips the command
 * and dispatches the remainder as an autonomous work-item run instead of a
 * foreground turn. (Every other command in the catalog above is server-side —
 * the daemon's `ChatSlashCommandCatalog` parses those from the message body.)
 *
 * Matched case-insensitively, and only at the very start of the input, so a
 * message that merely mentions "/background" mid-sentence still sends normally.
 */
const BACKGROUND_COMMAND_RE = /^\/(?:background|later)(?:\s+|$)/i;

/** The command names routed to a background run (used for user-facing copy). */
export const BACKGROUND_COMMAND_NAMES = ["background", "later"] as const;

/**
 * If `text` opens with a background command, return everything after it
 * (trimmed — possibly an empty string when the user sent a bare `/background`).
 * Returns `null` when this is an ordinary message, which is the signal to send
 * it as a normal foreground turn.
 */
export function stripBackgroundCommand(text: string): string | null {
  const match = BACKGROUND_COMMAND_RE.exec(text.trimStart());
  if (!match) return null;
  return text.trimStart().slice(match[0].length).trim();
}

/** The commands offerable on this instance. See `SlashCommand.vendorDisclosing`. */
export function availableCommands(hideVendor: boolean): SlashCommand[] {
  if (!hideVendor) return SLASH_COMMANDS;
  return SLASH_COMMANDS.filter((c) => !c.vendorDisclosing);
}

/** Returns commands whose name starts with `filter` (case-insensitive). Empty filter returns all. */
export function filteredCommands(
  filter: string,
  hideVendor = false,
): SlashCommand[] {
  const available = availableCommands(hideVendor);
  if (!filter) return available;
  const lower = filter.toLowerCase();
  return available.filter((c) => c.name.startsWith(lower));
}

/** Returns the input text to set after selecting a command. */
export function selectedInputText(command: SlashCommand): string {
  return command.selectionBehavior === "autoSend"
    ? `/${command.name}`
    : `/${command.name} `;
}
