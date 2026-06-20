import { Link } from "react-router";

import { UpdateAvailableBadge } from "@/domains/intelligence/components/plugins/update-available-badge";
import { usePluginDrift } from "@/domains/intelligence/use-plugin-drift";
import type { PluginsGetResponse } from "@/generated/daemon/types.gen";
import { routes } from "@/utils/routes";

interface PluginRowProps {
  plugin: PluginsGetResponse["plugins"][number];
  assistantId: string;
}

/**
 * Card for a single installed plugin — design-matched to surfaces/Plugins.dc.html
 * (icon tile + name + version chip + description, in a 2-up grid). The whole
 * card links to the plugin's detail page, where the README, tracked metadata,
 * and Upgrade / Remove actions live. An "Update available" pill appears when
 * the installed copy is behind the marketplace pin. The drift query is shared
 * (by key) with the detail page, so opening a flagged plugin doesn't re-inspect.
 */
export function PluginRow({ plugin, assistantId }: PluginRowProps) {
  const driftQuery = usePluginDrift({ assistantId, name: plugin.name });
  const updateAvailable = driftQuery.data?.status === "update-available";

  return (
    <Link
      to={routes.plugin(plugin.name)}
      className="group block cursor-pointer rounded-[13px] p-[15px] text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
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
            background: "#EEEDFB",
            fontSize: 17,
          }}
        >
          🧩
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              className="truncate"
              style={{ fontSize: 14, fontWeight: 500, color: "#1A2230" }}
            >
              {plugin.name}
            </span>
            {plugin.version ? (
              <span style={{ fontSize: 12, color: "#5A6672", flexShrink: 0 }}>
                v{plugin.version}
              </span>
            ) : null}
            {updateAvailable ? <UpdateAvailableBadge /> : null}
          </div>
          <div style={{ fontSize: 12, color: "#5A6672" }}>installed</div>
        </div>
      </div>
      <p
        className="mt-[10px] line-clamp-2"
        style={{ fontSize: 12.5, color: "#5A6672" }}
      >
        {plugin.description ?? "No description provided."}
      </p>
      {plugin.issues && plugin.issues.length > 0 ? (
        <p
          className="mt-1 truncate"
          style={{ fontSize: 11.5, color: "#C98A1B" }}
          title={plugin.issues.join("; ")}
        >
          {plugin.issues[0]}
          {plugin.issues.length > 1
            ? ` (+${plugin.issues.length - 1} more)`
            : ""}
        </p>
      ) : null}
    </Link>
  );
}
