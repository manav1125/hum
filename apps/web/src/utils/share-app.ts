/**
 * Export an app as a downloadable `.cue` bundle.
 *
 * 1. Calls the share-cloud endpoint to package the app server-side.
 * 2. Downloads the binary bundle using the returned share token.
 * 3. Saves/shares the file via the cross-platform saveFile helper.
 *
 * Returns the filename actually written, so callers report the real name
 * rather than composing a second guess at it.
 */

import {
  appsByIdSharecloudPost,
  appsSharedByTokenGet,
} from "@/generated/daemon/sdk.gen";
import { saveFile } from "@/runtime/native-file";
import { bundleFilename } from "@/utils/bundle-format";

export async function shareApp(
  assistantId: string,
  appId: string,
  appName: string,
): Promise<string> {
  const { data } = await appsByIdSharecloudPost({
    path: { assistant_id: assistantId, id: appId },
    throwOnError: true,
  });
  if (!data.shareToken) {
    throw new Error("Share response missing token.");
  }

  const { data: blob, response: dlResponse } = await appsSharedByTokenGet({
    path: { assistant_id: assistantId, token: data.shareToken },
    throwOnError: false,
    parseAs: "blob",
  });
  if (!dlResponse || !dlResponse.ok || !blob) {
    throw new Error("Failed to download app bundle.");
  }

  const filename = bundleFilename(appName);
  await saveFile(blob, filename);
  return filename;
}
