import type { Meta, StoryObj } from "@storybook/react-vite";

import { VoiceOrb, type VoiceOrbState } from "./voice-orb";

const meta: Meta<typeof VoiceOrb> = {
  title: "Cue/VoiceOrb",
  component: VoiceOrb,
  argTypes: {
    state: {
      control: "select",
      options: ["idle", "listening", "thinking", "speaking"],
    },
    size: { control: { type: "range", min: 48, max: 160, step: 8 } },
  },
  decorators: [
    (Story) => (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          minHeight: 220,
          borderRadius: 16,
          background: "var(--surface-ink)",
        }}
      >
        <Story />
      </div>
    ),
  ],
};

export default meta;

type Story = StoryObj<typeof VoiceOrb>;

export const Listening: Story = {
  args: { state: "listening", size: 96 },
};

const STATES: VoiceOrbState[] = ["idle", "listening", "thinking", "speaking"];

export const AllStates: Story = {
  render: () => (
    <div style={{ display: "flex", gap: 40, alignItems: "center" }}>
      {STATES.map((state) => (
        <VoiceOrb key={state} state={state} size={84} />
      ))}
    </div>
  ),
};
