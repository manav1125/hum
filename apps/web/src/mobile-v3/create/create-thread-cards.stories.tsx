/**
 * Create — the cards that land in a thread.
 *
 * The set is chosen to show the three states side by side, because the risk they
 * carry is comparative: a reviewer should be able to see at a glance that the
 * failed card offers none of the affordances the delivered one does.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";

import "../mv3.css";

import {
  deliverBuild,
  failBuild,
  observeStep,
  startBuild,
} from "./create-build-model";
import { adjacentOfferFor, remixChipsFor } from "./create-followups";
import { CreateArtefactCard, CreateBuildingCard } from "./create-thread-cards";

const ASSET = { name: "Northwind — Series A", mode: "slides" };

function Thread({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        width: 390,
        padding: "16px 18px",
        background: "var(--mv3-bg)",
        borderRadius: 24,
        border: "1px solid var(--mv3-card-border)",
      }}
    >
      {children}
    </div>
  );
}

const base = () =>
  startBuild({
    conversationId: "conv-1",
    typeId: "slides",
    templateId: "startup",
    now: Date.now() - 50_000,
  });

const meta = {
  title: "Mobile v3/Create Cards",
  parameters: { layout: "centered" },
  decorators: [
    (Story) => (
      <Thread>
        <Story />
      </Thread>
    ),
  ],
} satisfies Meta;

export default meta;
type Story = StoryObj;

/**
 * Mid-build. The eyebrow says BUILDING with a real elapsed clock — there is no
 * ordinal and no percentage, because the pipeline emits neither. The tiles are
 * the chosen template's real layout rhythm, captioned as structure.
 */
export const Building: Story = {
  render: () => (
    <CreateBuildingCard
      state={observeStep(base(), "writing the traction slide")}
    />
  ),
};

/** Before the first step arrives — honest, rather than an invented step. */
export const JustStarted: Story = {
  render: () => <CreateBuildingCard state={base()} />,
};

/** Delivered, with a proven project + Library destination. */
export const Delivered: Story = {
  render: () => {
    const state = deliverBuild(base(), {
      name: "Northwind — Series A",
      typeId: "slides",
      measure: "12 slides",
      openHref: "/apps/1",
    });
    return (
      <CreateArtefactCard
        state={state}
        destination={{
          conversationId: "conv-1",
          library: { kind: "document", id: "doc-1" },
          project: "Close the seed",
        }}
        remixChips={remixChipsFor("slides", ASSET)}
        offer={adjacentOfferFor("slides", ASSET)}
        onOpen={() => {}}
        onShare={() => {}}
        onRemix={() => {}}
        onAcceptOffer={() => {}}
        onDeclineOffer={() => {}}
      />
    );
  },
};

/**
 * Delivered with nothing proven beyond the thread. The filing line degrades
 * rather than inventing a project — this is the common case today.
 */
export const DeliveredThreadOnly: Story = {
  render: () => {
    const state = deliverBuild(base(), {
      name: "Northwind — Series A",
      typeId: "slides",
      measure: "12 slides",
      openHref: "/apps/1",
    });
    return (
      <CreateArtefactCard
        state={state}
        destination={{ conversationId: "conv-1" }}
        remixChips={remixChipsFor("slides", ASSET)}
        offer={adjacentOfferFor("slides", ASSET)}
        onOpen={() => {}}
        onShare={() => {}}
        onRemix={() => {}}
        onAcceptOffer={() => {}}
        onDeclineOffer={() => {}}
      />
    );
  },
};

/** A real failure — no cover, no Open, no chips, no filing claim. */
export const Failed: Story = {
  render: () => {
    const state = failBuild(base(), {
      message:
        "Replicate rejected the request — no API token is configured, so I never started the render.",
      retryable: true,
    });
    return (
      <CreateArtefactCard
        state={state}
        destination={{ conversationId: "conv-1" }}
        remixChips={remixChipsFor("slides", ASSET)}
        offer={adjacentOfferFor("slides", ASSET)}
        onRemix={() => {}}
        onAcceptOffer={() => {}}
        onDeclineOffer={() => {}}
        onRetry={() => {}}
      />
    );
  },
};

/** A run that ended with no file. A no-op is not a success. */
export const ProducedNothing: Story = {
  render: () => {
    const state = deliverBuild(base(), null);
    return (
      <CreateArtefactCard
        state={state}
        destination={{ conversationId: "conv-1" }}
        remixChips={[]}
        offer={null}
        onRemix={() => {}}
        onAcceptOffer={() => {}}
        onDeclineOffer={() => {}}
        onRetry={() => {}}
      />
    );
  },
};
