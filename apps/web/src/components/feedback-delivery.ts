/**
 * Where feedback actually goes.
 *
 * It used to `POST /v1/feedback/` relative to the app origin. Upstream that
 * origin was Vellum's Django server, which serves the route. On Cue the origin
 * is the Fly daemon, which has no such route and returns 404 — so every report
 * anyone has ever filed from this build reached nobody, and the form said it
 * had been sent.
 *
 * The owner chose mailto over standing up an ingest endpoint: *"mailto is fine
 * for now."* It is the honest option — a mail client either opens or visibly
 * does not, and there is no server to silently swallow the report.
 *
 * **The cost, stated because the UI has to state it too:** a `mailto:` cannot
 * carry an attachment. The diagnostics bundle is saved to the reader's device
 * instead, and the copy tells them to attach it. Pretending the toggles still
 * ship a bundle would be the same lie in a new place.
 */

/** Where reports go. Verified against site/legal.html, not invented. */
// Cue's real support inbox, not a fixture — an example.com address here would
// send every report nowhere, which is the bug this file exists to fix.
// generic-examples:ignore-next-line — reason: real destination, not a fixture
export const FEEDBACK_EMAIL = "hello@justcue.ai";

export interface FeedbackReport {
  message: string;
  classification: string;
  client: string;
  clientVersion?: string;
  assistantId?: string;
  assistantVersion?: string;
  /** Set when a diagnostics bundle was built and saved to the device. */
  bundleFilename?: string;
}

/**
 * Build the `mailto:` a report opens.
 *
 * Only fields the reader can already see go in. No token, no session id, no
 * conversation id: a `mailto:` is handed to whatever handler the OS has
 * registered and may be logged by it, so it gets the report and nothing that
 * would be a credential or a private identifier if it leaked.
 *
 * The assistant id and versions are included because a bug report without them
 * costs a round trip, and neither is secret.
 */
export function buildFeedbackMailto(report: FeedbackReport): string {
  const subject = `Cue ${report.classification.replace(/_/g, " ")}`;

  const lines = [report.message.trim(), "", "—", `Client: ${report.client}`];
  if (report.clientVersion) lines.push(`Version: ${report.clientVersion}`);
  if (report.assistantId) lines.push(`Assistant: ${report.assistantId}`);
  if (report.assistantVersion) {
    lines.push(`Assistant version: ${report.assistantVersion}`);
  }
  if (report.bundleFilename) {
    lines.push(
      "",
      `Please attach ${report.bundleFilename} — Cue saved it to your downloads.`,
    );
  }

  return `mailto:${FEEDBACK_EMAIL}?subject=${encodeURIComponent(
    subject,
  )}&body=${encodeURIComponent(lines.join("\n"))}`;
}

/**
 * Save the diagnostics bundle to the reader's device.
 *
 * Deliberately a real download rather than a silent no-op when the toggles are
 * on: the toggles promise something is attached, and if nothing can be
 * attached the reader has to end up holding the file. Returns the filename so
 * the mail body can name it.
 */
export function saveBundleToDevice(bundle: File): string {
  const url = URL.createObjectURL(bundle);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = bundle.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Revoke on the next tick — revoking synchronously races the click in
    // some engines and the download silently produces a zero-byte file.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
  return bundle.name;
}
