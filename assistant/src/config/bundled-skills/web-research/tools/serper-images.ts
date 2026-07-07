/**
 * `serper_images` — Google Images search via Serper
 * (POST https://google.serper.dev/images, X-API-KEY auth).
 *
 * Direct HTTPS call from the daemon process. Key resolution: daemon config
 * (`toolApis.serperKey`) → `CUE_SERPER_API_KEY` env var. A missing key
 * returns a clean, actionable error — never a throw.
 */
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { resolveToolApiKey } from "../../_shared/tool-api-keys.js";

const SERPER_IMAGES_URL = "https://google.serper.dev/images";

const NUM_CAP = 20;
const DEFAULT_NUM = 10;

interface SerperImageResult {
  title?: string;
  imageUrl?: string;
  thumbnailUrl?: string;
  imageWidth?: number;
  imageHeight?: number;
  source?: string;
  link?: string;
  position?: number;
}

interface SerperImagesResponse {
  images?: SerperImageResult[];
}

function formatResults(response: SerperImagesResponse): string {
  const images = (response.images ?? []).filter((img) => img.imageUrl);
  if (images.length === 0) {
    return "No images returned. Try a rephrased query.";
  }
  const lines = images.map((img, i) => {
    const title = img.title?.trim() || "(untitled)";
    const dims =
      img.imageWidth && img.imageHeight
        ? ` (${img.imageWidth}x${img.imageHeight})`
        : "";
    const source = img.source || img.link;
    return `${i + 1}. ${title}${dims}\n   image: ${img.imageUrl}${source ? `\n   source: ${source}` : ""}`;
  });
  return `Images (${images.length}):\n${lines.join("\n")}`;
}

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const query = input.query;
  if (typeof query !== "string" || !query.trim()) {
    return {
      content: "Provide a non-empty `query` string describing the images to find.",
      isError: true,
    };
  }

  const keyResolution = resolveToolApiKey("serper");
  if (!keyResolution.ok) {
    return { content: keyResolution.error, isError: true };
  }

  const num = Math.min(
    NUM_CAP,
    Math.max(1, Math.floor(Number(input.num) || DEFAULT_NUM)),
  );

  let response: SerperImagesResponse;
  try {
    const res = await fetch(SERPER_IMAGES_URL, {
      method: "POST",
      headers: {
        "X-API-KEY": keyResolution.key,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ q: query.trim(), num }),
      signal: context.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      return {
        content: `Serper image search failed (HTTP ${res.status}): ${text.slice(0, 500)}`,
        isError: true,
      };
    }
    response = JSON.parse(text) as SerperImagesResponse;
  } catch (err) {
    return {
      content: `Serper image search request failed: ${(err as Error).message}`,
      isError: true,
    };
  }

  return {
    content: `Serper image search for "${query.trim()}":\n\n${formatResults(response)}`,
    isError: false,
  };
}
