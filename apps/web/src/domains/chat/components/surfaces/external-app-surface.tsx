import { ArrowRight } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";

import type { Surface } from "@/domains/chat/types/types";
import { routes } from "@/utils/routes";

/**
 * "This looks like a job for <app>" — an in-chat card recommending one
 * embedded VentureVerse app, emitted by the model via `ui_show` with
 * surface_type `external_app` (see the `ventureverse` skill).
 *
 * Display-only: Open navigates the SPA to `/assistant/apps/<slug>`, the same
 * embed page the Apps gallery opens, which resolves the slug against the
 * daemon catalog itself. So the card is correct with just `slug` + `name`;
 * category/description/icon only enrich it. It never posts a surface action
 * and never blocks the turn.
 */
interface ExternalAppSurfaceData {
  slug: string;
  name: string;
  category?: string;
  description?: string;
  iconUrl?: string;
}

function AppIcon({ data }: { data: ExternalAppSurfaceData }) {
  const [failed, setFailed] = useState(false);
  if (!data.iconUrl || failed) {
    return (
      <div
        aria-hidden
        className="flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-[var(--surface-base)] text-body-medium-default text-[var(--content-secondary)]"
      >
        {data.name.slice(0, 1).toUpperCase()}
      </div>
    );
  }
  return (
    <img
      src={data.iconUrl}
      alt=""
      className="size-10 shrink-0 rounded-[10px] object-cover"
      onError={() => setFailed(true)}
    />
  );
}

export function ExternalAppSurface({ surface }: { surface: Surface }) {
  const navigate = useNavigate();
  const data = surface.data as unknown as ExternalAppSurfaceData;
  if (!data?.slug || !data?.name) return null;

  const open = () => void navigate(routes.ventureverseApps.app(data.slug));

  return (
    <div className="overflow-hidden rounded-xl border border-[var(--border-element)] bg-[var(--surface-lift)]">
      <div className="flex items-center gap-3 px-4 py-3">
        <AppIcon data={data} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-body-medium-default text-[var(--content-strong)]">
              {data.name}
            </span>
            {data.category ? (
              <span className="shrink-0 text-body-small-lighter text-[var(--content-tertiary)]">
                {data.category}
              </span>
            ) : null}
          </div>
          {data.description ? (
            <p className="mt-0.5 line-clamp-2 text-body-small-default text-[var(--content-quiet)]">
              {data.description}
            </p>
          ) : null}
        </div>
        <button
          type="button"
          onClick={open}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-[var(--border-element)] bg-[var(--surface-base)] px-3 py-1.5 text-body-medium-default text-[var(--content-strong)] transition-colors hover:bg-[var(--surface-hover)]"
        >
          Open
          <ArrowRight className="h-3.5 w-3.5" aria-hidden />
        </button>
      </div>
      <div className="border-t border-[var(--border-subtle)] px-4 py-2">
        <span className="text-body-small-lighter text-[var(--content-tertiary)]">
          Runs in Cue · Powered by VentureVerse
        </span>
      </div>
    </div>
  );
}
