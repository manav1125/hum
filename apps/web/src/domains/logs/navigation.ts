import type { LucideIcon } from "lucide-react";
import { Mail, MonitorCog, ScrollText } from "lucide-react";

import { routes } from "@/utils/routes";

export interface LogsSidebarItem {
  id: string;
  label: string;
  href: string;
  icon: LucideIcon;
}

export const LOGS_SIDEBAR: LogsSidebarItem[] = [
  // "Usage" was here. It is now part of Your Cue → Usage & spend, which holds
  // the caps and the kill switch alongside the breakdown that explains them —
  // `/assistant/logs/usage` redirects there. Leaving the row would have been a
  // second nav path to a page that is no longer here.
  { id: "logs", label: "Trace", href: routes.logs.trace, icon: ScrollText },
  {
    id: "system-events",
    label: "System events",
    href: routes.logs.systemEvents,
    icon: MonitorCog,
  },
  { id: "emails", label: "Email logs", href: routes.logs.emails, icon: Mail },
];
