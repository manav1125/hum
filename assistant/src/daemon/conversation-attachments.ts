import {
  attachInlineAttachmentToMessage,
  AttachmentUploadError,
  getAttachmentsByIds,
  getFilePathForAttachment,
  linkAttachmentToMessage,
  setAttachmentThumbnail,
} from "../memory/attachments-store.js";
import type { PermissionPrompter } from "../permissions/prompter.js";
import { isAllowDecision } from "../permissions/types.js";
import type { ContentBlock } from "../providers/types.js";
import { getLogger } from "../util/logger.js";
import {
  type ApproveHostRead,
  type AssistantAttachmentDraft,
  contentBlocksToDrafts,
  deduplicateDrafts,
  type DirectiveRequest,
  resolveDirectives,
  validateDrafts,
} from "./assistant-attachments.js";
import type { UserMessageAttachment } from "./message-protocol.js";
import {
  generateVideoThumbnail,
  generateVideoThumbnailFromPath,
} from "./video-thumbnail.js";

const log = getLogger("conversation-attachments");

/**
 * Approve reading a host file for assistant attachment resolution.
 * Checks the permission store and prompts the user if needed.
 */
export async function approveHostAttachmentRead(
  filePath: string,
  workingDir: string,
  prompter: PermissionPrompter,
  conversationId: string,
  hasNoClient: boolean,
): Promise<boolean> {
  const toolName = "host_file_read";
  const input = { path: filePath };

  // HTTP-created sessions use a no-op sendToClient — prompting would
  // block for the full permission timeout before auto-denying.
  if (hasNoClient) {
    log.info(
      { filePath },
      "Denying host attachment read: no interactive client connected",
    );
    return false;
  }

  const response = await prompter.prompt(
    toolName,
    input,
    "low",
    [],
    [],
    undefined,
    conversationId,
    "host",
    false,
  );

  return isAllowDecision(response.decision);
}

export interface AttachmentResolutionResult {
  assistantAttachments: AssistantAttachmentDraft[];
  emittedAttachments: UserMessageAttachment[];
  directiveWarnings: string[];
}

/**
 * Resolve accumulated directives and tool content blocks into assistant
 * attachments. Persists attachments and links them to the assistant message.
 *
 * `toolAttachmentIds` carries ids of attachments the turn's tools already
 * persisted to the attachments store (`ToolExecutionResult.attachmentIds`,
 * e.g. spreadsheet_create / pdf_create output). Those rows exist but are not
 * linked to any message, and GET messages hydrates a row's attachments
 * exclusively from the message_attachments link table — so they are linked
 * to the assistant message here.
 */
