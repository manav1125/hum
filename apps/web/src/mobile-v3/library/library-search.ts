/**
 * Library search — the main results stay "made with Cue", and uploads get
 * their own section.
 *
 * ## The cut, and the hole it left
 *
 * The Library composes run deliverables, generated files, documents and apps —
 * 115 items on the owner's instance — and says so in its header ("115 things
 * made with Cue") and its footer ("Things you sent it stay in their chat").
 * Uploads are deliberately not in that list, and that is right: a list that
 * claims everything on it was made with Cue must not contain a PDF the owner
 * dragged in.
 *
 * What was wrong was the consequence. A contract uploaded three weeks ago was
 * findable from nowhere — Library excluded it by scope, and no other surface
 * searched attachments at all. The scope was correct; the findability was the
 * defect. So SEARCH reaches uploads, and the list does not:
 *
 *   · main results — unchanged, still "made with Cue", so the header's count
 *     stays true;
 *   · a separated section below it — "Things you sent · in their chats", each
 *     row linking to the thread it lives in.
 *
 * The two sets cannot overlap: the daemon excludes any attachment an assistant
 * message also links to, so one file can never be counted under both headings.
 *
 * ## The vocabulary is the chats index's, deliberately
 *
 * `mobile-v3/chats/chats-search.ts` settled three rules for saying how much of
 * a corpus a search actually reached, and this reuses them rather than
 * inventing a second dialect:
 *
 *   · **a count prints only when provably whole.** The daemon caps at
 *     {@link UPLOAD_SEARCH_LIMIT} and reports `truncated`; a capped set says
 *     "the N most recent — there are more" rather than printing N as a total.
 *   · **a capped set says so**, instead of implying it is the whole answer.
 *   · **an outage degrades to a stated bound**, never to an empty state that
 *     means something else.
 *
 * The third rule differs in one way, and the difference is the point. The
 * chats index can fall back to a local filter, because the client already
 * holds some conversations. Nothing here holds any uploads — they are not in
 * the Library payload by design — so there is no reduced search to fall back
 * to. The honest degraded state is therefore not "no uploads match" but "I
 * couldn't search them", and {@link UploadSearchState} keeps those two apart
 * so a surface cannot render one as the other.
 *
 * ## Failing open
 *
 * This is a second, independent query. A failure here returns a `failed` state
 * and never touches the main results — the file list a search was already
 * showing must not blank because a side section could not load.
 */
import { attachmentsUploadsSearchGet } from "@/generated/daemon/sdk.gen";
import type { AttachmentsUploadsSearchGetResponses } from "@/generated/daemon/types.gen";

type UploadsResponse = AttachmentsUploadsSearchGetResponses[200];

/** One thing the owner sent, and the thread to go back to. */
export type UploadHit = UploadsResponse["uploads"][number];

/**
 * The daemon caps at 50 and will not serve more, so asking for more would get
 * 50 back and let this module believe it was the whole answer. Ask for exactly
 * the cap and let the response's own `truncated` flag say whether it was.
 */
export const UPLOAD_SEARCH_LIMIT = 50;

/** Long enough that typing doesn't fan out a request per keystroke. */
export const UPLOAD_SEARCH_DEBOUNCE_MS = 200;

/** Design's heading for the section. One string, so both doors say it identically. */
export const UPLOADS_SECTION_LABEL = "Things you sent · in their chats";

/**
 * What the uploads section is currently showing, and how much of the corpus is
 * behind it.
 *
 * `failed` is a distinct state rather than an empty `whole`, because "no
 * uploads match" and "I couldn't search your uploads" are different facts and
 * the surface must be able to tell them apart. Collapsing them is the same
 * defect as an empty state that really means an outage.
 */
export type UploadSearchState =
  | { status: "idle" }
  /** In flight. Nothing to show yet — uploads are never held locally. */
  | { status: "searching"; query: string }
  /** The daemon answered. `truncated` says whether this is the whole answer. */
  | {
      status: "whole";
      query: string;
      rows: UploadHit[];
      truncated: boolean;
    }
  /** The daemon did not answer. No rows were searched, and the note says so. */
  | { status: "failed"; query: string; note: string };

// ---------------------------------------------------------------------------
// Sentences
// ---------------------------------------------------------------------------

/**
 * The line under a failed uploads search.
 *
 * Mirrors the chats index's opening clause on purpose — one error vocabulary
 * across both search surfaces — but says "couldn't search" rather than
 * "searched only what was loaded", because unlike the chats index there is no
 * loaded window here to have searched. Claiming a partial search happened
 * would be a smaller lie than an empty state, but still a lie.
 */
