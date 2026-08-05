import { RiskLevel } from "../../permissions/types.js";
import { registerTool } from "../registry.js";
import { FileSystemOps } from "../shared/filesystem/file-ops-service.js";
import { sandboxPolicy } from "../shared/filesystem/path-policy.js";
import {
  invalidToolInputResult,
  toToolInputSchema,
} from "../shared/zod-tool-schema.js";
import { fileListInputSchema } from "../tool-input-schemas.js";
import type {
  ToolContext,
  ToolDefinition,
  ToolExecutionResult,
} from "../types.js";

export const fileListTool = {
  name: "file_list",
  description:
    "List the contents of a directory on your own machine. Returns file and subdirectory names with type indicators and sizes.",
  category: "filesystem",
  executionTarget: "sandbox",
  defaultRiskLevel: RiskLevel.Low,

  // Derived from the same Zod source the pre-execution gate validates
  // against (`TOOL_INPUT_SCHEMAS`), so contract and validation cannot drift.
  input_schema: toToolInputSchema(fileListInputSchema, {
    advertiseRequired: ["activity"],
  }),

  async execute(
    input: Record<string, unknown>,
    context: ToolContext,
  ): Promise<ToolExecutionResult> {
    const parsed = fileListInputSchema.safeParse(input);
    if (!parsed.success) {
      return invalidToolInputResult("file_list", parsed.error);
    }
    const { path: rawPath, glob } = parsed.data;

    const ops = new FileSystemOps((path, opts) =>
      sandboxPolicy(path, context.workingDir, opts),
    );

    const result = ops.listDirSafe({ path: rawPath, glob });

    if (!result.ok) {
      const { error } = result;
      switch (error.code) {
        case "NOT_A_DIRECTORY":
          return {
            content: `Error: ${error.path} is not a directory`,
            isError: true,
          };
        case "NOT_FOUND":
          return {
            content: `Error: directory not found: ${error.path}`,
            isError: true,
          };
        default: {
          const hint =
            error.code === "PATH_OUT_OF_BOUNDS"
              ? ". To list files outside the workspace, use the host_bash tool instead."
              : "";
          return {
            content: `Error: ${error.message}${hint}`,
            isError: true,
          };
        }
      }
    }

    return { content: result.value.listing, isError: false };
  },
} satisfies ToolDefinition;

registerTool(fileListTool);
