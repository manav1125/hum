/**
 * Standalone Vite entry for the design previews — mounts a gallery with only
 * the token stylesheet, bypassing the app router/auth so design surfaces can be
 * verified in isolation. Dev-only; not shipped in the app IA.
 *
 * `?gallery=work-loop` (default) · `?gallery=discovery` ·
 * `?gallery=mobile&screen=<key>`
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./index.css";
import { DiscoveryClarityGallery } from "./pages/design-preview/discovery-clarity-gallery";
import { MobileAuditGallery } from "./pages/design-preview/mobile-audit-gallery";
import { WorkLoopGallery } from "./pages/design-preview/work-loop-gallery";

const gallery = new URLSearchParams(globalThis.location?.search ?? "").get(
  "gallery",
);

const el = document.getElementById("design-root");
if (el) {
  createRoot(el).render(
    <StrictMode>
      {gallery === "mobile" ? (
        <MobileAuditGallery />
      ) : gallery === "discovery" ? (
        <DiscoveryClarityGallery />
      ) : (
        <WorkLoopGallery />
      )}
    </StrictMode>,
  );
}
