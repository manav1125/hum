/**
 * SkillDetailSheet model + honesty rules (frame 57):
 *  · consent rows derive only from the declared capability manifest
 *    (✓ allow for connectors/network, ‖ asks-first for writes/secrets);
 *  · catalog skills declare no manifest → consent is null, never invented;
 *  · meta (version/installs/license) renders only where the API provides it;
 *  · confirm copy references asks-first only when elevated rows exist;
 *  · the confirm card renders only in the confirm phase.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";

import type { SkillInfo } from "@/domains/intelligence/skills/types";
import { skillsByIdHistoryGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import type { MarketplaceItem } from "@/pages/marketplace/use-marketplace";

import {
  capabilityRows,
  catalogDetailModel,
  confirmCopy,
  marketplaceDetailModel,
  SkillDetailSheet,
} from "./skill-detail-sheet";

afterEach(cleanup);

const baseItem: MarketplaceItem = {
  id: "cue-official/investor-update",
  name: "investor-update",
  displayName: "Investor update writer",
  description: "Turns your month into a Vellum investor update.",
  source: "cue-official",
  sourceLabel: "Cue official",
  skillPath: "skills/investor-update",
  ref: "main",
  emoji: "📊",
  license: "MIT",
  capabilities: {
    secrets: [],
    connectors: ["Gmail"],
    network: ["api.example.com"],
    writes: ["email"],
  },
};

describe("capabilityRows", () => {
  test("splits declared manifest into allow vs asks-first", () => {
    const rows = capabilityRows(baseItem.capabilities);
    expect(rows).toEqual([
      { label: "Use Gmail", elevated: false },
      { label: "Reach api.example.com", elevated: false },
      { label: "Write to email", elevated: true },
    ]);
  });

  test("empty manifest yields no rows (declared-empty, not unknown)", () => {
    expect(
      capabilityRows({ secrets: [], connectors: [], network: [], writes: [] }),
    ).toEqual([]);
  });
});

describe("marketplaceDetailModel", () => {
  test("official badge for cue-official, community otherwise", () => {
    expect(marketplaceDetailModel(baseItem).badge).toBe("Cue official");
    expect(marketplaceDetailModel(baseItem).official).toBe(true);
    const community = marketplaceDetailModel({
      ...baseItem,
      source: "someone/skills",
    });
    expect(community.badge).toBe("Community");
    expect(community.official).toBe(false);
  });

  test("uses line from declared connectors; source from address", () => {
    const model = marketplaceDetailModel(baseItem);
    expect(model.usesLine).toBe("Uses: Gmail");
    expect(model.sourceLine).toBe("cue-official/skills/investor-update");
    // Prose is rebranded for display.
    expect(model.description).toContain("Cue investor update");
  });

  test("no connectors → no uses line; version/installs never invented", () => {
    const model = marketplaceDetailModel({
      ...baseItem,
      capabilities: { secrets: [], connectors: [], network: [], writes: [] },
      license: undefined,
    });
    expect(model.usesLine).toBeNull();
    expect(model.metaLine).toBeNull();
  });
});

describe("catalogDetailModel", () => {
  const skill = {
    id: "s1",
    name: "Daily brief",
    origin: "vellum",
    kind: "catalog",
    version: "1.2",
    installs: 4200,
  } as unknown as SkillInfo;

  test("consent is null — catalog skills declare no manifest", () => {
    expect(catalogDetailModel(skill).consent).toBeNull();
  });

  test("meta from real version + installs; origin label reused", () => {
    const model = catalogDetailModel(skill);
    expect(model.metaLine).toBe("v1.2 · 4,200 installs");
    expect(model.badge).toBe("Cue official");
  });
});

describe("confirmCopy", () => {
  test("references asks-first only when elevated rows exist", () => {
    const withElevated = marketplaceDetailModel(baseItem);
    expect(confirmCopy(withElevated)).toContain("always need your OK");

    const declaredEmpty = marketplaceDetailModel({
      ...baseItem,
      capabilities: { secrets: [], connectors: [], network: [], writes: [] },
    });
    expect(confirmCopy(declaredEmpty)).toContain(
      "declares no elevated capabilities",
    );

    const catalog = catalogDetailModel({
      id: "s1",
      name: "X",
      origin: "vellum",
      kind: "catalog",
    } as unknown as SkillInfo);
    expect(confirmCopy(catalog)).toContain("asks at run time");
  });
});

describe("SkillDetailSheet phases", () => {
  test("detail phase shows Get, confirm phase shows the confirm card", () => {
    const model = marketplaceDetailModel(baseItem);
    const { rerender } = render(
      createElement(SkillDetailSheet, {
        open: true,
        model,
        installed: false,
        confirming: false,
        planPending: false,
        plan: null,
        installing: false,
        error: null,
        onGet: () => {},
        onConfirm: () => {},
        onClose: () => {},
      }),
    );
    expect(screen.getByText("Get")).toBeTruthy();
    expect(screen.queryByText("Install this skill?")).toBeNull();
    // Consent vocabulary present with the amber ask-first suffix.
    expect(screen.getByText(/Write to email — always asks first/)).toBeTruthy();

    rerender(
      createElement(SkillDetailSheet, {
        open: true,
        model,
        installed: false,
        confirming: true,
        planPending: false,
        plan: null,
        installing: false,
        error: null,
        onGet: () => {},
        onConfirm: () => {},
        onClose: () => {},
      }),
    );
    expect(screen.getByText("Install this skill?")).toBeTruthy();
    expect(screen.getByText("Install")).toBeTruthy();
    expect(screen.queryByText("Get")).toBeNull();
  });

  test("history is wired, collapsed, and only for a skill that exists here", () => {
    const model = catalogDetailModel({
      id: "daily-briefing",
      name: "Daily Briefing",
      origin: "vellum",
      kind: "installed",
    } as unknown as SkillInfo);
    const props = {
      open: true,
      model,
      installed: true,
      confirming: false,
      planPending: false,
      plan: null,
      installing: false,
      error: null,
      onGet: () => {},
      onConfirm: () => {},
      onClose: () => {},
    };

    // No local identity (an un-installed marketplace card) → no read at all,
    // which is why the sheet renders fine outside a query provider above.
    const bare = render(createElement(SkillDetailSheet, props));
    expect(screen.queryByText("History")).toBeNull();
    bare.unmount();

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    client.setQueryData(
      skillsByIdHistoryGetQueryKey({
        path: { assistant_id: "a1", id: "daily-briefing" },
      }),
      {
        skillId: "daily-briefing",
        truncatedByCompaction: false,
        revisions: [
          {
            id: "5fbc2e29",
            changedAt: "2026-07-22T08:55:31Z",
            files: ["SKILL.md", "scripts/setup.ts"],
            diff: "",
          },
        ],
      },
    );
    render(
      createElement(
        QueryClientProvider,
        { client },
        createElement(SkillDetailSheet, {
          ...props,
          assistantId: "a1",
          skillId: "daily-briefing",
        }),
      ),
    );
    expect(screen.getByText("History")).toBeTruthy();
    expect(screen.getByText("1 change")).toBeTruthy();
    // Secondary: the revision list stays behind the disclosure.
    expect(screen.queryByText("SKILL.md +1 more")).toBeNull();
  });

  test("installed detail is read-only — no Get, no confirm", () => {
    render(
      createElement(SkillDetailSheet, {
        open: true,
        model: marketplaceDetailModel({ ...baseItem, installed: true }),
        installed: true,
        confirming: false,
        planPending: false,
        plan: null,
        installing: false,
        error: null,
        onGet: () => {},
        onConfirm: () => {},
        onClose: () => {},
      }),
    );
    expect(screen.getByText("✓ Installed")).toBeTruthy();
    expect(screen.queryByText("Get")).toBeNull();
    expect(screen.queryByText("Install this skill?")).toBeNull();
  });
});
