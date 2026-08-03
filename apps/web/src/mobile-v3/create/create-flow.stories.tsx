/**
 * Create — the v27 flow, driveable.
 *
 * `CreateFlow` takes `onRun` and holds no stores, so the whole spine can be
 * driven here at a real phone size, in both themes, at both detents, with no
 * daemon. This is the harness the surface was verified in and the one design can
 * click through.
 *
 * The "knows nothing" and "knows something" stories are the pair that matters:
 * rule 1 has to hold in BOTH, and they render visibly differently — one states
 * what Cue has, the other says plainly that it has nothing yet.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";

import "../mv3.css";

import { CreateFlow } from "./create-flow";
import type { KnownFact } from "./create-known-facts";

/** A 390×844 phone, the size the spec is drawn at. */
function Phone({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        width: 390,
        height: 844,
        position: "relative",
        overflow: "hidden",
        borderRadius: 38,
        border: "1px solid var(--mv3-card-border)",
        background: "var(--mv3-bg)",
        // A transform makes this element the containing block for the sheet's
        // `position: fixed`, so the detents are measured against the phone
        // rather than the browser window — otherwise 42% means 42% of the
        // reviewer's monitor and the peek is never really seen.
        transform: "translateZ(0)",
      }}
    >
      {children}
    </div>
  );
}

const meta = {
  title: "Mobile v3/Create",
  component: CreateFlow,
  parameters: { layout: "centered" },
  decorators: [
    (Story) => (
      <Phone>
        <Story />
      </Phone>
    ),
  ],
  args: {
    open: true,
    onClose: () => {},
    // The harness stops at the build boundary on purpose: `CreateFlow` hands
    // off a BuildRequest and never runs anything itself, which is exactly what
    // makes the whole spine driveable here with no daemon.
    onRun: () => {},
  },
} satisfies Meta<typeof CreateFlow>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * The honest default: no brand kit, no memory. The fill step says so rather
 * than claiming to remember things, and still asks fewer questions than the
 * template declares because optional inputs are deferred.
 */
export const KnowsNothing: Story = {
  args: { known: [], brandName: null },
};

/**
 * With a real active Brand Kit and real retrieved memory statements. The known
 * block appears, each row carrying where it came from.
 */
export const KnowsSomething: Story = {
  args: {
    brandName: "Northwind",
    known: [
      { id: "b", label: "Brand", value: "Northwind", origin: "brand" },
      {
        id: "m1",
        label: "Raise",
        value: "Northwind is raising a seed round and wants to close it this quarter.",
        origin: "memory",
      },
      {
        id: "m2",
        label: "Company",
        value: "Northwind",
        fieldKey: "company",
        origin: "context",
      },
    ] satisfies KnownFact[],
  },
};

/**
 * A suggestion on the entry — the route that skips the gallery because the
 * template is already known. Only rendered from a resolved record; the
 * `because` line is required, so a suggestion can never appear unexplained.
 */
export const WithSuggestion: Story = {
  args: {
    brandName: "Northwind",
    known: [{ id: "b", label: "Brand", value: "Northwind", origin: "brand" }],
    suggestions: [
      {
        templateId: "form-investor-pitch",
        typeId: "slides",
        title: "Investor pitch deck",
        because: "You opened this template yesterday",
      },
    ],
  },
};
