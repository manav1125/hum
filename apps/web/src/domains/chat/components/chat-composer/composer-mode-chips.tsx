/**
 * Create and Voice — the composer's two **labelled** mode chips.
 *
 * `docs/design/handoff-2026-08-02/01-work-surfaces/packs/v15-navigation-final/README.md`
 * line 64: *"Create and Voice stay composer chips."* They lost their sidebar
 * rows deliberately — FINAL-NAV-BRIEF §9.3 says a thing you *ask for* (create,
 * voice, research) is a composer chip, not a page — and the composer is where
 * they live now.
 *
 * ## Why this file exists at all
 *
 * "Composer chip" was implemented as an unlabelled mic glyph sitting in a row
 * of other glyphs: paperclip, dictation mic, voice-mode mic, send. Two of the
 * four were microphones. The owner, reading the drawn frames, could not pick
 * the affordance out of the row — which is the same failure as not shipping it.
 *
 * So, three things, none of which is a new behaviour:
 *
 * 1. **A visible text label.** A chip is a labelled thing. An icon-only button
 *    is a glyph, and a glyph in a row of glyphs is a search task.
 * 2. **A different mark from dictation.** Voice mode gets `AudioLines`, not
 *    `Mic`. Dictation (`VoiceInputButton`) keeps `Mic`. Two microphones side by
 *    side were two names for one drawing.
 * 3. **The other side of the bar.** The chips sit in the action row's *left*
 *    group; the icon cluster (attach · dictate · send) stays right. Distance is
 *    what stops "one more small round button" from being the reading.
 *
 * The wiring is untouched. Voice calls the same `onEnterVoiceMode` handler
 * `EnterVoiceModeButton` was given (ChatBody opens the orb overlay, which owns
 * the single `useLiveVoice` controller) and self-gates on the same `voice-mode`
 * assistant flag, so a flag-off composer still renders no voice affordance at
 * all. Create is a `Link` to {@link routes.create} — a real href, so
 * cmd-click and middle-click work, which a button-plus-navigate would break.
 *
 * The accessible name stays `"Start voice mode"`: it was already the right
 * name, and screen-reader users were never the ones who could not find it.
 */

import { AudioLines, Sparkles } from "lucide-react";
import { Link } from "react-router";

import { routes } from "@/utils/routes";
import { useAssistantFeatureFlagStore } from "@/stores/assistant-feature-flag-store";

/**
 * Chip skin, shared by both so they read as a pair.
 *
 * Text is `--mv1-t2` (`--content-secondary`, 5.9:1 light / 6.1:1 dark) over the
 * composer's `--surface-lift`. `--mv1-t3` / `#5B5B68` are border tokens whose
 * names do not say so; neither sets text here. The border is the outline the
 * owner asked for — a chip you can see the edge of, not a hover-only target.
 */
const CHIP_CLASS = [
  "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full",
  "border border-[var(--mv1-line)] bg-transparent px-2.5",
  "text-body-small-default text-[var(--mv1-t2)] no-underline",
  "cursor-pointer select-none whitespace-nowrap",
  "transition-colors hover:border-[var(--mv1-t2)] hover:text-[var(--mv1-t1)]",
  "keyboard-focus:ring-2 keyboard-focus:ring-[var(--ring)]",
  "disabled:cursor-not-allowed disabled:opacity-50",
].join(" ");

export interface ComposerModeChipsProps {
  /**
   * Enter in-chat voice mode. Omitted by callers that have no voice (the
   * app-editing side panel), in which case no Voice chip is rendered — the
   * same precondition `EnterVoiceModeButton` applied.
   */
  onEnterVoiceMode?: () => void;
  /**
   * Voice entry is blocked. Covers the composer being busy, dictation already
   * recording, and a turn in flight — entering a session mid-turn was not
   * possible before this chip existed and is not made possible by it.
   */
  voiceDisabled?: boolean;
}

export function ComposerModeChips({
  onEnterVoiceMode,
  voiceDisabled = false,
}: ComposerModeChipsProps) {
  const voiceMode = useAssistantFeatureFlagStore.use.voiceMode();
  const showVoice = voiceMode && onEnterVoiceMode !== undefined;

  return (
    <div className="flex items-center gap-1.5">
      <Link
        to={routes.create}
        className={CHIP_CLASS}
        data-coach="composer-create"
      >
        <Sparkles className="h-3.5 w-3.5" aria-hidden />
        <span>Create</span>
      </Link>
      {showVoice && (
        <button
          type="button"
          onClick={onEnterVoiceMode}
          disabled={voiceDisabled}
          aria-label="Start voice mode"
          title="Start voice mode"
          className={CHIP_CLASS}
          data-coach="composer-voice"
        >
          <AudioLines className="h-3.5 w-3.5" aria-hidden />
          <span>Voice</span>
        </button>
      )}
    </div>
  );
}
