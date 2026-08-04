/**
 * Shared scaffolding for the mobile-v3 settings screens (task #101) — the
 * leaf shell + footnote both the layout/index file and the adapted leafs
 * compose (kept separate to avoid an import cycle between them). mv3
 * foundation consumed read-only from `@/mobile-v3`.
 */
import type { ReactNode } from "react";

import { YouScreen } from "@/mobile-v3/you/you-kit";
import { routes } from "@/utils/routes";

/** Every settings leaf is the same You-cluster push: `‹ Settings` + title. */
export function Mv3SettingsScreen({
  title,
  sub,
  tint = "blue",
  testId,
  children,
}: {
  title: string;
  sub?: ReactNode;
  tint?: "blue" | "violet" | "lavender" | "teal";
  testId?: string;
  children: ReactNode;
}) {
  return (
    <YouScreen
      tint={tint}
      testId={testId}
      back={routes.settings.root}
      backLabel="Settings"
      title={title}
      sub={sub}
    >
      {children}
    </YouScreen>
  );
}

/** Quiet centered footnote — the "this part lives on desktop" honesty line. */
export function Mv3SettingsNote({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11.5,
        color: "var(--mv3-muted)",
        textAlign: "center",
        padding: "4px 14px",
        lineHeight: 1.5,
      }}
    >
      {children}
    </div>
  );
}
