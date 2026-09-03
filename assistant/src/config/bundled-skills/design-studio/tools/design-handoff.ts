import { randomUUID } from "node:crypto";

import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";

/**
 * design_handoff — open a Cue Design project from chat with the brief and brand
 * already loaded.
 *
 * For design-project work (a deck, a landing page, a prototype, a multi-artboard
 * layout) the studio is the right surface, not chat. This tool creates the
 * project on the Cue Design sidecar with the user's brief pre-loaded into the
 * composer and the Cue brand system attached, then returns a deep link that
 * drops the user straight into that project — no blank studio, no re-typing.
 *
 * The sidecar is reached over the private network at DESIGN_UPSTREAM_URL (an
 * outbound call to a separate service, like the hyperframes bridge). When
 * design isn't configured, the tool returns a clear message rather than
 * throwing.
 */

const CUE_DESIGN_SYSTEM_ID = "user:cue";

function designUpstream(): string | null {
  const raw = process.env.DESIGN_UPSTREAM_URL?.trim();
  if (!raw) return null;
  return raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

function designOrigin(): string {
  const host = process.env.DESIGN_HOST?.trim();
  return host ? `https://${host}` : "https://localhost";
}

function safeProjectId(): string {
  // The sidecar's isSafeId allows [A-Za-z0-9._-]; a uuid fits.
  return `cue-${randomUUID()}`;
}

export async function run(
  input: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolExecutionResult> {
  const title =
    typeof input.title === "string" && input.title.trim()
      ? input.title.trim().slice(0, 120)
      : "";
  const brief = typeof input.brief === "string" ? input.brief.trim() : "";

  if (!title) {
    return {
      content:
        'design_handoff needs a short `title` for the project (e.g. "Raise Pitch Deck").',
      isError: true,
    };
  }
  if (!brief) {
    return {
      content:
        "design_handoff needs a `brief`: the full design request to pre-load into the studio composer (what to make, for whom, key content, any style direction).",
      isError: true,
    };
  }

  const upstream = designUpstream();
  if (!upstream) {
    return {
      content:
        "Cue Design isn't set up on this Cue, so I can't open a design project. The DESIGN_UPSTREAM_URL for the Cue Design sidecar isn't configured.",
      isError: true,
    };
  }

  const id = safeProjectId();
  // Attach the Cue brand system, but degrade gracefully: if it isn't published
  // on this instance the create would 400, so retry once without it rather
  // than fail the handoff.
  async function create(withBrand: boolean): Promise<Response> {
    return fetch(`${upstream}/api/projects`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: designOrigin() },
      body: JSON.stringify({
        id,
        name: title,
        pendingPrompt: brief,
        ...(withBrand ? { designSystemId: CUE_DESIGN_SYSTEM_ID } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });
  }

  let res: Response;
  try {
    res = await create(true);
    if (res.status === 400) {
      // Most likely the brand system isn't published here; try without it.
      const body = await res.clone().text();
      if (/design.system/i.test(body)) res = await create(false);
    }
  } catch (err) {
    return {
      content: `Couldn't reach Cue Design to set up the project: ${(err as Error).message}`,
      isError: true,
    };
  }

  if (!res.ok) {
    let detail = `status ${res.status}`;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (body?.error) detail = JSON.stringify(body.error);
    } catch {
      /* non-JSON */
    }
    return {
      content: `Couldn't create the design project: ${detail}`,
      isError: true,
    };
  }

  // Relative app link — opens the Design surface deep-linked to the project.
  const openPath = `/assistant/design?project=${encodeURIComponent(id)}`;

  return {
    content: JSON.stringify(
      {
        message:
          "Cue Design project created with the brief pre-loaded. Share the open link with the user so they can jump straight in.",
        projectId: id,
        title,
        openInCueDesign: openPath,
      },
      null,
      2,
    ),
    isError: false,
  };
}
