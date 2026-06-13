import { motion, useReducedMotion } from "motion/react";
import { memo, useCallback, useState, type CSSProperties } from "react";

import type { CharacterComponents, CharacterTraits } from "@/types/avatar";
import { ApertureAvatar, type ApertureAvatarState } from "@vellumai/design-library";

export interface ChatAvatarProps {
  /** Legacy Vellum character data — accepted for API compatibility, no longer rendered. */
  components: CharacterComponents | null;
  /** Legacy Vellum character data — accepted for API compatibility, no longer rendered. */
  traits: CharacterTraits | null;
  customImageUrl: string | null;
  size?: number;
  className?: string;
  interactive?: boolean;
  isStreaming?: boolean;
  isProcessing?: boolean;
}

/** Ring geometry. Thickness is a fixed 1px hairline; gap scales with size. */
const RING_THICKNESS = 1; // border thickness in px
const RING_GAP_RATIO = 0.04; // gap between avatar edge and ring inner edge / size

/**
 * Spinning semicircular ring traced just outside a custom uploaded-image
 * avatar's edge while the assistant is streaming/loading. (The ApertureAvatar
 * signals activity through its own `thinking` state instead.)
 */
function AvatarStreamingRing({ size }: { size: number }) {
  const thickness = RING_THICKNESS;
  const gap = Math.max(1, Math.round(size * RING_GAP_RATIO));
  const inset = -(thickness + gap);
  return (
    <span
      aria-hidden="true"
      className="avatar-streaming-ring pointer-events-none absolute"
      style={{
        top: inset,
        right: inset,
        bottom: inset,
        left: inset,
        borderWidth: thickness,
        boxSizing: "border-box",
      }}
    />
  );
}

/**
 * The assistant's avatar — Cue's aperture mark.
 *
 * Cue's identity is the single, consistent aperture (BRAND.md), not a
 * per-assistant creature, so this renders ApertureAvatar by default and maps
 * activity to its states (streaming/processing → thinking). A user-uploaded
 * `customImageUrl` is still honored as an override. The legacy Vellum
 * `components`/`traits` props are accepted for API compatibility but no longer
 * rendered (and the "V" fallback is gone).
 *
 * Animation: a mount entrance spring (scale 0.6 → 1, opacity 0 → 1); when
 * `interactive`, click triggers a spring bounce; `prefers-reduced-motion`
 * short-circuits both.
 */
function ChatAvatarComponent({
  customImageUrl,
  size = 28,
  className,
  interactive = false,
  isStreaming = false,
  isProcessing = false,
}: ChatAvatarProps) {
  const reduce = useReducedMotion();
  const [isPoking, setIsPoking] = useState(false);

  const triggerBounce = useCallback(() => {
    if (reduce) return;
    setIsPoking(true);
    window.setTimeout(() => setIsPoking(false), 360);
  }, [reduce]);

  const handleClick = interactive ? triggerBounce : undefined;
  const active = isStreaming || isProcessing;
  const state: ApertureAvatarState = active ? "thinking" : "idle";

  const wrapperStyle: CSSProperties = {
    width: size,
    height: size,
    flexShrink: 0,
    cursor: interactive ? "pointer" : undefined,
    transformOrigin: "center",
    position: "relative",
  };

  const transition = reduce
    ? { duration: 0 }
    : { type: "spring" as const, visualDuration: 0.3, bounce: 0.5 };
  const initial = reduce ? { scale: 1, opacity: 1 } : { scale: 0.6, opacity: 0 };
  const animate = { scale: isPoking ? 1.15 : 1, opacity: 1 };

  if (customImageUrl) {
    return (
      <motion.div
        onClick={handleClick}
        initial={initial}
        animate={animate}
        transition={transition}
        style={wrapperStyle}
      >
        <img
          src={customImageUrl}
          alt="Assistant avatar"
          width={size}
          height={size}
          className={`rounded-full object-cover ${className ?? ""}`}
          style={{ width: size, height: size, flexShrink: 0 }}
        />
        {active && <AvatarStreamingRing size={size} />}
      </motion.div>
    );
  }

  return (
    <motion.div
      className={className}
      style={wrapperStyle}
      onClick={handleClick}
      initial={initial}
      animate={animate}
      transition={transition}
    >
      <ApertureAvatar state={state} size={size} />
    </motion.div>
  );
}

/**
 * Memoized so the avatar subtree only re-renders when its own props change.
 * `Transcript` re-renders frequently during streaming while the avatar runs
 * animation work, so skipping unrelated re-renders matters.
 */
export const ChatAvatar = memo(ChatAvatarComponent);
