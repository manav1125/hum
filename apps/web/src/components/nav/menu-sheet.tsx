/**
 * The phone's menu-sheet primitives — one row, one grouped sheet.
 *
 * These lived inside `mobile-v3/overflow-menu.tsx` while that file was the only
 * thing that had menus. It is not any more: the thread switcher (☰ → your
 * chats) renders the same rows from the corner chrome AND from inside a
 * conversation, where the corner chrome does not exist. Rather than have
 * `components/nav` import the chrome (and the chrome import `components/nav`
 * back — a cycle), the shared grammar moved down here and both callers import
 * it.
 *
 * Reach rule, inherited: these open from the BOTTOM. "Every primary action sits
 * below 60% of viewport height. Back chevrons and ⋯ may sit top-side as
 * escapes." A button is an escape; a menu of destinations is not — so the
 * button may live in a corner but its rows may not.
 */
import { microLabel } from "@/mobile-v3/mv3-kit";
import { SheetShell } from "@/mobile-v3/sheet-shell";
import { haptic } from "@/utils/haptics";

export interface MenuEntry {
  key: string;
  label: string;
  /** The second line — a real count, or nothing. Never a guess. */
  sub?: string | null;
  /** Mono eyebrow printed above this row, starting a group. */
  group?: string;
  /** Hairline above this row without an eyebrow (the quiet actions group). */
  rule?: boolean;
  /**
   * A line printed between this row's eyebrow and the row itself — where an
   * empty or failed list says WHY it is short, immediately above the door that
   * still works. Kept on the entry rather than passed to the sheet so it lands
   * inside its own group instead of on top of the whole menu.
   */
  noteAbove?: React.ReactNode;
  run: () => void;
}

/** The mono eyebrow that opens a group of rows. */
export function MenuGroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        ...microLabel,
        fontSize: 8.5,
        letterSpacing: ".12em",
        color: "var(--mv3-micro)",
        padding: "10px 4px 6px",
      }}
    >
      {children}
    </div>
  );
}

/**
 * A line the sheet says rather than offers — "no chats yet", "couldn't load
 * these". Not a row: it has nothing to run, so it must not look pressable.
 */
export function MenuNote({ children }: { children: React.ReactNode }) {
  return (
    <div
      data-slot="mv3-menu-note"
      style={{
        fontSize: 12.5,
        color: "var(--mv3-muted)",
        padding: "10px 12px 12px",
        lineHeight: 1.4,
      }}
    >
      {children}
    </div>
  );
}

/** One row of a menu sheet. */
export function MenuRow({
  item,
  onDone,
}: {
  item: MenuEntry;
  onDone: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className="cue-pressable"
      data-slot="mv3-menu-row"
      data-menu-key={item.key}
      onClick={() => {
        haptic.light();
        onDone();
        item.run();
      }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 11,
        width: "100%",
        textAlign: "left",
        background: "transparent",
        border: "none",
        borderTop: item.rule ? "1px solid var(--mv3-sheet-border)" : "none",
        borderRadius: 12,
        padding: "12px 12px",
        minHeight: 48,
        fontFamily: "inherit",
        cursor: "pointer",
        WebkitTapHighlightColor: "transparent",
        color: "var(--mv3-text)",
      }}
    >
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ fontSize: 13.5, fontWeight: 600, display: "block" }}>
          {item.label}
        </span>
        {item.sub ? (
          <span
            style={{
              fontSize: 10,
              color: "var(--mv3-muted)",
              display: "block",
              marginTop: 1,
            }}
          >
            {item.sub}
          </span>
        ) : null}
      </span>
      <span aria-hidden style={{ color: "var(--mv3-muted)", flexShrink: 0 }}>
        ›
      </span>
    </button>
  );
}

/** A grouped sheet of menu rows. */
export function MenuSheet({
  open,
  onClose,
  label,
  items,
  maxHeight = "72%",
}: {
  open: boolean;
  onClose: () => void;
  label: string;
  items: MenuEntry[];
  maxHeight?: string | number;
}) {
  return (
    <SheetShell open={open} onClose={onClose} label={label} maxHeight={maxHeight}>
      <div role="menu" aria-label={label}>
        {items.map((item) => (
          <div key={item.key}>
            {item.group ? <MenuGroupLabel>{item.group}</MenuGroupLabel> : null}
            {item.noteAbove ? <MenuNote>{item.noteAbove}</MenuNote> : null}
            <MenuRow item={item} onDone={onClose} />
          </div>
        ))}
      </div>
    </SheetShell>
  );
}
