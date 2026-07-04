/**
 * Avatar API functions for fetching character components and traits.
 *
 * Targets the gateway-proxied `/v1/assistants/{assistant_id}/...`
 * namespace. The gateway runtime-proxy rewrites `/v1/assistants/<id>/X`
 * to `/v1/X` before forwarding to the daemon, which registers avatar
 * and workspace routes flat (`/v1/avatar/...`, `/v1/workspace/...`).
 */
import { client } from "@/generated/api/client.gen";
import {
  avatarCharactercomponentsGet,
  avatarImagePost,
  avatarRemovePost,
  avatarRenderfromtraitsPost,
  avatarStateGet,
  workspaceDeletePost,
  workspaceFileGet,
  workspaceWritePost,
} from "@/generated/daemon/sdk.gen";
import { resolveSupportsAvatarStateManifest } from "@/lib/backwards-compat/avatar-state-manifest";
import type {
  AvatarState,
  CharacterComponents,
  CharacterTraits,
} from "@/types/avatar";
import { isAvatarState, isCharacterTraits } from "@/types/avatar";
import { assertHasResponse } from "@/utils/api-errors";

const AVATAR_IMAGE_PATH = "data/avatar/avatar-image.png";
const CHARACTER_TRAITS_PATH = "data/avatar/character-traits.json";

/**
 * Session-scoped absence cache for the avatar sidecar workspace files.
 *
 * Assistants without the avatar-state manifest are probed via raw workspace
 * reads of `avatar-image.png` / `character-traits.json`, which 404 when no
 * custom avatar exists. The browser logs every 404 network response to the
 * console regardless of JS-side handling, so re-probing on each route
 * navigation spams the console. A definitive 404 ("the file does not exist")
 * is remembered here and the request is skipped for the rest of the session.
 *
 * Only a real 404 is cached — transport failures and other error statuses
 * are not, so a flaky network never hides an existing avatar. The cache is
 * cleared by every write path that can (re)create the files (upload /
 * render-from-traits / remove) and by the avatar invalidation signals in
 * `use-assistant-avatar` / `use-assistant-resource-sync`, so a newly
 * created avatar is still picked up with at most one fresh probe.
 */
const absentAvatarFiles = new Set<string>();

function avatarFileKey(assistantId: string, path: string): string {
  return `${assistantId}\u0000${path}`;
}

/**
 * Forget cached "file is absent" results (for one assistant, or all when no
 * id is given) so the next avatar fetch re-probes the workspace files.
 */
export function clearAvatarFileAbsenceCache(assistantId?: string): void {
  if (assistantId === undefined) {
    absentAvatarFiles.clear();
    return;
  }
  for (const key of Array.from(absentAvatarFiles)) {
    if (key.startsWith(`${assistantId}\u0000`)) absentAvatarFiles.delete(key);
  }
}

/**
 * Fetch the authoritative avatar render manifest from the daemon's
 * `GET /avatar/state` endpoint.
 *
 * Returns `null` only on transport failure. A 200 response with
 * `{ kind: "none" }` is a valid state (an empty avatar), not `null`.
 */
