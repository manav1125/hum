/**
 * Tests for `SkillCard` action controls.
 *
 * The card is a `role="button"` whose primary click fires `onSelect`. The
 * trailing icon-only action button (remove for installed skills, install for
 * catalog skills) must:
 *   - expose the correct `aria-label`
 *   - fire its own handler (`onRemove` / `onInstall`)
 *   - NOT also bubble up to `onSelect` (stopPropagation)
 *
 * Mounted via `@testing-library/react` (happy-dom — see
 * `apps/web/test-setup.ts`).
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import { cleanup, fireEvent, render } from "@testing-library/react";

import { SkillCard } from "@/domains/intelligence/components/skills/skill-card.js";
import type { SkillInfo } from "@/domains/intelligence/skills/types.js";

afterEach(() => {
  cleanup();
});

function makeSkill(overrides: Partial<SkillInfo> = {}): SkillInfo {
  return {
    id: "skill-1",
    name: "Test Skill",
    description: "A skill used in tests",
    emoji: "\u{1F9E9}",
    kind: "installed",
    status: "enabled",
    origin: "custom",
    category: "general",
    ...overrides,
  };
}

function getButton(label: string): HTMLButtonElement {
  const match = document.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
  if (!match) {
    throw new Error(`expected a button with aria-label="${label}"`);
  }
  return match;
}

describe("SkillCard", () => {
  test("removable skill: trash control removes without selecting", () => {
    const onSelect = mock(() => {});
    const onRemove = mock(() => {});

    render(
      <SkillCard
        skill={makeSkill({ kind: "installed" })}
        onSelect={onSelect}
        onRemove={onRemove}
      />,
    );

    const remove = getButton("Remove skill");
    fireEvent.click(remove);

    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  test("catalog skill: install control installs without selecting", () => {
    const onSelect = mock(() => {});
    const onInstall = mock(() => {});

    render(
      <SkillCard
        skill={makeSkill({ kind: "catalog", status: "available" })}
        onSelect={onSelect}
        onInstall={onInstall}
      />,
    );

    const install = getButton("Install skill");
    fireEvent.click(install);

    expect(onInstall).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  test("bundled skill: trash control is disabled and does not remove", () => {
    const onSelect = mock(() => {});
    const onRemove = mock(() => {});

    render(
      <SkillCard
        skill={makeSkill({ kind: "bundled", origin: "vellum" })}
        onSelect={onSelect}
        onRemove={onRemove}
      />,
    );

    const remove = getButton("Bundled skill cannot be removed");
    fireEvent.click(remove);

    expect(onRemove).not.toHaveBeenCalled();
  });
});
