# Apple Developer Support — notarization submissions stuck In Progress

**Where to file:** https://developer.apple.com/contact/topic/select
→ *Development and Technical* → *Notarization* (or *Other Development Topics* if
Notarization is not listed). Sign-in required.

**Team ID:** XU8BLQACGU
**Apple ID:** manavgupta1125@gmail.com

---

## Subject

Three notarization submissions stuck at "In Progress" for 10–19 hours

## Body

Three `notarytool` submissions from my team have been sitting at status
**In Progress** with no terminal result. The oldest is over 19 hours old. No
submission has returned `Accepted`, `Invalid`, or `Rejected` — they simply do
not resolve.

Submission IDs (all Team ID `XU8BLQACGU`):

| Submission ID | Created (UTC) | Name | Status |
|---|---|---|---|
| `74292c9b-4d3d-45bf-86d6-10e8ce1ede6c` | 2026-08-04 04:44:10 | Cue.zip | In Progress |
| `ba7adaf9-99d4-4b33-adf2-5aa7e12b0aa1` | 2026-08-04 04:52:33 | Cue.zip | In Progress |
| `0af4de4a-cee8-44b4-aec8-1faf301f6024` | 2026-08-04 13:46:11 | Cue-notarize.zip | In Progress |

### What I have already verified on my side

- The app is signed with a valid **Developer ID Application** certificate
  (`Developer ID Application: Manav Gupta (XU8BLQACGU)`), issued 2026-08-04.
- `codesign --verify --deep --strict` passes on the bundle with no errors.
- Hardened runtime is enabled; the bundled helper, the embedded `bun` binary and
  both QuickLook app extensions are each signed with the same identity.
- `xcrun notarytool store-credentials` **validated successfully** against this
  Apple ID and Team ID, so authentication is not the issue.
- The third submission was uploaded fresh after killing an earlier client that
  had hung before registering an ID — that upload reported
  "Successfully uploaded file" and returned the ID above, so the upload itself
  completed.
- `xcrun notarytool info <id>` returns `In Progress` for all three; there is no
  error message, no `statusSummary`, and no log URL available to fetch.

### What I need

1. Whether these three submissions can be cleared or re-queued on your side.
2. Whether there is anything in the submitted archives causing them to stall
   silently rather than return `Invalid` — if so, how to retrieve a log, since
   `notarytool log <id>` has nothing to return while the status is In Progress.

This is blocking distribution of a signed build to external testers.

---

## For our own records — what is NOT the problem

Ruled out before filing, so support time is not spent re-checking:

- **Not the certificate.** Developer ID Application was created and installed
  today; a `codesign` test signature succeeded, and the packaged app's signature
  verifies deep + strict.
- **Not credentials.** `store-credentials` validated, and `notarytool history`
  authenticates and returns results.
- **Not the upload.** The third submission registered an ID and reported a
  successful upload.
- **Not our build config.** A real bug was found and fixed here — the
  electron-builder config hardcoded `type: "development"`, so a Developer ID
  build was impossible until it was corrected. That fix is in and is the reason
  the current artifact is signed correctly.
