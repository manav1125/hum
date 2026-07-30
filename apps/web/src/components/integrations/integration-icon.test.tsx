/**
 * Tests for `IntegrationIcon`'s logo resolution.
 *
 * The in-chat "connectors that could help" card rendered HubSpot as a yellow
 * "HU" and WhatsApp as a blue "WH" because `KNOWN_LOGO_URLS` listed only five
 * providers and everything else fell through to initials. Since every
 * connector in the catalogue is a Composio toolkit, an unknown key now resolves
 * to Composio's per-slug logo endpoint instead.
 *
 * These assert the resolution ORDER, which is the part that silently degrades:
 * an explicit `logoUrl` wins, then a local asset, then the remote fallback, and
 * only a failed image load reaches initials.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { cleanup, fireEvent, render } from "@testing-library/react";

import { IntegrationIcon } from "@/components/integrations/integration-icon";

afterEach(cleanup);

function imgOf(container: HTMLElement): HTMLImageElement | null {
  return container.querySelector("img");
}

describe("IntegrationIcon logo resolution", () => {
  test("a provider with no local asset uses the Composio logo, not initials", () => {
    // The exact regression from the screenshot: HubSpot has no bundled asset.
    const { container } = render(
      <IntegrationIcon
        providerKey="hubspot"
        displayName="HubSpot"
        logoUrl={null}
      />,
    );

    const img = imgOf(container);
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBe(
      "https://logos.composio.dev/api/hubspot",
    );
    // Initials must not be what the user sees.
    expect(container.textContent).not.toContain("HU");
  });

  test("whatsapp likewise resolves to a real logo", () => {
    const { container } = render(
      <IntegrationIcon
        providerKey="whatsapp"
        displayName="WhatsApp"
        logoUrl={null}
      />,
    );

    expect(imgOf(container)?.getAttribute("src")).toBe(
      "https://logos.composio.dev/api/whatsapp",
    );
    expect(container.textContent).not.toContain("WH");
  });

  test("a bundled local asset is preferred over the remote fallback", () => {
    // Gmail shipped in public/images/integrations for months but was missing
    // from the map, so it rendered as initials despite the file existing.
    const { container } = render(
      <IntegrationIcon providerKey="gmail" displayName="Gmail" logoUrl={null} />,
    );

    const src = imgOf(container)?.getAttribute("src") ?? "";
    expect(src).toContain("gmail.svg");
    expect(src).not.toContain("logos.composio.dev");
  });

  test("an explicit logoUrl outranks both", () => {
    const { container } = render(
      <IntegrationIcon
        providerKey="hubspot"
        displayName="HubSpot"
        logoUrl="https://example.test/custom.svg"
      />,
    );

    expect(imgOf(container)?.getAttribute("src")).toBe(
      "https://example.test/custom.svg",
    );
  });

  test("provider keys are matched case-insensitively", () => {
    const { container } = render(
      <IntegrationIcon providerKey="HubSpot" displayName="HubSpot" logoUrl={null} />,
    );

    expect(imgOf(container)?.getAttribute("src")).toBe(
      "https://logos.composio.dev/api/hubspot",
    );
  });

  test("a logo that fails to load still degrades to initials", () => {
    // The fallback must survive a 404 or a blocked request — otherwise the fix
    // trades coloured initials for a broken-image glyph.
    const { container } = render(
      <IntegrationIcon
        providerKey="doesnotexist"
        displayName="Does Not Exist"
        logoUrl={null}
      />,
    );

    const img = imgOf(container);
    expect(img).not.toBeNull();
    fireEvent.error(img!);

    expect(imgOf(container)).toBeNull();
    expect(container.textContent).toContain("DO");
  });
});
