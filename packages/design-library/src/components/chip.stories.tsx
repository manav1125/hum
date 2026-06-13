import type { Meta, StoryObj } from "@storybook/react-vite";
import { Sparkles } from "lucide-react";

import { Chip } from "./chip";

const meta: Meta<typeof Chip> = {
  title: "Cue/Chip",
  component: Chip,
  argTypes: {
    size: { control: "inline-radio", options: ["sm", "md"] },
    selected: { control: "boolean" },
  },
};

export default meta;

type Story = StoryObj<typeof Chip>;

export const Default: Story = {
  args: { children: "Draft follow-up to Dana" },
};

export const Selected: Story = {
  args: { children: "This week", selected: true },
};

export const WithIcon: Story = {
  args: {
    children: "Start meeting capture",
    leftIcon: <Sparkles />,
  },
};

export const SuggestionRow: Story = {
  render: () => (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      <Chip selected>All</Chip>
      <Chip>Email</Chip>
      <Chip>Tasks</Chip>
      <Chip>Calls</Chip>
      <Chip>Approvals</Chip>
    </div>
  ),
};

export const Sizes: Story = {
  render: () => (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <Chip size="sm">Small</Chip>
      <Chip size="md">Medium</Chip>
    </div>
  ),
};
