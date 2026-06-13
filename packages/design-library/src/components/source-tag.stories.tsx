import type { Meta, StoryObj } from "@storybook/react-vite";

import { MEMORY_TYPES, SourceTag } from "./source-tag";

const meta: Meta<typeof SourceTag> = {
  title: "Cue/SourceTag",
  component: SourceTag,
  argTypes: {
    memoryType: { control: "select", options: [undefined, ...MEMORY_TYPES] },
    showDot: { control: "boolean" },
  },
};

export default meta;

type Story = StoryObj<typeof SourceTag>;

export const Semantic: Story = {
  args: { memoryType: "semantic" },
};

export const WithDetail: Story = {
  args: { memoryType: "prospective", children: "prospective · Acme Q3" },
};

export const NeutralSource: Story = {
  args: { children: "source: gmail" },
};

export const AllMemoryTypes: Story = {
  render: () => (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      {MEMORY_TYPES.map((type) => (
        <SourceTag key={type} memoryType={type} />
      ))}
    </div>
  ),
};
