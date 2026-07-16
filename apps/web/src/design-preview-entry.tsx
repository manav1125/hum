/**
 * Standalone Vite entry for the work-loop design preview — mounts the gallery
 * with only the token stylesheet, bypassing the app router/auth so the design
 * system can be verified in isolation. Dev-only; not shipped in the app IA.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "./index.css";
import { WorkLoopGallery } from "./pages/design-preview/work-loop-gallery";

const el = document.getElementById("design-root");
if (el) {
  createRoot(el).render(
    <StrictMode>
      <WorkLoopGallery />
    </StrictMode>,
  );
}