export function uploadsFailureNote(
  reason:
    | { kind: "error"; httpStatus?: number | undefined }
    | { kind: "unavailable" },
): string {
  if (reason.kind === "unavailable") {
    return "I'm not connected to your Cue yet, so I couldn't search the things you sent.";
  }
  const code = reason.httpStatus ? ` (${reason.httpStatus})` : "";
  return `I couldn't search the things you sent${code}. Your files are still in their chats.`;
}

/**
 * The scope line for the uploads section.
 *
 * A count prints only when the daemon answered AND did not truncate. A full
 * page proves only that there were at least that many, so it says that
 * instead — the same rule that stopped a page size being printed as a total
 * on the chats index.
 */
export function uploadsScopeNote(state: UploadSearchState): string | null {
  switch (state.status) {
    case "idle":
      return null;
    case "searching":
      return "Looking through what you sent…";
    case "failed":
      return state.note;
    case "whole": {
      if (state.truncated) {
        return `Showing the ${UPLOAD_SEARCH_LIMIT} most recent — there are more.`;
      }
      if (state.rows.length === 0) return null;
      return state.rows.length === 1
        ? "1 thing you sent, in its chat."
        : `${state.rows.length} things you sent, in their chats.`;
    }
  }
}

/**
 * The empty state for the WHOLE search — main results and uploads together.
 *
 * Its job is to never say "nothing matches" about a search that did not
 * happen. When the uploads half failed, the sentence has to admit that the
 * answer is incomplete, otherwise a file the owner is looking straight at gets
 * reported as absent.
 */
export function combinedEmptyNote(
  query: string,
  uploads: UploadSearchState,
): string {
  const q = query.trim();
  if (uploads.status === "failed") {
    return `Nothing you made with Cue matches “${q}” — and I couldn't search the things you sent, so this isn't the whole answer.`;
  }
  if (uploads.status === "searching") {
    return `Nothing you made with Cue matches “${q}” — still looking through what you sent…`;
  }
  return `Nothing matches “${q}” — in what you made with Cue, or in what you sent it.`;
}

/** Does the section have anything at all to render? */
export function hasUploadSection(state: UploadSearchState): boolean {
  switch (state.status) {
    case "idle":
      return false;
    case "searching":
    case "failed":
      return true;
    case "whole":
      return state.rows.length > 0;
  }
}

// ---------------------------------------------------------------------------
// The fetch
// ---------------------------------------------------------------------------

function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function isAbortError(err: unknown): boolean {
  return (
    !!err &&
    typeof err === "object" &&
    (err as { name?: unknown }).name === "AbortError"
  );
}

/**
 * Run one uploads search.
 *
 * Returns `null` for a superseded keystroke — the caller keeps what it had
 * rather than repainting. Folding a cancellation into an empty `whole` would
 * make a fast typist's search report "nothing you sent matches" about a
 * request that was never answered.
 */
export async function runUploadSearch(
  assistantId: string | null | undefined,
  query: string,
  signal?: AbortSignal,
): Promise<UploadSearchState | null> {
  const trimmed = query.trim();
  if (!trimmed) return { status: "idle" };

  if (!assistantId) {
    return {
      status: "failed",
      query: trimmed,
      note: uploadsFailureNote({ kind: "unavailable" }),
    };
  }

  try {
    const { data, response } = await attachmentsUploadsSearchGet({
      path: { assistant_id: assistantId },
      query: { q: trimmed, limit: UPLOAD_SEARCH_LIMIT },
      throwOnError: false,
      ...(signal ? { signal } : {}),
    });

    // Checked on the SIGNAL, not on the error's shape: the generated client
    // swallows an abort into its `{ error }` channel, so a cancelled keystroke
    // would otherwise render as an outage.
    if (aborted(signal)) return null;

    if (!response?.ok || !data) {
      const httpStatus = response?.status;
      return {
        status: "failed",
        query: trimmed,
        note: uploadsFailureNote({
          kind: "error",
          ...(httpStatus === undefined ? {} : { httpStatus }),
        }),
      };
    }

    return {
      status: "whole",
      query: trimmed,
      rows: data.uploads,
      // The daemon's own flag, not a length comparison: it is the only party
      // that knows whether its query hit the cap.
      truncated: data.truncated,
    };
  } catch (err) {
    if (aborted(signal) || isAbortError(err)) return null;
    return {
      status: "failed",
      query: trimmed,
      note: uploadsFailureNote({ kind: "error" }),
    };
  }
}
