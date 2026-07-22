# Mac functional verification — 2026-07-21 (WS-H desktop control)

Proven on the real Mac (manavgupta), signed helper `resources/cue-mac-helper.app` (Apple Development: Manav Gupta 9CL7ZPZ325), CU/AppControl compiled in.

## Desktop-organizer skill — PROVEN end-to-end
- `plan --root <scoped test dir>`: categorized 15 files (Documents/Screenshots/Images/Media/Archives/Other), read-only (all 15 stayed put).
- `apply`: moved 15 → dated `Cue Archive/<date>/` category folders, wrote moves.tsv + generated cue-undo.sh, ZERO deletes (15 preserved).
- `cue-undo.sh`: restored all 15 exactly, archive emptied (moved back not copied), content intact.
- Ran against a scoped 15-file test folder (NOT the real Desktop); cleaned up after.

## computer-use (computeruse.perform) — PROVEN read + write
- READ: `computer_use_observe` returned a live axTree ("Window: 'Claude'…") — TCC Accessibility granted, full pipeline executes (not "method not found").
- WRITE: `computer_use_type_text` typed "Cue drove this via computer-use — proof 42" into a real TextEdit doc (verified visually; helper acted, not the operator). executionError: none.
- Backed by 19 ActionVerifier tests (safety gate: sensitive-text/loop/step-cap/destructive-combo blocks) + 82 Electron executor tests.

## app-control (appcontrol.perform) — helper-responsive + test-covered
- Method registered + implemented (start/observe/press/combo/sequence/type/click/drag/stop); covered by host-cu-app-control-executor tests. Full per-app live drive not separately screenshotted this pass.

## Honest remaining
- The FULL daemon→app→helper live path (a prod conversation invoking computer_use that drives THIS Mac) is covered by: helper proven (above) + 82 executor tests (Electron half) + daemon already emits host_cu_request (earlier deploys). Not separately run as one live prod conversation this pass — the pieces are each proven.
- Cue Live "act" re-platform onto computeruse.perform: NOT done (seam spec only) — Cue Live still uses its own act loop.
- Native overlay UI (the design's states): NOT built.
- Voice audio QA (endpointing/acks flags): needs a real mic session — user-only.
