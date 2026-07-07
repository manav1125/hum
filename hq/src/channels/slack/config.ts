/**
 * Cue HQ — Slack channel configuration (WS4).
 *
 * One org-level Slack app serves every customer workspace (multi-workspace
 * OAuth). Like stripe.ts, this module runs cleanly in "not configured"
 * mode: when the env vars are unset nothing throws at import or boot time —
 * the Slack routes answer 503 and the rest of HQ is unaffected.
 *
 * Env contract:
 *   SLACK_SIGNING_SECRET — the app's signing secret (request verification;
 *                          required for the /slack/events + /slack/commands
 *                          routes to be live at all)
 *   SLACK_CLIENT_ID      — OAuth client id (multi-workspace install flow)
 *   SLACK_CLIENT_SECRET  — OAuth client secret
 *   SLACK_BOT_TOKEN      — optional single-workspace dev fallback: used only
 *                          when an install row has no stored bot token
 */

export function slackSigningSecret(): string {
  return process.env.SLACK_SIGNING_SECRET ?? "";
}

/** Events + slash commands are only live when requests can be verified. */
export function isSlackConfigured(): boolean {
  return !!slackSigningSecret();
}

/** The install/OAuth flow additionally needs the app's OAuth credentials. */
export function isSlackOAuthConfigured(): boolean {
  return (
    isSlackConfigured() &&
    !!process.env.SLACK_CLIENT_ID &&
    !!process.env.SLACK_CLIENT_SECRET
  );
}

export function slackClientId(): string {
  return process.env.SLACK_CLIENT_ID ?? "";
}

export function slackClientSecret(): string {
  return process.env.SLACK_CLIENT_SECRET ?? "";
}

/** Dev fallback bot token (empty when unset). */
export function slackDefaultBotToken(): string {
  return process.env.SLACK_BOT_TOKEN ?? "";
}

/** Bot scopes requested at install. Keep minimal — v1 surface only. */
export const SLACK_OAUTH_SCOPES = [
  "app_mentions:read", // app_mention events
  "chat:write", // post replies
  "im:history", // message.im events
  "commands", // /cue
].join(",");
