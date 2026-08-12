import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { err, getProviderConnection, ok, resolveProvider } from "./shared.js";

export async function run(
  input: Record<string, unknown>,
  _context: ToolContext,
): Promise<ToolExecutionResult> {
  const platform = input.platform as string | undefined;
  const query = input.query as string;
  const star = input.star === true;

  if (!query) {
    return err("query is required.");
  }

  try {
    const provider = await resolveProvider(platform);

    if (!provider.markImportantByQuery) {
      return err(
        `${provider.displayName} does not support marking messages as important.`,
      );
    }

    const account = input.account as string | undefined;
    const conn = await getProviderConnection(provider, account);
    const result = await provider.markImportantByQuery(conn, query, { star });

    if (result.marked === 0) {
      return ok("No messages matched the query. Nothing marked.");
    }

    const summary = `Marked ${result.marked} message(s) as important${
      star ? " and starred them" : ""
    } (query: ${query})`;
    if (result.truncated) {
      return ok(
        `${summary}\n\nNote: this operation was capped at 5000 messages. Additional messages matching the query may remain unmarked. Run the command again to mark more.`,
      );
    }
    return ok(summary);
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
