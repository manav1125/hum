/**
 * SkillDetailSheet — the round-4 skill detail + install-confirm sheet (spec
 * frame 57, docs/design/mobile-round4/cue-mobile-round4.html). One flow, no
 * naked installs: a card tap opens the detail; "Get" opens the SAME sheet
 * with the confirm card focused.
 *
 * Honesty rules baked in:
 *  · "WILL BE ABLE TO" rows derive ONLY from the skill's declared capability
 *    manifest (`capabilities` on marketplace items / the install plan) —
 *    reusing the frame-30 consent vocabulary (✓ allow green, ‖ asks-first
 *    amber). Catalog skills declare no manifest, so the card is absent — a
 *    capability list is never invented.
 *  · version / installs / source render only where the API provides them.
 *  · The confirm copy references asks-first permissions only when elevated
 *    rows actually exist.
 */
import { useEffect, useRef } from "react";

import type { SkillInfo } from "@/domains/intelligence/skills/types";
import {
  rebrandSkillProse,
  skillOriginLabel,
} from "@/domains/intelligence/skills/utils";
import type {
  InstallResponse,
  MarketplaceItem,
} from "@/pages/marketplace/use-marketplace";
import { haptic } from "@/utils/haptics";

import { SheetShell } from "../sheet-shell";
import { microLabel, primaryBtn } from "../mv3-kit";

/* ───────────────────────────── Consent rows ──────────────────────────────── */

export interface CapabilityRow {
  label: string;
  elevated: boolean;
}

/**
 * The declared-manifest → consent-row mapping (frame-18/30 vocabulary):
 * connectors/network read as ✓ allow, writes/secrets as ‖ asks-first.
 */
export function capabilityRows(
  caps: InstallResponse["capabilities"],
): CapabilityRow[] {
  const rows: CapabilityRow[] = [];
  if (caps.connectors.length > 0)
    rows.push({
      label: `Use ${caps.connectors.join(", ")}`,
      elevated: false,
    });
  if (caps.network.length > 0)
    rows.push({
      label: `Reach ${caps.network.slice(0, 3).join(", ")}`,
      elevated: false,
    });
  if (caps.writes.length > 0)
    rows.push({
      label: `Write to ${caps.writes.slice(0, 3).join(", ")}`,
      elevated: true,
    });
  if (caps.secrets.length > 0)
    rows.push({
      label: `Use secrets: ${caps.secrets.join(", ")}`,
      elevated: true,
    });
  return rows;
}

/* ───────────────────────────── Detail model ──────────────────────────────── */

export interface SkillDetailModel {
  title: string;
  emoji: string | null;
  /** "Cue official" / "Community" (marketplace) or the origin label. */
  badge: string;
  official: boolean;
  /** "v2.3 · 4.2k installs · MIT" — real fields only, null when none. */
  metaLine: string | null;
  description: string | null;
  /** Declared capability manifest rows; null = no manifest declared. */
  consent: CapabilityRow[] | null;
  /** "Uses: Gmail · Slack" from declared connectors; null when none. */
  usesLine: string | null;
  /** "source: owner/repo/path" or the item URL; null when unknown. */
  sourceLine: string | null;
}

/** Marketplace item → detail model. */
export function marketplaceDetailModel(
  item: MarketplaceItem,
): SkillDetailModel {
  const official = item.source === "cue-official";
  const rows = capabilityRows(item.capabilities);
  return {
    title: rebrandSkillProse(item.displayName) ?? item.displayName,
    emoji: item.emoji ?? null,
    // Reuse the origin vocabulary: cue-official maps onto the "vellum"
    // origin's display label.
    badge: official ? (skillOriginLabel("vellum") ?? "Cue official") : "Community",
    official,
    metaLine: item.license ?? null,
    description: rebrandSkillProse(item.description) ?? null,
    consent: rows,
    usesLine:
      item.capabilities.connectors.length > 0
        ? `Uses: ${item.capabilities.connectors.join(" · ")}`
        : null,
    sourceLine: item.url ?? `${item.source}/${item.skillPath}`,
  };
}

/** Daemon-catalog skill → detail model (no declared manifest — consent null). */
export function catalogDetailModel(skill: SkillInfo): SkillDetailModel {
  const originLabel = skillOriginLabel(skill.origin);
  const metaParts = [
    skill.version ? `v${skill.version}` : null,
    typeof skill.installs === "number"
      ? `${skill.installs.toLocaleString()} installs`
      : null,
  ].filter(Boolean);
  return {
    title: rebrandSkillProse(skill.name) ?? skill.name,
    emoji: skill.emoji ?? skill.icon ?? null,
    badge: originLabel ?? "Community",
    official: skill.origin === "vellum",
    metaLine: metaParts.length > 0 ? metaParts.join(" · ") : null,
    description: rebrandSkillProse(skill.description ?? null) ?? null,
    consent: null,
    usesLine: null,
    sourceLine: skill.sourceRepo ?? skill.author ?? null,
  };
}

