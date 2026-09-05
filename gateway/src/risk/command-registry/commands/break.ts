import type { CommandRiskSpec } from "../../risk-types.js";

// Shell loop-control builtin — pure control flow, no side effects. Appears as
// a command segment when used after && / || inside a loop body.
const spec: CommandRiskSpec = {
  baseRisk: "low",
  argSchema: {
    positionals: "none",
  },
};

export default spec;
