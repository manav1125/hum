import { Loader2, Plus, Search } from "lucide-react";
import { useState } from "react";

import { Card } from "@vellumai/design-library/components/card";
import { Input } from "@vellumai/design-library/components/input";

import type {
    ContactSelection,
    ContactSummary,
} from "@/domains/contacts/types";

interface ContactsListProps {
  loading: boolean;
  guardian: ContactSummary | null;
  assistantName?: string;
  regularContacts: ContactSummary[];
  selection: ContactSelection | null;
  onSelect: (selection: ContactSelection) => void;
  onAddContact: () => void;
  addingContact?: boolean;
}

export function ContactsList({
  loading,
  guardian,
  assistantName,
  regularContacts,
  selection,
  onSelect,
  onAddContact,
  addingContact = false,
}: ContactsListProps) {
  const [search, setSearch] = useState("");
  const filtered = search.trim()
    ? regularContacts.filter((c) =>
        c.displayName.toLowerCase().includes(search.trim().toLowerCase()),
      )
    : regularContacts;

  return (
    <Card className="h-full">
      <div
        className="flex h-full min-w-0 flex-col gap-[10px]"
        style={{ fontFamily: "'DM Sans', system-ui, sans-serif", color: "#1A2230" }}
      >
        <Input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search people"
          leftIcon={<Search className="h-3.5 w-3.5" aria-hidden />}
          fullWidth
        />

        <div className="flex min-h-0 flex-1 flex-col gap-[5px] overflow-auto">
          {guardian ? (
            <ContactRow
              name={guardian.displayName ? `${guardian.displayName} (You)` : "You"}
              subtitle="guardian"
              role={guardian.role}
              contactType={guardian.contactType}
              selected={
                selection?.kind === "contact" && selection.contactId === guardian.id
              }
              onClick={() => onSelect({ kind: "contact", contactId: guardian.id })}
            />
          ) : null}

          {filtered.map((contact) => (
            <ContactRow
              key={contact.id}
              name={contact.displayName}
              subtitle={contactSubtitle(contact)}
              role={contact.role}
              contactType={contact.contactType}
              selected={
                selection?.kind === "contact" && selection.contactId === contact.id
              }
              onClick={() =>
                onSelect({ kind: "contact", contactId: contact.id })
              }
            />
          ))}

          {regularContacts.length > 0 && filtered.length === 0 ? (
            <p
              className="px-3 py-4 text-center text-body-small-default"
              style={{ color: "#8D99A5" }}
            >
              No matching people
            </p>
          ) : null}

          <ContactRow
            name={assistantName?.trim() || "Your Assistant"}
            subtitle="assistant"
            role="assistant"
            selected={selection?.kind === "assistant"}
            onClick={() => onSelect({ kind: "assistant" })}
          />
        </div>

        <button
          type="button"
          onClick={onAddContact}
          disabled={addingContact}
          className="mt-auto flex items-center justify-center gap-2"
          style={{
            border: "1px dashed #D7DDE7",
            borderRadius: 11,
            padding: 11,
            fontSize: 13,
            color: "#5A6672",
            background: "transparent",
            cursor: addingContact ? "default" : "pointer",
          }}
        >
          {addingContact ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <Plus className="h-3.5 w-3.5" aria-hidden />
          )}
          Add contact
        </button>
      </div>
    </Card>
  );
}

/** Subtitle line under a contact's name: role + Cue-relabeled channels. */
function contactSubtitle(contact: ContactSummary): string | undefined {
  const parts: string[] = [];
  if (contact.contactType && contact.contactType !== "human") {
    parts.push(contact.contactType);
  }
  if (contact.channelTypes && contact.channelTypes.length > 0) {
    parts.push(
      contact.channelTypes
        .map((t) => (t === "vellum" ? "Cue" : t))
        .join(" · "),
    );
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

const AVATAR_PALETTE: Record<
  string,
  { bg: string; color: string; dot: string }
> = {
  guardian: { bg: "#1A2230", color: "#fff", dot: "#277E41" },
  assistant: { bg: "#FBE7DD", color: "#B5572B", dot: "#7F77DD" },
  contact: { bg: "#DBE4FB", color: "#2B53C4", dot: "#3D6EE8" },
};

function paletteFor(
  role: string | null | undefined,
  contactType: string | null | undefined,
) {
  if (role === "guardian") return AVATAR_PALETTE.guardian;
  if (role === "assistant" || contactType === "assistant")
    return AVATAR_PALETTE.assistant;
  return AVATAR_PALETTE.contact;
}

function rowInitials(name: string): string {
  const parts = name.replace(/\s*\(You\)\s*$/i, "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

interface ContactRowProps {
  name: string;
  subtitle?: string;
  role: string | null | undefined;
  contactType?: string | null;
  selected: boolean;
  onClick: () => void;
}

function ContactRow({
  name,
  subtitle,
  role,
  contactType,
  selected,
  onClick,
}: ContactRowProps) {
  const palette = paletteFor(role, contactType);

  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center gap-[11px] text-left"
      style={{
        padding: 10,
        borderRadius: 11,
        background: selected ? "#F4F6F9" : "transparent",
        border: selected ? "1px solid #E5E9F0" : "1px solid transparent",
        cursor: "pointer",
      }}
    >
      <span
        className="flex shrink-0 items-center justify-center"
        style={{
          width: 34,
          height: 34,
          borderRadius: "50%",
          background: palette.bg,
          color: palette.color,
          fontSize: 12,
          fontWeight: 600,
        }}
      >
        {rowInitials(name)}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate" style={{ fontSize: 13.5, fontWeight: 600 }}>
          {name}
        </span>
        {subtitle ? (
          <span className="truncate" style={{ fontSize: 11.5, color: "#8D99A5" }}>
            {subtitle}
          </span>
        ) : null}
      </span>
      <span
        aria-hidden
        className="shrink-0"
        style={{
          width: 8,
          height: 8,
          borderRadius: 3,
          background: palette.dot,
        }}
      />
    </button>
  );
}
