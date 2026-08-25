import { extname } from "node:path";

import { RiskLevel } from "../../permissions/types.js";
import { registerTool } from "../registry.js";
import {
  AUDIO_EXTENSIONS,
  readAudioFile,
} from "../shared/filesystem/audio-read.js";
import {
  describeBinaryContent,
  DOCUMENT_EXTENSIONS,
  readDocumentFile,
} from "../shared/filesystem/document-read.js";
import { FileSystemOps } from "../shared/filesystem/file-ops-service.js";
import {
  IMAGE_EXTENSIONS,
  readImageFile,
} from "../shared/filesystem/image-read.js";
import { sandboxPolicy } from "../shared/filesystem/path-policy.js";
import {
  invalidToolInputResult,
  toToolInputSchema,
} from "../shared/zod-tool-schema.js";
import { fileReadInputSchema } from "../tool-input-schemas.js";
import type {
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "../types.js";

export const fileReadTool = {
  name: "file_read",
  description:
    "Read the contents of a file on your own machine. Documents (PDF, DOCX, XLSX) are extracted to text automatically — read them directly, do not shell out to convert them. For image files (JPEG, PNG, GIF, WebP), returns the image for visual analysis. For audio files (MP3, WAV, OGG, FLAC, AAC, M4A), returns the audio for listening. Use host_file_read for files on your guardian's device instead.",
  category: "filesystem",
  executionTarget: "sandbox",
  defaultRiskLevel: RiskLevel.Low,

  // Derived from the same Zod source the pre-execution gate validates
  // against (`TOOL_INPUT_SCHEMAS`), so contract and validation cannot drift.
  input_schema: toToolInputSchema(fileReadInputSchema, {
    advertiseRequired: ["activity"],
  }),

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const parsed = fileReadInputSchema.safeParse(input);
    if (!parsed.success) {
      return invalidToolInputResult("file_read", parsed.error);
    }
    const { path: rawPath, offset, limit } = parsed.data;

    // For image files, delegate to the shared image reader.
    const ext = extname(rawPath).toLowerCase();
    if (IMAGE_EXTENSIONS.has(ext)) {
      const pathCheck = sandboxPolicy(rawPath, context.workingDir);
      if (!pathCheck.ok) {
        return {
          content: `Error: ${pathCheck.error}. To read files outside the workspace, use the host_file_read tool instead.`,
          isError: true,
        };
      }
      return readImageFile(pathCheck.resolved);
    }

    // Documents are extracted to text. Without this they fall through to the
    // UTF-8 reader below and come back as raw bytes — `%PDF-1.7`, object
    // dictionaries, line numbers — which reads like content and sends the
    // model hunting for another way to open a file it could already read.
    if (DOCUMENT_EXTENSIONS.has(ext)) {
      const pathCheck = sandboxPolicy(rawPath, context.workingDir);
      if (!pathCheck.ok) {
        return {
          content: `Error: ${pathCheck.error}. To read files outside the workspace, use the host_file_read tool instead.`,
          isError: true,
        };
      }
      return readDocumentFile(pathCheck.resolved);
    }

    // For audio files, delegate to the shared audio reader.
    if (AUDIO_EXTENSIONS.has(ext)) {
      const pathCheck = sandboxPolicy(rawPath, context.workingDir);
      if (!pathCheck.ok) {
        return {
          content: `Error: ${pathCheck.error}. To read files outside the workspace, use the host_file_read tool instead.`,
          isError: true,
        };
      }
      return readAudioFile(pathCheck.resolved);
    }

    const ops = new FileSystemOps((path, opts) =>
      sandboxPolicy(path, context.workingDir, opts),
    );

    const result = ops.readFileSafe({ path: rawPath, offset, limit });

    if (!result.ok) {
      const { error } = result;
      switch (error.code) {
        case "NOT_A_FILE":
          return {
            content: `Error: ${error.path} is a directory, not a file`,
            isError: true,
          };
        case "IO_ERROR":
          return {
            content: `Error reading file "${rawPath}": ${error.message}`,
            isError: true,
          };
        default: {
          const hint =
            error.code === "PATH_OUT_OF_BOUNDS"
              ? ". To read files outside the workspace, use the host_file_read tool instead."
              : "";
          return {
            content: `Error: ${error.message}${hint}`,
            isError: true,
          };
        }
      }
    }

    // Last guard: a binary file with an extension we do not recognise still
    // must not be emitted as text. Returning bytes is what made a PDF look
    // like readable content; the same is true of any binary.
    const binary = describeBinaryContent(result.value.content);
    if (binary) {
      return {
        content: `Error: "${rawPath}" appears to be a binary file (${binary}), not text. It was not read. If it is a document, a supported format is PDF, DOCX or XLSX; if it is an image, read it directly so it can be viewed.`,
        isError: true,
      };
    }

    return { content: result.value.content, isError: false };
  },
} satisfies ToolDefinition;

registerTool(fileReadTool);
