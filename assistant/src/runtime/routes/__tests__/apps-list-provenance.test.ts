/**
 * The Library's app listing carries the thread each app was built in.
 *
 * `apps/:id/open` already reported this, but only for one app at a time —
 * which meant a Library card could not offer the way back without opening the
 * app first. These tests drive the real `apps_list` handler (the shared ROUTES
 * array is the wire contract) rather than a helper, so the field is pinned
 * where the client actually reads it.
 *
 * The contract is "prove it or omit it": a link is emitted only for a thread
 * that still exists, because a card that links into a deleted conversation is
 * worse than a card with no link.
 */
import { describe, expect, test } from "bun:test";

import { addAppConversationId, createApp } from "../../../memory/app-store.js";
import { initializeDb } from "../../../memory/db-init.js";
import { rawRun } from "../../../memory/raw-query.js";
import { ROUTES } from "../app-management-routes.js";

initializeDb();

const listApps = ROUTES.find((r) => r.operationId === "apps_list")!;

interface ListedApp {
  id: string;
  name: string;
  sourceConversation?: { id: string; title: string | null };
}

function listed(): ListedApp[] {
  const result = listApps.handler({}) as { apps: ListedApp[] };
  return result.apps;
}

function seedConversation(id: string, title: string | null): void {
  const now = Date.now();
  rawRun(
    /*sql*/ `INSERT OR REPLACE INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    id,
    title,
    now,
    now,
  );
}

function seedApp(name: string, conversationIds: string[]): string {
  const app = createApp({
    name,
    schemaJson: "{}",
    htmlDefinition: "<p>x</p>",
  });
  for (const id of conversationIds) addAppConversationId(app.id, id);
  return app.id;
}

describe("apps_list provenance", () => {
  test("reports the thread an app was built in", () => {
    seedConversation("apps-list-live", "Q3 planning");
    const appId = seedApp("Dashboard", ["apps-list-live"]);

    const app = listed().find((a) => a.id === appId);
    expect(app?.sourceConversation).toEqual({
      id: "apps-list-live",
      title: "Q3 planning",
    });
  });

  test("carries an untitled thread as null rather than dropping the link", () => {
    seedConversation("apps-list-untitled", null);
    const appId = seedApp("Untitled source", ["apps-list-untitled"]);

    expect(listed().find((a) => a.id === appId)?.sourceConversation).toEqual({
      id: "apps-list-untitled",
      title: null,
    });
  });

  // The id stored on the app proves nothing on its own — the user may have
  // deleted the thread since. Omitting is what keeps every rendered link real.
  test("omits provenance when the stored thread no longer exists", () => {
    const appId = seedApp("Orphaned", ["apps-list-deleted"]);

    const app = listed().find((a) => a.id === appId);
    expect(app).toBeDefined();
    expect(app?.sourceConversation).toBeUndefined();
  });

  test("omits provenance for an app with no recorded thread", () => {
    const appId = seedApp("No thread", []);

    expect(
      listed().find((a) => a.id === appId)?.sourceConversation,
    ).toBeUndefined();
  });

  // `conversationIds` accumulates every thread that touched the app; the
  // first is the one that made it, which is what "From …" claims.
  test("names the originating thread, not the most recent one", () => {
    seedConversation("apps-list-first", "Where it was made");
    seedConversation("apps-list-later", "Opened again later");
    const appId = seedApp("Multi-thread", [
      "apps-list-first",
      "apps-list-later",
    ]);

    expect(listed().find((a) => a.id === appId)?.sourceConversation?.id).toBe(
      "apps-list-first",
    );
  });
});
