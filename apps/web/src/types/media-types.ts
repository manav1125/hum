import type { AttachmentsGetResponse } from "@/generated/daemon/types.gen";

/** A single media attachment surfaced in the Library media section. */
export type MediaSummary = AttachmentsGetResponse["attachments"][number];
