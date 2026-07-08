/**
 * Brand logo for a connectable app (Composio toolkit), with a graceful
 * monogram fallback.
 *
 * Renders the real logo as a small rounded <img> inside the caller-styled
 * chip when `logoUrl` is present and loads; falls back to the app's initial
 * letter ONLY when the URL is missing or the image errors. Used by the
 * onboarding connect-tools grid and the Tools & Apps (connectors) page so
 * both surfaces show the same identity for the same app.
 */

import { useState, type CSSProperties } from "react";

export function ConnectorAppLogo({
  name,
  logoUrl,
  size,
  imgSize,
  chipStyle,
}: {
  /** App display name — first letter is the monogram fallback. */
  name: string;
  /** Brand logo URL (optional — absent means monogram). */
  logoUrl?: string;
  /** Outer chip square, px. */
  size: number;
  /** Logo image square inside the chip, px (default ~22px, clamped to fit). */
  imgSize?: number;
  /** Chip container overrides (background, border, text color, font size). */
  chipStyle?: CSSProperties;
}) {
  const [failed, setFailed] = useState(false);
  const showLogo = Boolean(logoUrl) && !failed;
  const logoPx = Math.min(imgSize ?? 22, size - 8);

  return (
    <span
      aria-hidden
      data-slot={
        showLogo ? "connector-app-logo" : "connector-app-monogram"
      }
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.28),
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontWeight: 600,
        flexShrink: 0,
        overflow: "hidden",
        ...chipStyle,
        // A loaded logo sits on white so dark-chip styles don't swallow
        // transparent-background brand marks.
        ...(showLogo
          ? { background: "#fff", border: "1px solid #EDEFF3", color: "unset" }
          : null),
      }}
    >
      {showLogo ? (
        <img
          src={logoUrl}
          alt=""
          width={logoPx}
          height={logoPx}
          loading="lazy"
          onError={() => setFailed(true)}
          style={{
            width: logoPx,
            height: logoPx,
            borderRadius: 5,
            objectFit: "contain",
          }}
        />
      ) : (
        name.charAt(0).toUpperCase()
      )}
    </span>
  );
}
