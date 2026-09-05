import type { CommandRiskSpec } from "../../risk-types.js";

const spec: CommandRiskSpec = {
  baseRisk: "medium",
  argSchema: {
    valueFlags: [
      "-O",
      "--output-document",
      "-o",
      "--output-file",
      "--post-file",
      "--method",
      "--body-data",
      "--header",
    ],
    positionals: "none",
  },
  argRules: [
    {
      id: "wget:post-file",
      flags: ["--post-file"],
      risk: "high",
      reason: "Uploads file contents",
      externalDestinationOnly: true,
    },
    {
      id: "wget:output-sensitive",
      flags: ["-O", "--output-document"],
      valuePattern: "(?:^|/)(?:\\.ssh|\\.gnupg|\\.aws|\\.config|\\.env)\\b",
      risk: "high",
      reason: "Writes response to sensitive path",
    },
    {
      // Same host-termination guard as curl:localhost (userinfo trick).
      id: "wget:localhost",
      valuePattern:
        "^[\"']?https?://(localhost|127\\.0\\.0\\.1|\\[::1\\])(:\\d+)?([\"']?$|/)",
      risk: "low",
      reason: "Local request",
    },
  ],
};

export default spec;