export async function resolveAssistantAttachments(
  accumulatedDirectives: DirectiveRequest[],
  accumulatedToolContentBlocks: ContentBlock[],
  directiveWarnings: string[],
  workingDir: string,
  approveHostRead: ApproveHostRead,
  lastAssistantMessageId: string | undefined,
  toolContentBlockToolNames?: ReadonlyMap<number, string>,
  toolAttachmentIds: readonly string[] = [],
): Promise<AttachmentResolutionResult> {
  let assistantAttachments: AssistantAttachmentDraft[] = [];
  const emittedAttachments: UserMessageAttachment[] = [];

  log.info(
    {
      directiveCount: accumulatedDirectives.length,
      toolBlockCount: accumulatedToolContentBlocks.length,
      toolAttachmentIdCount: toolAttachmentIds.length,
      workingDir,
    },
    "Resolving assistant attachments",
  );

  if (
    accumulatedDirectives.length > 0 ||
    accumulatedToolContentBlocks.length > 0
  ) {
    const directiveDrafts =
      accumulatedDirectives.length > 0
        ? await resolveDirectives(
            accumulatedDirectives,
            workingDir,
            approveHostRead,
          )
        : { drafts: [], warnings: [] };
    directiveWarnings.push(...directiveDrafts.warnings);

    if (directiveDrafts.warnings.length > 0) {
      log.warn(
        { warnings: directiveDrafts.warnings },
        "Directive resolution warnings",
      );
    }
    log.info(
      {
        resolvedDrafts: directiveDrafts.drafts.length,
        directives: accumulatedDirectives.map((d) => ({
          source: d.source,
          path: d.path,
          filename: d.filename,
          mimeType: d.mimeType,
        })),
      },
      "Directive resolution complete",
    );

    const toolDrafts = contentBlocksToDrafts(
      accumulatedToolContentBlocks,
      toolContentBlockToolNames,
    );
    // Most recent tool outputs first so deduplication keeps the latest version.
    toolDrafts.reverse();
    const merged = deduplicateDrafts([
      ...directiveDrafts.drafts,
      ...toolDrafts,
    ]);
    const validated = validateDrafts(merged);
    directiveWarnings.push(...validated.warnings);
    assistantAttachments = validated.accepted;

    log.info(
      {
        merged: merged.length,
        accepted: validated.accepted.length,
        validationWarnings: validated.warnings,
      },
      "Attachment validation complete",
    );
  } else {
    log.info("No directives or tool content blocks to resolve");
  }

  // Persist resolved attachments and link to the last assistant message.
  // Large video attachments are omitted from the event payload and lazy-loaded
  // by the client via the HTTP endpoint (same pattern as history_response).
  const MAX_INLINE_B64_SIZE = 512 * 1024;

  if (assistantAttachments.length > 0 && lastAssistantMessageId) {
    for (let i = 0; i < assistantAttachments.length; i++) {
      const draft = assistantAttachments[i];
      let stored;
      try {
        stored = attachInlineAttachmentToMessage(
          lastAssistantMessageId,
          i,
          draft.filename,
          draft.mimeType,
          draft.dataBase64,
          { skipSizeLimit: true },
        );
      } catch (err) {
        if (err instanceof AttachmentUploadError) {
          log.warn(
            { filename: draft.filename, error: err.message },
            "Skipping attachment upload",
          );
          directiveWarnings.push(
            `Attachment ${draft.filename} skipped: ${err.message}`,
          );
          continue;
        }
        throw err;
      }
      const isVideo = draft.mimeType.startsWith("video/");
      // Only omit data for videos — they have an end-to-end lazy-load path
      // via /v1/attachments/:id/content. Other types (images, PDFs) still need
      // inline data for thumbnails, preview, and file-save in the client.
      const omitData = isVideo && draft.dataBase64.length > MAX_INLINE_B64_SIZE;

      // Generate and persist a thumbnail for video attachments.
      let thumbnailData: string | undefined;
      if (isVideo) {
        const existing = stored.thumbnailBase64;
        if (existing) {
          thumbnailData = existing;
        } else {
          const diskFilePath = getFilePathForAttachment(stored.id);
          const generated = diskFilePath
            ? await generateVideoThumbnailFromPath(diskFilePath)
            : await generateVideoThumbnail(draft.dataBase64);
          if (generated) {
            setAttachmentThumbnail(stored.id, generated);
            thumbnailData = generated;
          }
        }
      }

      emittedAttachments.push({
        id: stored.id,
        filename: draft.filename,
        mimeType: draft.mimeType,
        data: omitData ? "" : draft.dataBase64,
        sourceType: draft.sourceType,
        ...(omitData ? { sizeBytes: draft.sizeBytes } : {}),
        fileBacked: true,
        ...(thumbnailData ? { thumbnailData } : {}),
      });
    }
  } else if (assistantAttachments.length > 0) {
    for (const draft of assistantAttachments) {
      emittedAttachments.push({
        filename: draft.filename,
        mimeType: draft.mimeType,
        data: draft.dataBase64,
        sourceType: draft.sourceType,
      });
    }
  }

  // Link attachments the tools stored directly (already persisted rows, so no
  // re-upload — just the message_attachments link plus a metadata-only emit;
  // clients hydrate the bytes lazily via /v1/attachments/:id/content).
  if (toolAttachmentIds.length > 0 && lastAssistantMessageId) {
    const alreadyEmittedIds = new Set(
      emittedAttachments
        .map((a) => a.id)
        .filter((id): id is string => id != null),
    );
    let position = assistantAttachments.length;
    for (const attachmentId of toolAttachmentIds) {
      if (alreadyEmittedIds.has(attachmentId)) continue;
      try {
        const scopedId = linkAttachmentToMessage(
          lastAssistantMessageId,
          attachmentId,
          position,
        );
        position += 1;
        const [meta] = getAttachmentsByIds([scopedId]);
        emittedAttachments.push({
          id: scopedId,
          filename: meta?.originalFilename ?? "attachment",
          mimeType: meta?.mimeType ?? "application/octet-stream",
          data: "",
          sourceType: "tool_block",
          ...(meta ? { sizeBytes: meta.sizeBytes } : {}),
          fileBacked: true,
          ...(meta?.thumbnailBase64
            ? { thumbnailData: meta.thumbnailBase64 }
            : {}),
        });
        alreadyEmittedIds.add(scopedId);
      } catch (err) {
        log.warn(
          { attachmentId, messageId: lastAssistantMessageId, err },
          "Failed to link tool-produced attachment to assistant message (non-fatal)",
        );
      }
    }
  } else if (toolAttachmentIds.length > 0) {
    log.warn(
      { toolAttachmentIds },
      "Tool-produced attachments have no assistant message row to link to",
    );
  }

  return { assistantAttachments, emittedAttachments, directiveWarnings };
}
