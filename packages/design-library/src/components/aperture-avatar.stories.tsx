import type { Meta, StoryObj } from "@storybook/react-vite";

import { ApertureAvatar, type ApertureAvatarState } from "./aperture-avatar";

const meta: Meta<typeof ApertureAvatar> = {
  title: "Cue/ApertureAvatar",
  component: ApertureAvatar,
  argTypes: {
    state: {
      control: "select",
      options: ["idle", "listening", "thinking", "speaking", "acting"],
    },
    size: { control: { type: "range", min: 24, max: 120, step: 4 } },
  },
};

export default meta;

type Story = StoryObj<typeof ApertureAvatar>;

export const Idle: Story = {
  args: { state: "idle", size: 56 },
};

const STATES: ApertureAvatarState[] = [
  "idle",
  "listening",
  "thinking",
  "speaking",
  "acting",
];

export const AllStates: Story = {
  render: () => (
    <div style={{ display: "flex", gap: 24, alignItems: "center" }}>
      {STATES.map((state) => (
        <div
          key={state}
          style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}
        >
          <ApertureAvatar state={state} size={56} />
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--content-tertiary)" }}>
            {state}
          </span>
        </div>
      ))}
    </div>
  ),
};

export const Sizes: Story = {
  render: () => (
    <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
      {[24, 40, 56, 80].map((size) => (
        <ApertureAvatar key={size} state="idle" size={size} />
      ))}
    </div>
  ),
};
