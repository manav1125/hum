import { Link } from "react-router";

import type { PluginsSearchGetResponse } from "@/generated/daemon/types.gen";
import { routes } from "@/utils/routes";

interface CatalogRowProps {
  match: PluginsSearchGetResponse["matches"][number];
}

/**
 * Card for a single catalog entry — design-matched to surfaces/Plugins.dc.html
 * (icon tile + name + an Install chip + description, in a 2-up grid). The whole
 * card links to the plugin's detail page, where the README, tracked metadata,
 * and the real Install action live.
 */
export function CatalogRow({ match }: CatalogRowProps) {
  return (
    <Link
      to={routes.plugin(match.name)}
      className="group block cursor-pointer rounded-[13px] p-[15px] text-left transition-colors hover:bg-[var(--surface-hover)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
      style={{
        border: "1px solid #E5E9F0",
        background: "#fff",
        fontFamily: "'DM Sans', system-ui, sans-serif",
        color: "#1A2230",
      }}
    >
      <div className="flex items-center gap-3">
        <span
          className="flex shrink-0 items-center justify-center"
          style={{
            width: 38,
            height: 38,
            borderRadius: 10,
            background: "#EEF1F6",
            fontSize: 17,
          }}
        >
          📦
        </span>
        <div className="min-w-0 flex-1">
          <div
            className="truncate"
            style={{ fontSize: 14, fontWeight: 500, color: "#1A2230" }}
          >
            {match.name}
          </div>
          <div
            className="truncate"
            style={{ fontSize: 12, color: "#8D99A5" }}
            title={match.path}
          >
            {match.path}
          </div>
        </div>
        <span
          className="shrink-0"
          style={{
            fontSize: 12,
            border: "1px solid #D7DDE7",
            borderRadius: 8,
            padding: "5px 11px",
            color: "#1A2230",
          }}
        >
          Install
        </span>
      </div>
      {match.description ? (
        <p
          className="mt-[10px] line-clamp-2"
          style={{ fontSize: 12.5, color: "#5A6672" }}
        >
          {match.description}
        </p>
      ) : null}
    </Link>
  );
}
