/**
 * Tests for `ListeningLanguageCard` (Settings → Voice).
 *
 * Strategy: mock the generated daemon SDK's `configGet`/`configPatch`
 * (spreading the real module, per the never-exhaustive-factory rule) and let
 * the real generated react-query hooks run against a fresh QueryClient, the
 * same shape as `manage-profiles-modal.test.tsx`. Drive the active assistant
 * id through the real selection store.
 *
 * Covers: the default render ("Multilingual" from the daemon schema
 * default), a pinned language render, opening the picker and persisting a
 * pick (`{ services: { stt: { language } } }` PATCH body), search-filtered
 * picking, and the provider gate (non-Deepgram providers get an honest note
 * instead of a picker).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

interface SttConfig {
  provider?: string;
  language?: string;
}

let sttState: SttConfig = {};
let patchBodies: unknown[] = [];
let patchShouldFail = false;

const buildConfig = () => ({ services: { stt: { ...sttState } } });

const actualSdk = await import("@/generated/daemon/sdk.gen");
mock.module("@/generated/daemon/sdk.gen", () => ({
  ...actualSdk,
  configGet: async () => ({ data: buildConfig() }),
  configPatch: async (args: {
    body: { services?: { stt?: SttConfig } };
  }) => {
    if (patchShouldFail) {
      throw new Error("patch failed");
    }
    patchBodies.push(args.body);
    sttState = { ...sttState, ...args.body.services?.stt };
    return { data: buildConfig() };
  },
}));

const toastErrors: string[] = [];
const actualToast = await import("@vellumai/design-library/components/toast");
mock.module("@vellumai/design-library/components/toast", () => ({
  ...actualToast,
  toast: {
    ...actualToast.toast,
    error: (message: string) => {
      toastErrors.push(message);
    },
  },
}));

const actualCaptureError = await import("@/lib/sentry/capture-error");
mock.module("@/lib/sentry/capture-error", () => ({
  ...actualCaptureError,
  captureError: () => {},
}));

const { ListeningLanguageCard } = await import(
  "@/domains/settings/pages/listening-language-card"
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
  return createElement(QueryClientProvider, { client }, children);
}

function renderCard(): ReturnType<typeof render> {
  return render(createElement(ListeningLanguageCard), { wrapper: Wrapper });
}

beforeEach(() => {
  sttState = { provider: "deepgram", language: "multi" };
  patchBodies = [];
  patchShouldFail = false;
  toastErrors.length = 0;
  useResolvedAssistantsStore.setState({ activeAssistantId: "asst-1" });
});

afterEach(() => {
  cleanup();
  useResolvedAssistantsStore.setState({ activeAssistantId: null });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ListeningLanguageCard", () => {
  test("renders the multilingual default with an enabled picker", async () => {
    const { getByText, getByRole } = renderCard();

    await waitFor(() => {
      expect(getByText("Multilingual")).toBeTruthy();
    });
    const change = getByRole("button", { name: "Change" });
    expect(change.hasAttribute("disabled")).toBe(false);
    // The hot-apply note is part of the card copy.
    expect(getByText(/Applies from your next spoken turn/)).toBeTruthy();
  });

  test("renders a pinned language by display name and a custom code verbatim", async () => {
    sttState = { provider: "deepgram", language: "de" };
    const first = renderCard();
    await waitFor(() => {
      expect(first.getByText("German")).toBeTruthy();
    });
    cleanup();

    sttState = { provider: "deepgram", language: "en-US" };
    const second = renderCard();
    await waitFor(() => {
      expect(second.getByText("en-US")).toBeTruthy();
    });
  });

  test("a pick persists services.stt.language and closes the picker", async () => {
    const { getByRole, getAllByRole, queryByRole, getByText } = renderCard();

    await waitFor(() => {
      expect(getByText("Multilingual")).toBeTruthy();
    });
    fireEvent.click(getByRole("button", { name: "Change" }));

    // Multilingual + English lead as peer rows, then the roster.
    const options = getAllByRole("option");
    expect(options[0]?.textContent).toContain("Multilingual");
    expect(options[1]?.textContent).toContain("English");
    expect(options.length).toBeGreaterThan(40);

    fireEvent.click(getByRole("option", { name: /Hindi/ }));

    await waitFor(() => {
      expect(patchBodies).toEqual([
        { services: { stt: { language: "hi" } } },
      ]);
    });
    // The modal closed on pick and the card row shows the new value.
    expect(queryByRole("listbox")).toBeNull();
    await waitFor(() => {
      expect(getByText("Hindi")).toBeTruthy();
    });
  });

  test("search filters the list and Enter picks the first match", async () => {
    const { getByRole, getAllByRole, getByText } = renderCard();

    await waitFor(() => {
      expect(getByText("Multilingual")).toBeTruthy();
    });
    fireEvent.click(getByRole("button", { name: "Change" }));

    const search = getByRole("combobox");
    fireEvent.change(search, { target: { value: "tami" } });
    const filtered = getAllByRole("option");
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.textContent).toContain("Tamil");

    fireEvent.keyDown(search, { key: "Enter" });
    await waitFor(() => {
      expect(patchBodies).toEqual([
        { services: { stt: { language: "ta" } } },
      ]);
    });
  });

  test("a failed PATCH surfaces a toast and keeps the configured value", async () => {
    patchShouldFail = true;
    const { getByRole, getByText } = renderCard();

    await waitFor(() => {
      expect(getByText("Multilingual")).toBeTruthy();
    });
    fireEvent.click(getByRole("button", { name: "Change" }));
    fireEvent.click(getByRole("option", { name: /Hindi/ }));

    await waitFor(() => {
      expect(toastErrors).toHaveLength(1);
    });
    expect(patchBodies).toEqual([]);
    // The optimistic pick rolled back to what config still says.
    await waitFor(() => {
      expect(getByText("Multilingual")).toBeTruthy();
    });
  });

  test("a non-Deepgram provider gets an honest note instead of a picker", async () => {
    sttState = { provider: "openai-whisper", language: "multi" };
    const { getByText, queryByRole } = renderCard();

    await waitFor(() => {
      expect(getByText(/OpenAI Whisper/)).toBeTruthy();
    });
    expect(getByText(/detects the spoken language on its own/)).toBeTruthy();
    expect(queryByRole("button", { name: "Change" })).toBeNull();
  });
});
