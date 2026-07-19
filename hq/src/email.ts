/**
 * Cue HQ — transactional email via the Resend API (plain fetch, zero deps,
 * mirroring stripe.ts / openrouter.ts style).
 *
 * The four templates are lifted from the designed site's `site/emails.html`
 * (single column, 560px, logo top, one primary button each) — the HTML here
 * reuses the designer's markup with {{placeholder}} values filled in; do not
 * restyle it without updating the design source.
 *
 * Runs cleanly in "not configured" mode: without RESEND_API_KEY nothing is
 * sent — the would-be email (recipient, subject, and crucially the action
 * link) is logged at info level so dev flows are testable end to end.
 * IMPORTANT: callers must record log-only sends DISTINCTLY (sent:false,
 * reason "email_not_configured") — never as a "*_sent" audit event. The
 * 2026-07-19 alpha audit found prod events claiming 11 signin emails
 * "sent" that never left the box because the key was unset (P0-1).
 *
 * Env contract:
 *   RESEND_API_KEY — Resend secret (re_…). Unset ⇒ log-only mode.
 *   EMAIL_FROM     — From header (default "Cue <hello@justcue.ai>").
 */

const RESEND_API_BASE = "https://api.resend.com";

export function isEmailConfigured(): boolean {
  return !!process.env.RESEND_API_KEY;
}

function emailFrom(): string {
  return process.env.EMAIL_FROM ?? "Cue <hello@justcue.ai>";
}

// ── template shell (site/emails.html, verbatim styles) ───────────────────

