/**
 * BrandKitPage — the mobile Brand kit screen (spec frame 19: your brand,
 * applied everywhere). Replaces the mv3 stub at routes.brandKit.
 *
 * DATA (all real — the daemon brand-profiles store via `use-brand-kit.ts`):
 *  · profile   — the active brand profile (or the first saved one)
 *  · hero      — generic mini-deck vs "yours" rendered FROM the real palette
 *  · PALETTE   — the profile's saved swatches
 *  · TYPE      — the profile's heading/body fonts
 *  · Logos     — which of light/dark/mark are set (sheet shows them)
 *  · Voice     — tone + do/don't lists (sheet)
 *  · CTA       — "Apply everywhere" = the real activate mutation; an already
 *                active profile reads "Applied everywhere ✓"
 *
 * No brand yet → the honest add-brand empty state, deep-linking the existing
 * brand capture flow (Settings → Brand: website/upload/guided extraction).
 */
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import {
  useActivateBrandProfile,
  useBrandProfiles,
  type BrandProfile,
} from "@/pages/brand-kit/use-brand-kit";
import { haptic } from "@/utils/haptics";
import { routes } from "@/utils/routes";

import { GlassCard } from "../glass-card";
import { SheetShell } from "../sheet-shell";
import { microLabel, primaryBtn, rise } from "../mv3-kit";
import { YouScreen } from "../you/you-kit";

/** Renderable value for a logo slot: an image URL/data URI, or nothing. */
function logoSrc(value: string | undefined | null): string | null {
  const v = (value ?? "").trim();
  if (v.startsWith("http") || v.startsWith("data:")) return v;
  return null;
}

/** The generic → yours before/after hero (frame 19's aha moment). */
function LivePreview({ profile }: { profile: BrandProfile }) {
  const p = profile.palette ?? {};
  const primary = p.primary ?? "#3D6EE8";
  const accent = p.accent ?? "#7F77DD";
  const bg = p.bg ?? "#1A2230";
  return (
    <GlassCard padding="14px 16px" style={rise(0.1)}>
      <div
        style={{
          ...microLabel,
          color: "var(--mv3-micro)",
          marginBottom: 11,
        }}
      >
        Live preview — same deck, your brand
      </div>
      <div style={{ display: "flex", gap: 9 }}>
        {/* generic */}
        <div
          style={{
            flex: 1,
            borderRadius: 12,
            overflow: "hidden",
            border: "1px solid var(--mv3-card-border)",
          }}
        >
          <div style={{ height: 74, background: "#E9EBF0", padding: 10 }}>
            <div
              style={{
                height: 6,
                width: "70%",
                background: "#666",
                borderRadius: 2,
              }}
            />
            <div
              style={{
                height: 3,
                width: "50%",
                background: "#AAA",
                borderRadius: 2,
                marginTop: 5,
              }}
            />
            <div style={{ display: "flex", gap: 4, marginTop: 9 }}>
              <div
                style={{
                  height: 22,
                  flex: 1,
                  background: "#CCC",
                  borderRadius: 3,
                }}
              />
              <div
                style={{
                  height: 22,
                  flex: 1,
                  background: "#DDD",
                  borderRadius: 3,
                }}
              />
            </div>
          </div>
          <div
            style={{
              fontSize: 9.5,
              color: "var(--mv3-muted)",
              padding: "5px 9px",
              textAlign: "center",
            }}
          >
            generic
          </div>
        </div>
        <span
          aria-hidden
          style={{
            alignSelf: "center",
            color: "var(--mv3-micro)",
            fontSize: 16,
          }}
        >
          →
        </span>
        {/* yours — rendered from the real palette */}
        <div
          style={{
            flex: 1,
            borderRadius: 12,
            overflow: "hidden",
            border: `1.5px solid ${primary}`,
            boxShadow: `0 10px 24px -10px color-mix(in srgb, ${primary} 50%, transparent)`,
          }}
        >
          <div
            style={{
              height: 74,
              background: `linear-gradient(160deg, ${bg}, color-mix(in srgb, ${bg} 55%, ${primary}))`,
              padding: 10,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 3,
                  background: `linear-gradient(135deg, ${primary}, ${accent})`,
                }}
              />
              <span
                style={{
                  height: 6,
                  width: "45%",
                  background: "#fff",
                  borderRadius: 2,
                }}
              />
            </div>
            <div
              style={{
                height: 3,
                width: "50%",
                background: "rgba(255,255,255,.5)",
                borderRadius: 2,
                marginTop: 6,
              }}
            />
            <div style={{ display: "flex", gap: 4, marginTop: 9 }}>
              <div
                style={{
                  height: 22,
                  flex: 1,
                  background: primary,
                  borderRadius: 3,
                }}
              />
              <div
                style={{
                  height: 22,
                  flex: 1,
                  background: accent,
                  borderRadius: 3,
                  opacity: 0.7,
                }}
              />
            </div>
          </div>
          <div
            style={{
              fontSize: 9.5,
              color: "var(--mv3-micro)",
              padding: "5px 9px",
              textAlign: "center",
              background: `color-mix(in srgb, ${primary} 12%, transparent)`,
            }}
          >
            yours ✓
          </div>
        </div>
      </div>
    </GlassCard>
  );
}

