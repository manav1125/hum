import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

mock.module(
  "@/domains/chat/components/chat-attachments/attachment-preview-modal",
  () => ({
    AttachmentPreviewModal: ({
      attachment,
    }: {
      attachment: { id: string };
    }) => (
      <div data-testid="preview-modal" data-attachment-id={attachment.id} />
    ),
  }),
);

import type { DisplayAttachment } from "@/domains/chat/types/types";

import { MessageAttachments } from "@/domains/chat/components/chat-attachments/message-attachments";
import { useViewerStore } from "@/stores/viewer-store";

afterAll(() => {
  mock.restore();
});
afterEach(() => {
  cleanup();
});

const xlsx: DisplayAttachment = {
  id: "xlsx-1",
  filename: "SaaS Financial Model.xlsx",
  mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  sizeBytes: 48_128,
  previewUrl: null,
};

const xlsxByExtensionOnly: DisplayAttachment = {
  id: "xlsx-2",
  filename: "model.xlsx",
  // Some daemon paths hand back a generic octet-stream mime; the extension
  // must still route the chip to the viewer.
  mimeType: "application/octet-stream",
  sizeBytes: 10_000,
  previewUrl: null,
};

const csv: DisplayAttachment = {
  id: "csv-1",
  filename: "export.csv",
  mimeType: "text/csv",
  sizeBytes: 2_048,
  previewUrl: null,
};

const pdf: DisplayAttachment = {
  id: "pdf-1",
  filename: "report.pdf",
  mimeType: "application/pdf",
  sizeBytes: 2_048,
  previewUrl: null,
};

describe("MessageAttachments — spreadsheet viewer wiring", () => {
  test("clicking an .xlsx chip opens the native viewer (loadSpreadsheet), not the preview modal", () => {
    const onOpenSpreadsheet = mock(() => {});
    const { getByRole, queryByTestId } = render(
      <MessageAttachments
        attachments={[xlsx]}
        onOpenSpreadsheet={onOpenSpreadsheet}
      />,
    );

    fireEvent.click(getByRole("button", { name: "SaaS Financial Model.xlsx" }));

    expect(onOpenSpreadsheet).toHaveBeenCalledTimes(1);
    expect(onOpenSpreadsheet).toHaveBeenCalledWith(
      "xlsx-1",
      "SaaS Financial Model.xlsx",
    );
    // The generic preview modal must NOT open for a viewable spreadsheet.
    expect(queryByTestId("preview-modal")).toBeNull();
  });

  test("routes an .xlsx to the viewer even when the mime is a generic octet-stream", () => {
    const onOpenSpreadsheet = mock(() => {});
    const { getByRole } = render(
      <MessageAttachments
        attachments={[xlsxByExtensionOnly]}
        onOpenSpreadsheet={onOpenSpreadsheet}
      />,
    );

    fireEvent.click(getByRole("button", { name: "model.xlsx" }));

    expect(onOpenSpreadsheet).toHaveBeenCalledWith("xlsx-2", "model.xlsx");
  });

  test("a .csv chip does NOT open the viewer — ExcelJS can't parse it — and falls back to the preview modal", () => {
    const onOpenSpreadsheet = mock(() => {});
    const { getByRole, getByTestId } = render(
      <MessageAttachments
        attachments={[csv]}
        onOpenSpreadsheet={onOpenSpreadsheet}
      />,
    );

    fireEvent.click(getByRole("button", { name: "export.csv" }));

    expect(onOpenSpreadsheet).not.toHaveBeenCalled();
    expect(
      getByTestId("preview-modal").getAttribute("data-attachment-id"),
    ).toBe("csv-1");
  });

  test("a non-spreadsheet chip still opens the preview modal", () => {
    const onOpenSpreadsheet = mock(() => {});
    const { getByRole, getByTestId } = render(
      <MessageAttachments
        attachments={[pdf]}
        onOpenSpreadsheet={onOpenSpreadsheet}
      />,
    );

    fireEvent.click(getByRole("button", { name: "report.pdf" }));

    expect(onOpenSpreadsheet).not.toHaveBeenCalled();
    expect(
      getByTestId("preview-modal").getAttribute("data-attachment-id"),
    ).toBe("pdf-1");
  });

  test("without onOpenSpreadsheet, an .xlsx still opens the viewer via the store", () => {
    // This used to fall back to the preview modal, and on the live render
    // path the prop was never threaded — so clicking a spreadsheet opened a
    // Download modal instead of the grid. The chip now reaches the viewer
    // store directly; the prop is only a fast path.
    const loadSpreadsheet = mock(() => {});
    const original = useViewerStore.getState().loadSpreadsheet;
    useViewerStore.setState({ loadSpreadsheet });

    try {
      const { getByRole, queryByTestId } = render(
        <MessageAttachments attachments={[xlsx]} />,
      );

      fireEvent.click(
        getByRole("button", { name: "SaaS Financial Model.xlsx" }),
      );

      expect(loadSpreadsheet).toHaveBeenCalledWith(
        "xlsx-1",
        "SaaS Financial Model.xlsx",
      );
      expect(queryByTestId("preview-modal")).toBeNull();
    } finally {
      useViewerStore.setState({ loadSpreadsheet: original });
    }
  });
});