function esc(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

interface EmailParts {
  head: string;
  body: string;
  button: { label: string; href: string };
  /** Optional "Credits remaining" box (credits-low template). */
  balance?: string;
  /** Optional quiet PS line under the button. */
  ps?: string;
  /** Footer "why you're receiving this" line. */
  legal: string;
}

function renderEmailHtml(p: EmailParts): string {
  const balanceHtml = p.balance
    ? `<div style="background:#F5F7FA;border:1px solid #E5E9F0;border-radius:11px;padding:14px 16px;margin-top:18px;display:flex;align-items:baseline;justify-content:space-between"><span style="font-size:13px;color:#5A6672">Credits remaining</span><b style="font-size:18px;color:#101828">${esc(p.balance)}</b></div>`
    : "";
  const psHtml = p.ps
    ? `<p style="font-size:13px;line-height:1.6;color:#8D99A5;margin:20px 0 0">${p.ps}</p>`
    : "";
  return `<!doctype html>
<html><body style="margin:0;background:#E7EAEF;font-family:'DM Sans',system-ui,-apple-system,sans-serif;-webkit-font-smoothing:antialiased;padding:24px 8px">
<div style="max-width:560px;margin:0 auto;background:#fff;border:1px solid #E1E5EC;border-radius:14px;overflow:hidden">
  <div style="padding:34px 40px 8px">
    <div style="display:flex;align-items:center;gap:9px">
      <span style="width:30px;height:30px;border-radius:9px;background:#101828;display:inline-flex;align-items:center;justify-content:center;position:relative"><span style="font-size:16px;font-weight:600;color:#fff">C</span><span style="position:absolute;width:5px;height:5px;border-radius:50%;background:#3D6EE8;right:6px;bottom:8px"></span></span>
      <b style="font-size:19px;font-weight:500;letter-spacing:-.8px;color:#101828">cue<span style="color:#3D6EE8">.</span></b>
    </div>
  </div>
  <div style="padding:22px 40px 34px">
    <div style="font-size:21px;font-weight:600;letter-spacing:-.4px;color:#101828;line-height:1.25">${esc(p.head)}</div>
    <p style="font-size:15px;line-height:1.7;color:#43505F;margin:16px 0 0">${esc(p.body)}</p>
    ${balanceHtml}
    <a href="${esc(p.button.href)}" style="display:block;text-align:center;background:#3D6EE8;color:#fff;border-radius:11px;padding:14px;font-size:15px;font-weight:600;text-decoration:none;margin-top:24px">${esc(p.button.label)}</a>
    ${psHtml}
  </div>
  <div style="background:#FAFBFC;border-top:1px solid #EDF0F4;padding:18px 40px;font-size:11.5px;color:#98A2AF;line-height:1.6">
    © 2026 Cue · <a href="mailto:hello@justcue.ai" style="color:#5A6672;text-decoration:none">hello@justcue.ai</a><br>${esc(p.legal)}
  </div>
</div>
</body></html>`;
}

// ── the four designed templates ──────────────────────────────────────────

export interface EmailMessage {
  subject: string;
  html: string;
  /** The primary action link — logged in unconfigured mode. */
  link: string;
}

/** 01 · WELCOME — sent when provisioning completes (carries the magic link). */
export function welcomeEmail(params: {
  firstName: string;
  magicLink: string;
  signinUrl: string;
}): EmailMessage {
  return {
    subject: "Your Cue is ready.",
    link: params.magicLink,
    html: renderEmailHtml({
      head: `${params.firstName} — your Cue is live.`,
      body: "It's already private, already yours. This link signs you in on any device:",
      button: { label: "Open Cue", href: params.magicLink },
      ps: `Save this email — the link is your key. You can request a fresh one anytime at ${esc(params.signinUrl)}.`,
      legal: "You're receiving this because you set up a Cue account.",
    }),
  };
}

/** 02 · SIGN-IN LINK — sent from POST /signin. */
export function signinEmail(params: { signinLink: string }): EmailMessage {
  return {
    subject: "Your sign-in link",
    link: params.signinLink,
    html: renderEmailHtml({
      head: "Here's your sign-in link.",
      body: "Tap below to sign in to Cue on this device.",
      button: { label: "Sign in to Cue", href: params.signinLink },
      ps: "Valid for 15 minutes. If you didn't request this, you can safely ignore it.",
      legal: "This is a security email for your Cue account.",
    }),
  };
}

/** 03 · CREDITS LOW — balance under 15% of the cycle grant. */
export function creditsLowEmail(params: {
  balance: number;
  accountUrl: string;
}): EmailMessage {
  return {
    subject: "Running low on credits",
    link: params.accountUrl,
    html: renderEmailHtml({
      head: "You're running low on credits.",
      body: "You've used most of this cycle's credits. Cue will check with you before starting big jobs. Top up anytime to keep things moving.",
      balance: params.balance.toLocaleString("en-US"),
      button: { label: "Top up", href: params.accountUrl },
      legal: "You're receiving this because credit alerts are on for your account.",
    }),
  };
}

/**
 * OPS ALERT — plain internal notification (fleet-sweep failures, exhausted
 * customers). Reuses the designed shell so it renders fine anywhere, but the
 * body is operator-facing, not customer-facing.
 */
export function opsAlertEmail(params: {
  subject: string;
  summary: string;
  detailLines?: string[];
  statusUrl: string;
}): EmailMessage {
  const detail = (params.detailLines ?? []).join(" · ");
  return {
    subject: `[cue-hq] ${params.subject}`,
    link: params.statusUrl,
    html: renderEmailHtml({
      head: params.subject,
      body: params.summary + (detail ? ` — ${detail}` : ""),
      button: { label: "Open HQ status", href: params.statusUrl },
      legal: "Internal operations alert from Cue HQ.",
    }),
  };
}

/** 04 · PAYMENT FAILED — grace period messaging, portal link. */
export function paymentFailedEmail(params: { portalUrl: string }): EmailMessage {
  return {
    subject: "Payment issue — Cue keeps running for now",
    link: params.portalUrl,
    html: renderEmailHtml({
      head: "We couldn't process your payment.",
      body: "No need to worry — Cue keeps running during a short grace period while we retry. Update your payment method to avoid any interruption.",
      button: { label: "Update payment method", href: params.portalUrl },
      legal: "You're receiving this because of a billing issue on your account.",
    }),
  };
}

// ── sending ──────────────────────────────────────────────────────────────

export type SendResult =
  | { ok: true; sent: true; id: string | null }
  | { ok: true; sent: false; reason: "email_not_configured" }
  | { ok: false; reason: string };

/**
 * Send an email via Resend, or — unconfigured — log the whole would-be
 * message (including the action link) at info level and report sent:false.
 */
export async function sendEmail(
  to: string,
  message: EmailMessage,
  fetchImpl: typeof fetch = fetch,
): Promise<SendResult> {
  if (!isEmailConfigured()) {
    console.info(
      `[hq/email] not configured — would send to=${to} subject=${JSON.stringify(message.subject)} link=${message.link}`,
    );
    return { ok: true, sent: false, reason: "email_not_configured" };
  }
  try {
    const res = await fetchImpl(`${RESEND_API_BASE}/emails`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: emailFrom(),
        to: [to],
        subject: message.subject,
        html: message.html,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, reason: `resend_error_${res.status}: ${text.slice(0, 300)}` };
    }
    const body = (await res.json().catch(() => ({}))) as { id?: string };
    return { ok: true, sent: true, id: body.id ?? null };
  } catch (err) {
    return {
      ok: false,
      reason: `resend_fetch_failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ── readiness (operator-facing; never fabricates DNS state) ──────────────

export interface EmailReadiness {
  /** RESEND_API_KEY present. */
  configured: boolean;
  mode: "live" | "log_only";
  from: string;
  /** The domain part of EMAIL_FROM (what Resend must have verified). */
  fromDomain: string | null;
  /**
   * Result of a live GET /domains probe against Resend — only present when
   * configured and the probe was requested. `status` is Resend's own value
   * ("verified" | "pending" | "failed" | …); `found:false` means the From
   * domain is not registered in Resend at all.
   */
  domainProbe?:
    | { ok: true; found: boolean; status: string | null }
    | { ok: false; reason: string };
}

function fromDomainOf(from: string): string | null {
  const match = from.match(/@([A-Za-z0-9.-]+)>?\s*$/);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Report email readiness. With `probe: true` (and a key present) it asks
 * Resend for the From-domain's verification status — a live API read, so
 * the operator sees the real DKIM/SPF state instead of a guess.
 */
export async function emailReadiness(
  opts: { probe?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<EmailReadiness> {
  const from = emailFrom();
  const readiness: EmailReadiness = {
    configured: isEmailConfigured(),
    mode: isEmailConfigured() ? "live" : "log_only",
    from,
    fromDomain: fromDomainOf(from),
  };
  if (!opts.probe || !readiness.configured) return readiness;
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const res = await fetchImpl(`${RESEND_API_BASE}/domains`, {
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      readiness.domainProbe = { ok: false, reason: `resend_error_${res.status}` };
      return readiness;
    }
    const body = (await res.json().catch(() => ({}))) as {
      data?: { name?: string; status?: string }[];
    };
    const match = (body.data ?? []).find(
      (d) => d.name?.toLowerCase() === readiness.fromDomain,
    );
    readiness.domainProbe = {
      ok: true,
      found: !!match,
      status: match?.status ?? null,
    };
  } catch (err) {
    readiness.domainProbe = {
      ok: false,
      reason: `resend_fetch_failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return readiness;
}

/**
 * Boot-time banner: scream when the control plane cannot actually email
 * anyone. Called from server startup — a customer-facing HQ without
 * RESEND_API_KEY silently eats every signin/welcome email (P0-1).
 */
export function logEmailReadinessAtBoot(): void {
  if (isEmailConfigured()) {
    console.info(`[hq/email] configured — sending as ${emailFrom()}`);
    return;
  }
  console.error(
    "[hq/email] ██ EMAIL IS IN LOG-ONLY MODE ██ RESEND_API_KEY is not set — " +
      "NO signin or welcome email will be delivered to any customer. " +
      "Magic links are only printed to this log. Set RESEND_API_KEY " +
      "(and verify the From domain in Resend) before inviting users.",
  );
}
