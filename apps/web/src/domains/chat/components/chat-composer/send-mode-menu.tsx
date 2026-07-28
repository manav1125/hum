/**
 * SendModeMenu — the split half of the composer's send button.
 *
 * The UX audit's finding was that the composer's bottom row is already
 * overloaded (attach, dictation, voice-mode, settings, context, send), so
 * "run this in the background" deliberately does NOT become a seventh naked
 * icon. It is a split on the control it modifies: a narrow chevron fused to the
 * left edge of the send button, which opens a two-item menu — send now, or hand
 * it off.
 *
 * It renders NOTHING until there is something to send, so the resting composer
 * is byte-identical to before.
 *
 * Dead-control rule: when the message can't be handed off (attachments, which a
 * work item cannot carry) the menu item is rendered *disabled with the reason*
 * rather than enabled-and-broken, and the chevron itself is hidden entirely
 * when there is no assistant to run against.
 */

import { ChevronUp, CornerDownLeft, MoonStar } from "lucide-react";
import { useState } from "react";

import { Button, Menu } from "@vellumai/design-library";

export interface SendModeMenuProps {
  /** Hidden entirely when false — nothing to send, or nowhere to send it. */
  visible: boolean;
  /** Null when the hand-off is unavailable; the string is shown as the reason. */
  disabledReason: string | null;
  /** Modifier hint shown next to "Run in the background". */
  shortcutHint: string;
  onSendNow: () => void;
  onRunInBackground: () => void;
}

export function SendModeMenu({
  visible,
  disabledReason,
  shortcutHint,
  onSendNow,
  onRunInBackground,
}: SendModeMenuProps) {
  const [open, setOpen] = useState(false);
  if (!visible) return null;

  return (
    <Menu.Root open={open} onOpenChange={setOpen}>
      <Menu.Trigger asChild>
        <Button
          variant="ghost"
          size="compact"
          expandOnMobile={false}
          iconOnly={<ChevronUp className="h-3.5 w-3.5" />}
          aria-label="Send options"
          title="Send options"
          className="[--vbtn-fg:var(--content-tertiary)] data-[state=open]:[--vbtn-fg:var(--content-default)]"
        />
      </Menu.Trigger>
      <Menu.Content side="top" align="end">
        <Menu.Item
          onSelect={onSendNow}
          leftIcon={<CornerDownLeft className="h-3.5 w-3.5" />}
          shortcut="↵"
        >
          Send now
        </Menu.Item>
        <Menu.Item
          onSelect={() => {
            if (disabledReason) return;
            onRunInBackground();
          }}
          disabled={disabledReason !== null}
          leftIcon={<MoonStar className="h-3.5 w-3.5" />}
          shortcut={disabledReason ? undefined : shortcutHint}
          title={
            disabledReason ??
            "Cue works on this on its own and files the result in Review"
          }
        >
          {disabledReason
            ? `Run in the background — ${disabledReason}`
            : "Run in the background"}
        </Menu.Item>
      </Menu.Content>
    </Menu.Root>
  );
}
