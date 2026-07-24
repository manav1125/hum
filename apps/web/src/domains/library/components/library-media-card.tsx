import { ImageIcon, Music, Video } from "lucide-react";

import { LibraryCardPlaceholder } from "@/domains/library/components/library-card-placeholder";
import type { MediaSummary } from "@/types/media-types";
import { cn } from "@/utils/misc";
import { formatFriendlyDate } from "@/utils/format-date";

interface LibraryMediaCardProps {
  media: MediaSummary;
  onOpen: (media: MediaSummary) => void;
}

function mediaFamily(media: MediaSummary): "image" | "video" | "audio" {
  const mime = media.mime_type.toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  // Fall back to the classified kind for uploads with a generic MIME type.
  if (media.kind === "image" || media.kind === "video" || media.kind === "audio") {
    return media.kind;
  }
  return "audio";
}

export function LibraryMediaCard({ media, onOpen }: LibraryMediaCardProps) {
  const family = mediaFamily(media);
  const thumbnailUrl = media.thumbnail_base64
    ? `data:image/jpeg;base64,${media.thumbnail_base64}`
    : null;

  const Icon = family === "video" ? Video : family === "image" ? ImageIcon : Music;

  return (
    <div className="group relative flex flex-col gap-2">
      <button
        type="button"
        onClick={() => onOpen(media)}
        className={cn(
          "relative flex w-full cursor-pointer flex-col items-center justify-center gap-2 overflow-hidden rounded-xl border border-[var(--border-base)] bg-[var(--surface-base)]",
          "aspect-[16/10]",
          "outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
        )}
      >
        {thumbnailUrl ? (
          <img
            src={thumbnailUrl}
            alt={media.original_filename}
            className="absolute inset-0 h-full w-full object-cover"
          />
        ) : (
          <LibraryCardPlaceholder
            seed={media.id}
            icon={Icon}
            label={family.charAt(0).toUpperCase() + family.slice(1)}
          />
        )}
      </button>

      <button
        type="button"
        onClick={() => onOpen(media)}
        className="flex cursor-pointer flex-col gap-0.5 px-0.5 text-left outline-none"
      >
        <span className="truncate text-body-large-default text-[color:var(--content-emphasised)]">
          {media.original_filename}
        </span>
        <span className="text-body-small-default text-[color:var(--content-tertiary)]">
          {formatFriendlyDate(new Date(media.created_at))}
        </span>
      </button>
    </div>
  );
}
