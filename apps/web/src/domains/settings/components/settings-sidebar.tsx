/**
 * Grouped settings navigation rail.
 *
 * The generic `SidebarTree` renders one flat list, which turned Settings into
 * 17 undifferentiated rows. This variant renders the same `SideMenu.Item` rows
 * under `SETTINGS_SECTIONS` headings, plus the pinned bottom items (Log Out,
 * and the developer panels once developer mode is unlocked).
 *
 * Row behaviour is deliberately identical to `SidebarTree`: real `<a href>`s so
 * modifier/middle clicks open a new tab, plain left-clicks become SPA
 * navigation, and `active` also matches nested detail routes.
 */
import { ChevronRight } from "lucide-react";
import { Fragment } from "react";
import { useLocation, useNavigate } from "react-router";

import { SideMenu } from "@vellumai/design-library";

import type { SidebarItem } from "@/components/sidebar-tree";
import type { SettingsSection } from "@/utils/settings-navigation";

interface SettingsSidebarProps {
  sections: SettingsSection[];
  bottomItems?: SidebarItem[];
  /** When the pathname equals this, the first row of the first section is
   *  marked active — the index route renders that same page. */
  indexPath?: string;
}

export function SettingsSidebar({
  sections,
  bottomItems,
  indexPath,
}: SettingsSidebarProps) {
  const { pathname } = useLocation();
  const navigate = useNavigate();

  const renderItem = (item: SidebarItem, isIndexItem: boolean) => {
    const { href, onSelect } = item;
    const isActive =
      href != null &&
      (pathname === href ||
        pathname.startsWith(href + "/") ||
        (isIndexItem && indexPath != null && pathname === indexPath));
    return (
      <SideMenu.Item
        key={item.id}
        icon={item.icon}
        label={item.label}
        active={isActive}
        // Action items (no href) render as a button; the chevron would wrongly
        // read as "navigates to a page", so omit it for them.
        trailingIcon={href != null ? ChevronRight : undefined}
        trailingIconClassName={href != null ? "md:hidden" : undefined}
        href={href}
        onSelect={onSelect}
        onClick={
          href == null
            ? undefined
            : (e) => {
                if (
                  e.metaKey ||
                  e.ctrlKey ||
                  e.shiftKey ||
                  e.altKey ||
                  e.button !== 0
                ) {
                  return;
                }
                e.preventDefault();
                navigate(href);
              }
        }
      />
    );
  };

  return (
    <nav
      aria-label="Settings navigation"
      className="flex min-h-full flex-col gap-4 md:px-6 md:pb-4"
    >
      {sections.map((section, sectionIndex) => (
        <SideMenu.Section key={section.id} title={section.title}>
          {section.items.map((item, index) =>
            renderItem(item, sectionIndex === 0 && index === 0),
          )}
        </SideMenu.Section>
      ))}

      {bottomItems && bottomItems.length > 0 && (
        <Fragment>
          <div className="flex-1" />
          <div
            role="presentation"
            aria-hidden
            className="my-1 h-px w-full bg-[var(--border-base)]"
          />
          {bottomItems.map((item) => renderItem(item, false))}
        </Fragment>
      )}
    </nav>
  );
}
