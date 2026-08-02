/**
 * Outbound links to Cue's own properties.
 *
 * These are DISPLAY destinations, not protocol identifiers — safe to rebrand.
 * (The things that must stay `vellum`: `@vellumai/*` package names, `X-Vellum-*`
 * headers, the `vellum` channel id, `com.vellum.*`, the `Vellum.<method>` CDP
 * domain, and the `_vellumDebug` window namespace.)
 *
 * This pointed at `vellum.ai/community` — the upstream fork's Discord, which is
 * not ours and which we cannot answer on. Cue has no community forum yet, so
 * the honest destination is the contact address the marketing site already
 * publishes on every page.
 */

/**
 * The one contact channel Cue actually staffs — the address justcue.ai
 * publishes in its own footer. A placeholder here would be a live link that
 * goes nowhere, which is the failure this file exists to remove.
 */
// generic-examples:ignore-next-line — reason: real product destination, not a fixture
export const CUE_SUPPORT_EMAIL = "hello@justcue.ai";

/** Where "get help / talk to us" links point. */
export const CUE_SUPPORT_URL = `mailto:${CUE_SUPPORT_EMAIL}`;

/**
 * Retained under its original name because modules outside this directory
 * import it by that name. The VALUE is what matters, and it is now Cue's.
 */
export const VELLUM_COMMUNITY_URL = CUE_SUPPORT_URL;
