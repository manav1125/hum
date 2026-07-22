/**
 * Regression tests for the launch-kit result view's honesty contract.
 *
 * The shipped bug: every kit asset rendered the same grey placeholder tile and
 * a "· generating…" label suffix, no matter what the run had actually done —
 * so a kit whose assets had all completed looked identical to one still
 * working, and "Download all" was offered against nothing. These tests pin the
 * states apart.
 *
 * Renders via `@testing-library/react` (happy-dom registered in test-setup.ts).
 * The tiles' data queries are satisfied from a seeded React Query cache; no
 * `sdk.gen` call is made because the queries stay disabled without an active
 * assistant, and a disabled query still serves cached data.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render } from "@testing-library/react";

import {
  kitAssetsFromRows,
  KitResultView,
  parseKitOutputRef,
  type KitAsset,
} from "./create-fanout";

afterEach(() => {
  cleanup();
});

function renderKit(
  assets: KitAsset[],
  props: Partial<React.ComponentProps<typeof KitResultView>> = {},
  seed?: (client: QueryClient) => void,
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  seed?.(client);
  return render(
    <QueryClientProvider client={client}>
      <KitResultView
        title="JustCue.ai Landing launch kit"
        assets={assets}
        onRegenerateAsset={() => {}}
        onDownloadAll={() => {}}
        {...props}
      />
    </QueryClientProvider>,
  );
}

function downloadButton(): HTMLButtonElement {
  const button = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((b) => b.textContent?.includes("Download all"));
  if (!button) throw new Error("expected a Download all button");
  return button;
}

const RUNNING: KitAsset = {
  id: "a1",
  label: "One-pager",
  status: "running",
  updatedAt: Date.now() - 3 * 60_000,
};

const READY_DOC: KitAsset = {
  id: "a2",
  label: "One-pager",
  status: "done",
  output: { kind: "document", id: "doc-1" },
};

describe("parseKitOutputRef", () => {
  test("decodes the daemon's tagged output refs", () => {
    expect(parseKitOutputRef("att-1")).toEqual({
      kind: "attachment",
      id: "att-1",
    });
    expect(parseKitOutputRef("document:doc-1")).toEqual({
      kind: "document",
      id: "doc-1",
    });
    expect(parseKitOutputRef(null)).toBeNull();
    expect(parseKitOutputRef("document:")).toBeNull();
  });
});

describe("kitAssetsFromRows", () => {
  test("carries status, error, output and timestamp through to the view", () => {
    const [doc, social] = kitAssetsFromRows(
      [
        {
          id: "r1",
          format: "one_pager",
          status: "done",
          conversationId: "c1",
          outputRef: "document:doc-1",
          error: null,
          updatedAt: 1784730321847,
        },
        {
          id: "r2",
          format: "social",
          status: "failed",
          conversationId: "c2",
          outputRef: null,
          error: "boom",
          updatedAt: 1784730565825,
        },
      ],
      (format) => (format === "one_pager" ? "One-pager" : "3 social images"),
    );

    expect(doc).toEqual({
      id: "r1",
      label: "One-pager",
      status: "done",
      output: { kind: "document", id: "doc-1" },
      error: null,
      conversationId: "c1",
      updatedAt: 1784730321847,
      isSet: false,
    });
    expect(social.status).toBe("failed");
    expect(social.error).toBe("boom");
    expect(social.output).toBeNull();
    expect(social.isSet).toBe(true);
  });
});

describe("KitResultView asset states", () => {
  test("a running asset says it is generating, with how long it has been", () => {
    renderKit([RUNNING]);
    const card = document.querySelector('[data-testid="kit-asset-a1"]');
    expect(card?.getAttribute("data-status")).toBe("running");
    expect(card?.textContent).toContain("Generating…");
    expect(card?.textContent).toContain("3m in");
  });

  test("a long-running asset is called out rather than left spinning", () => {
    renderKit([{ ...RUNNING, updatedAt: Date.now() - 40 * 60_000 }]);
    const card = document.querySelector('[data-testid="kit-asset-a1"]');
    expect(card?.textContent).toContain("longer than usual");
  });

  test("a failed asset shows the reason and offers a retry", () => {
    renderKit([
      {
        id: "a3",
        label: "3 social images",
        status: "failed",
        error: "image model returned 402",
      },
    ]);
    const card = document.querySelector('[data-testid="kit-asset-a3"]');
    expect(card?.getAttribute("data-status")).toBe("failed");
    expect(card?.textContent).toContain("image model returned 402");
    expect(card?.textContent).toContain("retry");
    expect(card?.textContent).not.toContain("Generating");
  });

  test("a done asset that filed nothing says so instead of showing an empty tile", () => {
    renderKit([{ id: "a4", label: "Email announcement", status: "done" }]);
    const card = document.querySelector('[data-testid="kit-asset-a4"]');
    expect(card?.getAttribute("data-status")).toBe("done");
    expect(card?.textContent).toContain("nothing filed");
  });

  test("a document output renders the real document it produced", () => {
    renderKit([READY_DOC], {}, (client) => {
      client.setQueryData(["kit-asset-document", "doc-1"], {
        success: true,
        surfaceId: "doc-1",
        conversationId: "c1",
        title: "JustCue.ai — One-Page Summary",
        content: "# Summary",
        wordCount: 521,
        createdAt: 0,
        updatedAt: 0,
      });
    });
    const card = document.querySelector('[data-testid="kit-asset-a2"]');
    expect(card?.textContent).toContain("JustCue.ai — One-Page Summary");
    expect(card?.textContent).toContain("521 words");
    expect(card?.textContent).toContain("Ready");
  });
});

describe("KitResultView download affordance", () => {
  test("Download all is disabled while nothing has been produced", () => {
    renderKit([RUNNING]);
    expect(downloadButton().disabled).toBe(true);
    expect(document.body.textContent).toContain("Nothing to download yet");
  });

  test("Download all is disabled for assets that finished without filing anything", () => {
    renderKit([{ id: "a4", label: "Email announcement", status: "done" }]);
    expect(downloadButton().disabled).toBe(true);
  });

  test("Download all enables — and counts — once an asset has an output", () => {
    const onDownloadAll = mock(() => {});
    renderKit([READY_DOC, RUNNING], { onDownloadAll });
    const button = downloadButton();
    expect(button.disabled).toBe(false);
    expect(button.textContent).toContain("Download all (1)");
    fireEvent.click(button);
    expect(onDownloadAll).toHaveBeenCalledTimes(1);
  });
});

describe("KitResultView header honesty", () => {
  test("the sub-line reports real progress, not an asset count", () => {
    renderKit([READY_DOC, RUNNING]);
    expect(document.body.textContent).toContain("1 of 2 ready");
    expect(document.body.textContent).toContain("still generating");
  });

  test("the in-your-brand badge only appears when a brand kit was applied", () => {
    renderKit([READY_DOC]);
    expect(document.body.textContent).not.toContain("In your brand");
    cleanup();
    renderKit([READY_DOC], { branded: true });
    expect(document.body.textContent).toContain("In your brand");
  });

  test("a failed launch says nothing is generating", () => {
    renderKit([], { launchError: "500 Internal Server Error" });
    expect(document.body.textContent).toContain("couldn't be started");
    expect(document.body.textContent).toContain("500 Internal Server Error");
    expect(downloadButton().disabled).toBe(true);
  });
});
