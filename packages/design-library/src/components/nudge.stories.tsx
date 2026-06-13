import type { Meta, StoryObj } from "@storybook/react-vite";

import { Chip } from "./chip";
import { Nudge } from "./nudge";
import { SourceTag } from "./source-tag";

const meta: Meta<typeof Nudge> = {
  title: "Cue/Nudge",
  component: Nudge,
  argTypes: {
    tone: { control: "select", options: ["info", "commitment", "neutral"] },
    onDismiss: { action: "dismissed" },
  },
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 420 }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof Nudge>;

export const Info: Story = {
  args: {
    tone: "info",
    title: "Dana has not replied",
    children: "It has been 3 days since your forecast email.",
  },
};

export const Commitment: Story = {
  args: {
    tone: "commitment",
    title: "You promised the forecast by Friday",
    children: "From your Acme sync on Jun 12.",
    meta: <SourceTag memoryType="prospective">prospective · Acme Q3</SourceTag>,
  },
};

export const WithActions: Story = {
  args: {
    tone: "info",
    title: "Reservation needs confirming",
    actions: (
      <>
        <Chip selected>Confirm</Chip>
        <Chip>Not now</Chip>
      </>
    ),
    onDismiss: () => {},
  },
};

export const AllTones: Story = {
  render: () => (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {(["info", "commitment", "neutral"] as const).map((tone) => (
        <Nudge key={tone} tone={tone} title={`${tone} nudge`}>
          Example {tone} nudge from the proactivity loop.
        </Nudge>
      ))}
    </div>
  ),
};