export async function fetchAvatarState(
  assistantId: string,
): Promise<AvatarState | null> {
  try {
    const { data, error, response } = await avatarStateGet({
      path: { assistant_id: assistantId },
      throwOnError: false,
    });
    assertHasResponse(response, error, "Failed to fetch avatar state");
    if (!response.ok || !isAvatarState(data)) {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

export async function fetchCharacterComponents(
  assistantId: string,
): Promise<CharacterComponents | null> {
  try {
    const { data, error, response } = await avatarCharactercomponentsGet({
      path: { assistant_id: assistantId },
      throwOnError: false,
    });
    assertHasResponse(response, error, "Failed to fetch character components");
    if (!response.ok || !data) {
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

export async function fetchCharacterTraits(
  assistantId: string,
): Promise<CharacterTraits | null> {
  // Known-absent this session (a previous probe got a definitive 404):
  // skip the request entirely so the console isn't spammed with a 404 on
  // every route load. See `absentAvatarFiles`.
  const cacheKey = avatarFileKey(assistantId, CHARACTER_TRAITS_PATH);
  if (absentAvatarFiles.has(cacheKey)) return null;
  try {
    const { data, error, response } = await workspaceFileGet({
      path: { assistant_id: assistantId },
      query: { path: CHARACTER_TRAITS_PATH },
      throwOnError: false,
    });
    assertHasResponse(response, error, "Failed to fetch character traits");
    if (response.status === 404) absentAvatarFiles.add(cacheKey);
    if (!response.ok || !data) {
      return null;
    }

    const parsed: unknown = JSON.parse(data.content);
    if (!isCharacterTraits(parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function saveCharacterTraits(
  assistantId: string,
  traits: CharacterTraits,
): Promise<boolean> {
  try {
    const { error, response } = await avatarRenderfromtraitsPost({
      path: { assistant_id: assistantId },
      body: traits,
      throwOnError: false,
    });
    assertHasResponse(response, error, "Failed to save character traits");
    // The daemon (re)creates the sidecar files — forget any cached 404s so
    // the next avatar fetch actually probes them again.
    if (response.ok) clearAvatarFileAbsenceCache(assistantId);
    return response.ok;
  } catch {
    return false;
  }
}

export async function uploadAvatarImage(
  assistantId: string,
  file: File,
): Promise<boolean> {
  try {
    const arrayBuffer = await file.arrayBuffer();
    const base64 = btoa(
      new Uint8Array(arrayBuffer).reduce(
        (acc, byte) => acc + String.fromCharCode(byte),
        "",
      ),
    );

    if (!(await resolveSupportsAvatarStateManifest())) {
      return uploadAvatarImageLegacy(assistantId, base64);
    }

    const { error, response } = await avatarImagePost({
      path: { assistant_id: assistantId },
      body: { content: base64, encoding: "base64" },
      throwOnError: false,
    });
    assertHasResponse(response, error, "Failed to upload avatar image");
    // The image file now exists — forget any cached 404s.
    if (response.ok) clearAvatarFileAbsenceCache(assistantId);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Pre-manifest custom-image upload for assistants without the avatar
 * state manifest: write the PNG to the workspace and delete any
 * character-traits sidecar so the legacy file-existence inference resolves
 * to a custom image. Used as the fallback for {@link uploadAvatarImage};
 * see `lib/backwards-compat/avatar-state-manifest.ts`.
 */
async function uploadAvatarImageLegacy(
  assistantId: string,
  base64: string,
): Promise<boolean> {
  const { error: writeError, response: writeResponse } =
    await workspaceWritePost({
      path: { assistant_id: assistantId },
      body: {
        path: AVATAR_IMAGE_PATH,
        content: base64,
        encoding: "base64",
      },
      throwOnError: false,
    });
  assertHasResponse(writeResponse, writeError, "Failed to upload avatar image");
  if (!writeResponse.ok) {
    return false;
  }

  await workspaceDeletePost({
    path: { assistant_id: assistantId },
    body: { path: CHARACTER_TRAITS_PATH },
    throwOnError: false,
  });

  // The image file now exists (and the traits sidecar was just deleted) —
  // reset the absence cache so the next fetch reflects the new reality.
  clearAvatarFileAbsenceCache(assistantId);
  return true;
}

/**
 * Remove the custom avatar image, restoring Cue's default aperture mark.
 *
 * Targets the daemon's `POST /avatar/remove` endpoint, which deletes the
 * uploaded PNG (and any character sidecar) and resets the avatar state to
 * `none` — which `ChatAvatar` renders as the brand ApertureAvatar.
 * Returns `false` on transport failure.
 */
export async function removeAvatarImage(assistantId: string): Promise<boolean> {
  try {
    const { error, response } = await avatarRemovePost({
      path: { assistant_id: assistantId },
      throwOnError: false,
    });
    assertHasResponse(response, error, "Failed to remove avatar image");
    // Files were deleted server-side; clear rather than pre-mark absent so
    // the cache only ever holds observed 404s.
    if (response.ok) clearAvatarFileAbsenceCache(assistantId);
    return response.ok;
  } catch {
    return false;
  }
}

export async function fetchAvatarImageUrl(
  assistantId: string,
): Promise<string | null> {
  // Known-absent this session (a previous probe got a definitive 404):
  // skip the request entirely so the console isn't spammed with a 404 on
  // every route load. See `absentAvatarFiles`.
  const cacheKey = avatarFileKey(assistantId, AVATAR_IMAGE_PATH);
  if (absentAvatarFiles.has(cacheKey)) return null;
  try {
    const { data, error, response } = await client.get({
      url: "/v1/assistants/{assistant_id}/workspace/file/content/",
      path: { assistant_id: assistantId },
      query: { path: AVATAR_IMAGE_PATH },
      parseAs: "blob",
    });
    assertHasResponse(response, error, "Failed to fetch avatar image");
    if (response.status === 404) absentAvatarFiles.add(cacheKey);
    if (!response.ok || !data) return null;
    return URL.createObjectURL(data as Blob);
  } catch {
    return null;
  }
}
