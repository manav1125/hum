import { RiskLevel } from "../../permissions/types.js";
import { registerTool } from "../registry.js";
import { FileSystemOps } from "../shared/filesystem/file-ops-service.js";
import { formatEditDiff } from "../shared/filesystem/format-diff.js";
import { sandboxPolicy } from "../shared/filesystem/path-policy.js";
import {
  invalidToolInputResult,
  toToolInputSchema,
} from "../shared/zod-tool-schema.js";
import { fileEditInputSchema } from "../tool-input-schemas.js";
import type {
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "../types.js";

export const fileEditTool = {
  name: "file_edit",
  description:
    "Replace an exact string in a file on your own machine with a new string. Use this for surgical edits instead of rewriting entire files. Use host_file_edit for files on your guardian's device instead.",
  category: "filesystem",
  executionTarget: "sandbox",
  defaultRiskLevel: RiskLevel.Low,

  // Derived from the same Zod source the pre-execution gate validates
  // against (`TOOL_INPUT_SCHEMAS`), so contract and validation cannot drift.
  input_schema: toToolInputSchema(fileEditInputSchema, {
    advertiseRequired: ["activity"],
  }),

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const parsed = fileEditInputSchema.safeParse(input);
    if (!parsed.success) {
      return invalidToolInputResult("file_edit", parsed.error);
    }
    const {
      path: rawPath,
      old_string: oldString,
      new_string: newString,
    } = parsed.data;

    if (oldString === newString) {
      return {
        content: "Error: old_string and new_string must be different",
        isError: true,
      };
    }

    const replaceAll = parsed.data.replace_all === true;

    const ops = new FileSystemOps((path, opts) =>
      sandboxPolicy(path, context.workingDir, opts),
    );

    const result = ops.editFileSafe({
      path: rawPath,
      oldString,
      newString,
      replaceAll,
    });

    if (!result.ok) {
      const { error } = result;
      switch (error.code) {
        case "MATCH_NOT_FOUND":
          return {
            content: `Error: old_string not found in ${error.path}`,
            isError: true,
          };
        case "MATCH_AMBIGUOUS":
          return {
            content: `Error: old_string appears multiple times in ${error.path}. Provide more surrounding context to make it unique, or set replace_all to true.`,
            isError: true,
          };
        case "IO_ERROR":
          return {
            content: `Error editing file: ${error.message}`,
            isError: true,
          };
        default:
          return { content: `Error: ${error.message}`, isError: true };
      }
    }

    const {
      filePath,
      matchCount,
      oldContent,
      newContent,
      matchMethod,
      similarity,
      actualOld,
      actualNew,
    } = result.value;

    const diffText = formatEditDiff(actualOld, actualNew);

    if (replaceAll) {
      return {
        content: `Successfully replaced ${matchCount} occurrence${
          matchCount > 1 ? "s" : ""
        } in ${filePath}\n${diffText}`,
        isError: false,
        diff: { filePath, oldContent, newContent, isNewFile: false },
      };
    }

    const methodNote =
      matchMethod === "exact"
        ? ""
        : matchMethod === "whitespace"
          ? " (matched with whitespace normalization)"
          : ` (fuzzy matched, ${Math.round(similarity * 100)}% similar)`;
    return {
      content: `Successfully edited ${filePath}${methodNote}\n${diffText}`,
      isError: false,
      diff: { filePath, oldContent, newContent, isNewFile: false },
    };
  },
} satisfies ToolDefinition;

registerTool(fileEditTool);
