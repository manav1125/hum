import type { Meta, StoryObj } from "@storybook/react-vite";

import { Chip } from "./chip";
import { FocusCard } from "./focus-card";

const meta: Meta<typeof FocusCard> = {
  title: "Cue/FocusCard",
  component: FocusCard,
  decorators: [
    (Story) => (
      <div style={{ maxWidth: 420 }}>
        <Story />
      </div>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof FocusCard>;

export const NextMove: Story = {
  args: {
    eyebrow: "Next move",
    title: "Review the Acme follow-up",
    children: "Dana went quiet after the demo — a nudge keeps the deal warm.",
  },
};

export const WithActions: Story = {
  args: {
    eyebrow: "Next move",
    title: "Send the Q3 forecast to Dana",
    children: "Drafted from your last meeting.",
    actions: (
      <>
        <Chip>Open draft</Chip>
        <Chip>Snooze</Chip>
      </>
    ),
  },
};

export const TitleOnly: Story = {
  args: { title: "All caught up — nothing needs you right now." },
};
