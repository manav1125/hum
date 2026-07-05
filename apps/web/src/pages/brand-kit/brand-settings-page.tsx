/**
 * Settings → Brand — the Brand Kit surface as a settings tab
 * (`/assistant/settings/brand`, mock header `cue.app/settings/brand`).
 *
 * Renders inside SettingsLayout's SidebarShell content area, so it only needs
 * to provide its own inner padding + max width and delegate everything to the
 * shared BrandKitStudio orchestrator (chooser → path → review, all wired to
 * the daemon brand-profile routes).
 */

import { BrandKitStudio } from "./brand-kit-page";

export function BrandSettingsPage() {
  return (
    <div style={{ maxWidth: 980, margin: "0 auto", padding: "8px 4px 40px" }}>
      <BrandKitStudio />
    </div>
  );
}
