/**
 * Cross-tenant ownership guard for Composio connected accounts.
 *
 * WHY THIS EXISTS. The Composio API key in `connectors.json` is an
 * ORGANISATION-wide credential: the same key is seeded into every Cue instance
 * (`hq/src/provisioning.ts` → `HQ_COMPOSIO_API_KEY`), and it can list and proxy
 * through EVERY Cue customer's connected accounts. The only thing separating
 * one customer's Gmail from another's is the `user_ids=` filter the callers put
 * on the request. A filter is a request-side hope, not a boundary: if the query
 * param is ever renamed upstream, dropped in a refactor, or silently ignored
 * for an unrecognised value, the request keeps succeeding and simply returns
 * somebody else's accounts — and the id from row 0 then goes straight into
 * `connected_account_id` on a proxy call that reads real mail.
 *
 * So we do not trust that the filter was applied. We verify the answer.
 *
 * Lives in its own module because both the OAuth proxy path
 * (`composio-oauth.ts`) and the capability snapshot
 * (`capabilities/composio-connection-status.ts`) need it, and those two
 * already import each other.
 */

import { getLogger } from "../util/logger.js";

const log = getLogger("composio-account-ownership");

/**
 * A connected-account row as returned by `GET /connected_accounts`. Only the
 * field the ownership guard reads is modelled; callers intersect their own.
 */
export interface ComposioAccountRow {
  user_id?: unknown;
}

/**
 * Keep only the connected-account rows this install actually owns.
 *
 * A row whose `user_id` is present and is NOT ours is dropped and logged at
 * error level, and can never become a `connected_account_id`.
 *
 * FAIL DIRECTION. A row that carries no `user_id` at all is kept, with a
 * warning. Dropping those would turn an upstream response-shape change into a
 * total, silent connector outage ("nothing is connected") — the failure mode
 * this codebase has been bitten by repeatedly. A present-and-different
 * `user_id` is unambiguous evidence of a foreign row and is refused outright;
 * an absent one is a schema-drift signal, not evidence of a leak.
 *
 * @param items - Rows from a `connected_accounts` response.
 * @param ownUserId - This install's Composio user id (`connectors.json`).
 * @param context - Call-site label, for the log line only.
 */
export function selectOwnedAccounts<T extends ComposioAccountRow>(
  items: readonly T[],
  ownUserId: string,
  context: string,
): T[] {
  const kept: T[] = [];
  let foreign = 0;
  let unlabelled = 0;
  for (const item of items) {
    const rowUser = item.user_id;
    if (typeof rowUser === "string" && rowUser.length > 0) {
      if (rowUser !== ownUserId) {
        foreign++;
        continue;
      }
    } else {
      unlabelled++;
    }
    kept.push(item);
  }
  if (foreign > 0) {
    log.error(
      { context, foreign, kept: kept.length },
      "Composio returned connected accounts belonging to another user — " +
        "dropped. The user_ids filter is not being honoured; treat this as a " +
        "cross-tenant isolation failure.",
    );
  }
  if (unlabelled > 0) {
    log.warn(
      { context, unlabelled },
      "Composio connected-account rows carry no user_id — ownership could " +
        "not be verified for them (upstream response shape may have changed)",
    );
  }
  return kept;
}
