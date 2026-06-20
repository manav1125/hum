/**
 * localStorage-backed active-template state for the dashboard.
 *
 * v1 = built-in templates (see `templates.ts`) + a remembered active
 * selection. There is no backend for saved/custom templates yet, so a single
 * localStorage key is the honest source of truth for "which template am I
 * looking at". Falls back to the first template when storage is empty or holds
 * an id that no longer exists.
 */

import { useCallback, useState } from "react";

import {
  DASHBOARD_TEMPLATES,
  templateById,
  type DashboardTemplate,
} from "./templates";

const STORAGE_KEY = "cue.dashboard.activeTemplate";

function readStored(): string {
  if (typeof window === "undefined") return DASHBOARD_TEMPLATES[0].id;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw && DASHBOARD_TEMPLATES.some((t) => t.id === raw)) return raw;
  } catch {
    // Private mode / storage disabled — fall through to the default.
  }
  return DASHBOARD_TEMPLATES[0].id;
}

export interface UseDashboardTemplates {
  templates: DashboardTemplate[];
  activeId: string;
  active: DashboardTemplate;
  setActiveId: (id: string) => void;
}

export function useDashboardTemplates(): UseDashboardTemplates {
  const [activeId, setActiveIdState] = useState<string>(readStored);

  const setActiveId = useCallback((id: string) => {
    setActiveIdState(id);
    try {
      window.localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // Persistence is best-effort; the in-memory selection still updates.
    }
  }, []);

  return {
    templates: DASHBOARD_TEMPLATES,
    activeId,
    active: templateById(activeId),
    setActiveId,
  };
}