/** Honest confirm copy — references asks-first only when it exists. */
export function confirmCopy(model: SkillDetailModel): string {
  if (model.consent === null) {
    return "Installs from the Cue catalog. Anything sensitive still asks at run time. You can uninstall anytime.";
  }
  if (model.consent.some((r) => r.elevated)) {
    return "It runs with the permissions above — the ‖ items always need your OK. You can change limits or uninstall anytime.";
  }
  return "It declares no elevated capabilities — instructions only. You can uninstall anytime.";
}

/* ─────────────────────────────── The sheet ───────────────────────────────── */

export function SkillDetailSheet({
  open,
  model,
  installed,
  confirming,
  planPending,
  plan,
  installing,
  error,
  onGet,
  onConfirm,
  onClose,
}: {
  open: boolean;
  model: SkillDetailModel | null;
  /** Already installed — read-only detail, no Get/confirm. */
  installed: boolean;
  /** True once "Get" was pressed — the confirm card is revealed + focused. */
  confirming: boolean;
  /** Waiting for the install plan (marketplace confirmation payload). */
  planPending: boolean;
  /** The authoritative install plan, once fetched. */
  plan: InstallResponse | null;
  installing: boolean;
  error: string | null;
  onGet: () => void;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const confirmRef = useRef<HTMLDivElement>(null);

  // "Get" jumps straight to the same sheet with the confirm card focused.
  useEffect(() => {
    if (!open || !confirming) return;
    const id = requestAnimationFrame(() => {
      confirmRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    });
    return () => cancelAnimationFrame(id);
  }, [open, confirming, planPending]);

  if (!model) return null;

  // The plan's declared manifest is authoritative once fetched.
  const consentRows = plan ? capabilityRows(plan.capabilities) : model.consent;

  return (
    <SheetShell open={open} onClose={onClose} label={model.title}>
      <div style={{ padding: "0 2px 8px" }}>
        {/* Header — tile, name, badge + meta. */}
        <div style={{ display: "flex", alignItems: "center", gap: 13 }}>
          <span
            aria-hidden
            style={{
              width: 52,
              height: 52,
              borderRadius: 15,
              background: "rgba(61,110,232,.18)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 24,
              flexShrink: 0,
            }}
          >
            {model.emoji || "✦"}
          </span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{ fontSize: 20, fontWeight: 700, letterSpacing: "-.4px" }}
            >
              {model.title}
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 7,
                marginTop: 3,
              }}
            >
              <span
                style={{
                  fontSize: 10,
                  color: model.official
                    ? "var(--mv3-micro)"
                    : "var(--mv3-muted)",
                  background: model.official
                    ? "rgba(61,110,232,.16)"
                    : "var(--mv3-btn2-bg)",
                  borderRadius: 6,
                  padding: "2px 8px",
                  flexShrink: 0,
                }}
              >
                {model.badge}
              </span>
              {model.metaLine ? (
                <span
                  style={{
                    fontSize: 10.5,
                    color: "var(--mv3-muted)",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {model.metaLine}
                </span>
              ) : null}
              {installed ? (
                <span
                  style={{
                    ...microLabel,
                    fontSize: 9.5,
                    color: "var(--mv3-green)",
                  }}
                >
                  ✓ Installed
                </span>
              ) : null}
            </div>
          </div>
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 10,
            marginTop: 14,
          }}
        >
          {model.description ? (
            <div
              style={{
                fontSize: 13.5,
                color: "var(--mv3-muted)",
                lineHeight: 1.6,
              }}
            >
              {model.description}
            </div>
          ) : null}

          {/* WILL BE ABLE TO — only from a declared manifest. */}
          {consentRows !== null ? (
            <div
              style={{
                background: "var(--mv3-card)",
                border: "1px solid var(--mv3-card-border)",
                borderRadius: 18,
                padding: "13px 15px",
              }}
            >
              <div
                style={{
                  ...microLabel,
                  fontSize: 9.5,
                  color: "var(--mv3-muted)",
                  marginBottom: 9,
                }}
              >
                Will be able to
              </div>
              <div
                style={{ display: "flex", flexDirection: "column", gap: 7 }}
              >
                {consentRows.length === 0 ? (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 9,
                      fontSize: 12.5,
                    }}
                  >
                    <span style={{ color: "var(--mv3-green)" }} aria-hidden>
                      ✓
                    </span>
                    Declares no elevated capabilities — instructions only
                  </div>
                ) : (
                  consentRows.map((row) => (
                    <div
                      key={row.label}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 9,
                        fontSize: 12.5,
                        color: row.elevated
                          ? "var(--mv3-amber)"
                          : "var(--mv3-text)",
                      }}
                    >
                      <span
                        aria-hidden
                        style={{
                          color: row.elevated
                            ? "var(--mv3-amber)"
                            : "var(--mv3-green)",
                          fontWeight: row.elevated ? 700 : 400,
                        }}
                      >
                        {row.elevated ? "‖" : "✓"}
                      </span>
                      {row.label}
                      {row.elevated ? " — always asks first" : ""}
                    </div>
                  ))
                )}
              </div>
            </div>
          ) : null}

          {/* Uses / source — real metadata only. */}
          {model.usesLine || model.sourceLine ? (
            <div
              style={{
                background: "var(--mv3-card)",
                border: "1px solid var(--mv3-card-border)",
                borderRadius: 18,
                padding: "13px 15px",
                display: "flex",
                alignItems: "center",
                gap: 11,
              }}
            >
              <span aria-hidden style={{ fontSize: 14 }}>
                🛠
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                {model.usesLine ? (
                  <div style={{ fontSize: 12.5 }}>{model.usesLine}</div>
                ) : null}
                {model.sourceLine ? (
                  <div
                    style={{
                      fontSize: 10.5,
                      color: "var(--mv3-faint)",
                      marginTop: model.usesLine ? 2 : 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    source: {model.sourceLine}
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          {/* Install-plan extras (notice + files) once the plan is in. */}
          {plan?.notice ? (
            <div
              style={{
                fontSize: 11.5,
                color: "var(--mv3-muted)",
                lineHeight: 1.5,
              }}
            >
              {plan.notice}
            </div>
          ) : null}
          {plan?.files ? (
            <div style={{ ...microLabel, color: "var(--mv3-faint)" }}>
              {plan.files.length} file{plan.files.length === 1 ? "" : "s"} to
              install
              {plan.skipped.length > 0
                ? ` · ${plan.skipped.length} skipped (never executable)`
                : ""}
            </div>
          ) : null}

          {/* Confirm card — revealed by "Get", never a naked install. */}
          {!installed && confirming ? (
            <div
              ref={confirmRef}
              style={{
                background: "var(--mv3-card)",
                border: "1px solid rgba(127,163,242,.45)",
                borderRadius: 20,
                padding: "14px 16px",
                boxShadow: "0 24px 50px -22px rgba(61,110,232,.45)",
              }}
            >
              <div style={{ fontSize: 14, fontWeight: 600 }}>
                Install this skill?
              </div>
              <div
                style={{
                  fontSize: 11.5,
                  color: "var(--mv3-muted)",
                  marginTop: 4,
                  lineHeight: 1.5,
                }}
              >
                {confirmCopy({ ...model, consent: consentRows })}
              </div>
              {error ? (
                <div
                  role="alert"
                  style={{ fontSize: 12, color: "#E5675B", marginTop: 8 }}
                >
                  {error}
                </div>
              ) : null}
              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                <button
                  type="button"
                  disabled={installing || planPending}
                  onClick={() => {
                    haptic.medium();
                    onConfirm();
                  }}
                  style={{
                    ...primaryBtn,
                    borderRadius: 12,
                    padding: 12,
                    minHeight: 46,
                    fontSize: 13.5,
                    opacity: installing || planPending ? 0.6 : 1,
                  }}
                >
                  {planPending
                    ? "Checking permissions…"
                    : installing
                      ? "Installing…"
                      : "Install"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    haptic.light();
                    onClose();
                  }}
                  style={{
                    background: "var(--mv3-btn2-bg)",
                    color: "var(--mv3-muted)",
                    border: "1px solid var(--mv3-btn2-border)",
                    borderRadius: 12,
                    padding: "12px 16px",
                    minHeight: 46,
                    fontSize: 13,
                    fontFamily: "inherit",
                    cursor: "pointer",
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : null}

          {/* Detail phase: the Get affordance (hidden once installed). */}
          {!installed && !confirming ? (
            <>
              {error ? (
                <div role="alert" style={{ fontSize: 12, color: "#E5675B" }}>
                  {error}
                </div>
              ) : null}
              <button
                type="button"
                onClick={() => {
                  haptic.medium();
                  onGet();
                }}
                style={{
                  ...primaryBtn,
                  borderRadius: 12,
                  padding: 12,
                  minHeight: 46,
                  fontSize: 13.5,
                }}
              >
                Get
              </button>
            </>
          ) : null}
        </div>
      </div>
    </SheetShell>
  );
}