function LeafRow({
  icon,
  title,
  sub,
  delay,
  onPress,
}: {
  icon: React.ReactNode;
  title: string;
  sub: string;
  delay: number;
  onPress: () => void;
}) {
  return (
    <GlassCard
      radius={18}
      padding="13px 16px"
      blur={false}
      style={{ cursor: "pointer", ...rise(delay) }}
      onClick={() => {
        haptic.light();
        onPress();
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        {icon}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600 }}>{title}</div>
          <div
            style={{
              fontSize: 11,
              color: "var(--mv3-muted)",
              marginTop: 1,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {sub}
          </div>
        </div>
        <span style={{ color: "var(--mv3-muted)" }} aria-hidden>
          ›
        </span>
      </div>
    </GlassCard>
  );
}

export function BrandKitPage() {
  const assistantId = useActiveAssistantId();
  const navigate = useNavigate();
  const { profiles, active, isLoading } = useBrandProfiles(assistantId);
  const activate = useActivateBrandProfile(assistantId);
  const [sheet, setSheet] = useState<"logos" | "voice" | null>(null);

  const profile = active ?? profiles[0] ?? null;
  const isApplied = profile != null && profile.isActive === 1;

  const paletteSwatches = useMemo(() => {
    const p = profile?.palette ?? {};
    return [p.bg, p.primary, p.accent, p.surface, p.text].filter(
      (v): v is string => typeof v === "string" && v.trim().length > 0,
    );
  }, [profile]);

  const logos = profile?.logo ?? null;
  const logoSlots = (
    [
      { key: "light", label: "on-light", src: logoSrc(logos?.light) },
      { key: "dark", label: "on-dark", src: logoSrc(logos?.dark) },
      { key: "mark", label: "mark", src: logoSrc(logos?.mark) },
    ] as const
  ).filter((s) => ((logos?.[s.key] ?? "") as string).trim() !== "");

  const voice = profile?.voice ?? null;
  const voiceSub =
    voice?.tone && voice.tone.trim().length > 0
      ? voice.tone
      : "No voice notes yet";

  return (
    <YouScreen
      tint="blue"
      testId="mv3-brand-kit"
      back={routes.channels}
      trailing={
        <button
          type="button"
          onClick={() => {
            haptic.light();
            navigate(routes.settings.brand);
          }}
          style={{
            fontSize: 13,
            color: "var(--mv3-micro)",
            background: "none",
            border: "none",
            padding: "6px 0",
            minHeight: 44,
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          {profile ? "Edit brand" : "Add brand"}
        </button>
      }
      title="Brand kit"
      sub={
        isLoading
          ? "Opening your brand…"
          : profile
            ? `${profile.name} · applied to every deck, doc & image`
            : "One brand, applied to every deck, doc & image"
      }
    >
      {profile ? (
        <>
          <LivePreview profile={profile} />

          {/* palette + type */}
          <div style={{ display: "flex", gap: 9, ...rise(0.25) }}>
            <GlassCard
              radius={18}
              padding="13px 14px"
              blur={false}
              style={{ flex: 1 }}
            >
              <div style={{ ...microLabel, color: "var(--mv3-muted)" }}>
                Palette
              </div>
              <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
                {paletteSwatches.length > 0 ? (
                  paletteSwatches.map((hex, i) => (
                    <span
                      key={`${hex}-${i}`}
                      title={hex}
                      style={{
                        width: 26,
                        height: 26,
                        borderRadius: 8,
                        background: hex,
                        border: "1px solid var(--mv3-card-border)",
                      }}
                    />
                  ))
                ) : (
                  <span style={{ fontSize: 12, color: "var(--mv3-muted)" }}>
                    No colors saved
                  </span>
                )}
              </div>
            </GlassCard>
            <GlassCard
              radius={18}
              padding="13px 14px"
              blur={false}
              style={{ flex: 1 }}
            >
              <div style={{ ...microLabel, color: "var(--mv3-muted)" }}>
                Type
              </div>
              <div style={{ fontSize: 16, fontWeight: 700, marginTop: 8 }}>
                Aa{" "}
                <span
                  style={{
                    fontWeight: 400,
                    color: "var(--mv3-muted)",
                    fontSize: 13,
                  }}
                >
                  {[profile.fonts?.heading, profile.fonts?.body]
                    .filter((f) => f && f.trim().length > 0)
                    .join(" / ") || "Heading / body"}
                </span>
              </div>
            </GlassCard>
          </div>

          <LeafRow
            delay={0.4}
            icon={
              <span
                aria-hidden
                style={{
                  width: 38,
                  height: 38,
                  borderRadius: 10,
                  background: "#fff",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}
              >
                {logoSlots[0]?.src ? (
                  <img
                    src={logoSlots[0].src}
                    alt=""
                    style={{ width: 22, height: 22, objectFit: "contain" }}
                  />
                ) : (
                  <span
                    style={{
                      width: 20,
                      height: 20,
                      borderRadius: 6,
                      background: `linear-gradient(135deg, ${profile.palette?.primary ?? "#3D6EE8"}, ${profile.palette?.accent ?? "#7F77DD"})`,
                    }}
                  />
                )}
              </span>
            }
            title="Logos"
            sub={
              logoSlots.length > 0
                ? logoSlots.map((s) => s.label).join(" · ")
                : "No logos yet — tap to add"
            }
            onPress={() => setSheet("logos")}
          />
          <LeafRow
            delay={0.5}
            icon={
              <span
                aria-hidden
                style={{
                  width: 38,
                  height: 38,
                  borderRadius: 10,
                  background: "rgba(167,159,240,.15)",
                  color: "var(--mv3-violet)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 15,
                  flexShrink: 0,
                }}
              >
                “”
              </span>
            }
            title="Voice"
            sub={voiceSub}
            onPress={() => setSheet("voice")}
          />

          <button
            type="button"
            disabled={isApplied || activate.isPending}
            onClick={() => {
              haptic.medium();
              activate.mutate({
                path: { assistant_id: assistantId, bid: profile.id },
              } as never);
            }}
            style={{
              ...primaryBtn,
              width: "100%",
              borderRadius: 15,
              padding: 14,
              minHeight: 50,
              fontSize: 14.5,
              opacity: activate.isPending ? 0.6 : 1,
              ...(isApplied
                ? {
                    background: "var(--mv3-btn2-bg)",
                    color: "var(--mv3-green)",
                    boxShadow: "none",
                    border: "1px solid var(--mv3-btn2-border)",
                  }
                : {}),
              ...rise(0.6),
            }}
          >
            {isApplied
              ? "✓ Applied everywhere"
              : activate.isPending
                ? "Applying…"
                : "Apply everywhere"}
          </button>
        </>
      ) : isLoading ? (
        <div
          style={{
            fontSize: 13,
            color: "var(--mv3-muted)",
            padding: "16px 4px",
          }}
        >
          Opening your brand…
        </div>
      ) : (
        /* Add-brand empty state. */
        <GlassCard padding="18px 16px" style={rise(0.1)}>
          <div style={{ fontSize: 15, fontWeight: 700 }}>No brand yet</div>
          <div
            style={{
              fontSize: 12.5,
              color: "var(--mv3-muted)",
              marginTop: 6,
              lineHeight: 1.55,
            }}
          >
            Point Cue at your website or upload a deck — it extracts your
            palette, type, logos and voice, then applies them to everything it
            makes for you.
          </div>
          <button
            type="button"
            onClick={() => {
              haptic.medium();
              navigate(routes.settings.brand);
            }}
            style={{
              ...primaryBtn,
              width: "100%",
              marginTop: 14,
              minHeight: 48,
            }}
          >
            Add your brand
          </button>
        </GlassCard>
      )}

      {/* Logos leaf. */}
      <SheetShell
        open={sheet === "logos"}
        onClose={() => setSheet(null)}
        label="Logos"
      >
        <div style={{ padding: "2px 2px 8px" }}>
          <div style={{ fontSize: 17, fontWeight: 700 }}>Logos</div>
          {logoSlots.length === 0 ? (
            <>
              <div
                style={{
                  fontSize: 12.5,
                  color: "var(--mv3-muted)",
                  marginTop: 10,
                }}
              >
                No logos saved yet.
              </div>
              {/* Actionable path (not a dead end): the settings Brand leaf
                  hosts the studio, whose logo step supports upload on mobile. */}
              <button
                type="button"
                onClick={() => {
                  haptic.medium();
                  setSheet(null);
                  navigate(routes.settings.brand);
                }}
                style={{
                  ...primaryBtn,
                  width: "100%",
                  marginTop: 14,
                  minHeight: 48,
                }}
              >
                Add a logo ›
              </button>
            </>
          ) : (
            <div style={{ display: "flex", gap: 9, marginTop: 14 }}>
              {logoSlots.map((slot) => (
                <div
                  key={slot.key}
                  style={{ flex: 1, textAlign: "center", minWidth: 0 }}
                >
                  <div
                    style={{
                      height: 74,
                      borderRadius: 12,
                      background: slot.key === "dark" ? "#0A0C12" : "#FFFFFF",
                      border: "1px solid var(--mv3-card-border)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      overflow: "hidden",
                    }}
                  >
                    {slot.src ? (
                      <img
                        src={slot.src}
                        alt={`${slot.label} logo`}
                        style={{
                          maxWidth: "80%",
                          maxHeight: "70%",
                          objectFit: "contain",
                        }}
                      />
                    ) : (
                      <span
                        style={{
                          fontSize: 10.5,
                          color: "var(--mv3-muted)",
                          padding: "0 6px",
                        }}
                      >
                        saved
                      </span>
                    )}
                  </div>
                  <div
                    style={{
                      fontSize: 10.5,
                      color: "var(--mv3-muted)",
                      marginTop: 5,
                    }}
                  >
                    {slot.label}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </SheetShell>

      {/* Voice leaf. */}
      <SheetShell
        open={sheet === "voice"}
        onClose={() => setSheet(null)}
        label="Voice"
      >
        <div style={{ padding: "2px 2px 8px" }}>
          <div style={{ fontSize: 17, fontWeight: 700 }}>Voice</div>
          {voice && (voice.tone || (voice.doList ?? []).length > 0) ? (
            <>
              {voice.tone ? (
                <div
                  style={{ fontSize: 13.5, marginTop: 10, lineHeight: 1.55 }}
                >
                  {voice.tone}
                </div>
              ) : null}
              {(voice.doList ?? []).length > 0 ? (
                <div style={{ marginTop: 12 }}>
                  <div style={{ ...microLabel, color: "var(--mv3-green)" }}>
                    Do
                  </div>
                  {(voice.doList ?? []).map((d) => (
                    <div
                      key={d}
                      style={{
                        fontSize: 12.5,
                        color: "var(--mv3-muted)",
                        marginTop: 5,
                      }}
                    >
                      · {d}
                    </div>
                  ))}
                </div>
              ) : null}
              {(voice.dontList ?? []).length > 0 ? (
                <div style={{ marginTop: 12 }}>
                  <div style={{ ...microLabel, color: "var(--mv3-amber-text)" }}>
                    Don't
                  </div>
                  {(voice.dontList ?? []).map((d) => (
                    <div
                      key={d}
                      style={{
                        fontSize: 12.5,
                        color: "var(--mv3-muted)",
                        marginTop: 5,
                      }}
                    >
                      · {d}
                    </div>
                  ))}
                </div>
              ) : null}
            </>
          ) : (
            <div
              style={{
                fontSize: 12.5,
                color: "var(--mv3-muted)",
                marginTop: 10,
              }}
            >
              No voice notes yet — add tone and do/don't lines from Settings →
              Brand.
            </div>
          )}
        </div>
      </SheetShell>
    </YouScreen>
  );
}
