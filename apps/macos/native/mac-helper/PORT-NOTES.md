# mac-helper computer-use / app-control port — finishing notes (WS-H)

The Swift computer-use + app-control stack was copied into
`Sources/MacHelperExecutable/ComputerUse/` and `.../AppControl/` from the
retiring `clients/macos/vellum-assistant/{ComputerUse,AppControl}`. It is the
real port source, placed in-tree, but it is **excluded from the build**
(`Package.swift` → `exclude: [..., "ComputerUse", "AppControl"]`) because it
still references the retiring `VellumAssistantShared` module and a Combine
overlay proxy. Compiling it as-is would break `scripts/build-mac-helper.sh`.

The Electron side is **done and wired** (typechecked + unit-tested):
`apps/macos/src/main/executors/host-cu-executor.ts` and
`host-app-control-executor.ts` call the shared CU helper
(`sidecar/shared-cu-helper.ts`) over JSON-RPC. This document is the contract they
expect the helper to implement.

## The two JSON-RPC methods to register (in `main.swift`)

The Electron executors call these exact method names on the shared CU helper
(second `MacHelperClient` instance, 65s timeout, same signed binary → same TCC
grants as Cue Live):

### `computeruse.perform`
Params (from `host-cu-executor.ts`):
```
{ requestId: string, conversationId: string, toolName: string,
  input: { …tool input… }, stepNumber: number, reasoning?: string }
```
`toolName` is one of `computer_use_observe|click|type_text|key|scroll|drag|wait|open_app|run_applescript`.
Result (zod-validated by the TS side — extra keys tolerated):
```
{ axTree?, axDiff?, screenshot?, screenshotWidthPx?, screenshotHeightPx?,
  screenWidthPt?, screenHeightPt?, executionResult?, executionError?,
  secondaryWindows?, userGuidance? }   // all optional
```
This maps to `HostCuResultPayload` in `ComputerUse/CUWireTypes.swift`. The
orchestrator is `HostCuExecutor.swift` → `HostCuActionRunner.perform(...)`.

### `appcontrol.perform`
Params (from `host-app-control-executor.ts`):
```
{ requestId: string, conversationId: string, toolName?: string,
  input: { tool: "start"|"observe"|"press"|"combo"|"sequence"|"type"|"click"|"drag"|"stop", …fields… } }
```
`input` decodes into `HostAppControlInput` (discriminated by `tool`, snake_case
wire fields — see `CUWireTypes.swift`).
Result → `HostAppControlResultPayload`:
```
{ state: "running"|"missing"|"minimized", pngBase64?, windowBounds?{x,y,width,height},
  executionResult?, executionError? }   // state required, rest optional
```
The orchestrator is `AppControlExecutor.swift` → `AppControlExecutor.perform(...)`.

Both dispatchers run `@MainActor` (AX + CGEvent + ScreenCaptureKit must be on the
main thread). Follow the existing `cuelive.*` registration pattern in `main.swift`
(`router.register("computeruse.perform") { … }`), but note these are async — mirror
upstream `92fc32090b`'s `dispatchCuPerform` / `dispatchAppControlPerform`, which
peel these two methods out of the synchronous `JsonRpcRouter` into an async
`@MainActor` dispatch and reply via `writeResponse`.

## Remaining adaptation (the on-device work)

1. **Sever `VellumAssistantShared`.** Files importing it: `HostCuExecutor.swift`,
   `AppControlExecutor.swift`, `AccessibilityTree.swift`, `AppWindowCapture.swift`,
   `AppMouse.swift`. The wire types they need are vendored in
   `ComputerUse/CUWireTypes.swift` (+ `AnyCodable.swift`). Replace
   `import VellumAssistantShared` with nothing (same target) and confirm every
   referenced symbol resolves to the vendored copies.
2. **Drop the Combine overlay proxy.** `HostCuSessionProxy.swift` is app-UI glue
   (`@Published` / `SessionOverlayProviding`). The headless helper has no overlay;
   emit progress as JSON-RPC **notifications** (the `CueLive.swift` `emit` pattern)
   instead. Delete `HostCuSessionProxy.swift` and change
   `HostCuActionRunner.perform(_:overlayProxy:)` to drop the `overlayProxy` param
   (or accept an `emit` closure).
3. **Reconcile with `CueLive.swift`.** It already implements AX-at-cursor reads,
   ScreenCaptureKit capture, and CGEvent input in the helper. Unify the ported
   `AccessibilityTree` / `ScreenCapture` / `ActionExecutor` input+capture paths
   with CueLive's rather than shipping two copies (this is also the Cue Live
   "act" re-platform seam — see below).
4. **Logger seam.** Replace `os.Logger(subsystem: Bundle.appBundleIdentifier, …)`
   with a fixed subsystem literal (e.g. `"ai.cue.mac-helper"`) or the helper's
   stderr `log(_:)` convention.
5. **Un-exclude + register.** Remove `"ComputerUse"`/`"AppControl"` from the
   `exclude` list in `Package.swift`, register the two methods in `main.swift`,
   `swift build`, fix the compile errors, and run the ported unit tests
   (`ActionVerifierTests` ports cleanly — it has no app deps).

## Cue Live "act" re-platform (depends on the above)

Once `computeruse.perform` is live, the Cue Live full-auto "act" loop
(`apps/macos/src/main/cue-live-service.ts`, currently driving raw-pixel actions
through `cuelive.performAction` + `POST /cuelive/act`) should run a **real
conversation turn** whose brain uses the `computer_use_*` tools — gaining
AX-element grounding, `ActionVerifier`, per-action approvals + directory-scoped
trust rules, step caps, and Mission Control visibility. Cue Live keeps its moat
(summon hotkey, POINT overlay, phone-remote pause). See
`apps/macos/src/main/CUE-LIVE-ACT-REPLATFORM.md`.

## Files in this port

| File | Ports cleanly? | Note |
| --- | --- | --- |
| `ComputerUse/ActionVerifier.swift` | ✅ yes | Foundation/CoreGraphics only. The new safety gate (step cap, loop detection, sensitive-text + destructive-combo blocks). Tests port with it. |
| `ComputerUse/ActionTypes.swift` | ✅ yes | Action data model. |
| `ComputerUse/AXTreeDiff.swift` | ✅ yes | Pure algorithm. |
| `ComputerUse/ScreenCapture.swift` | ✅ mostly | ScreenCaptureKit — reconcile with CueLive capture. |
| `ComputerUse/AccessibilityTree.swift` | ⚠️ logger/shared | AX walk. Sever shared + logger. |
| `ComputerUse/ActionExecutor.swift` | ⚠️ logger | Screen-global CGEvent input. |
| `ComputerUse/HostCuExecutor.swift` | ⚠️ high coupling | Orchestrator. Sever shared + drop overlay proxy. |
| `ComputerUse/HostCuSessionProxy.swift` | ❌ drop | Combine UI glue — delete. |
| `ComputerUse/CUWireTypes.swift` | vendored | Extracted wire types. |
| `ComputerUse/AnyCodable.swift` | vendored | Extracted type-erased JSON value. |
| `AppControl/AppControlExecutor.swift` | ⚠️ shared | Per-app orchestrator. |
| `AppControl/AppKeyboard.swift` | ✅ yes | Per-process keyboard (`postToPid`). |
| `AppControl/AppMouse.swift` | ⚠️ shared (WindowBounds) | Per-process mouse. |
| `AppControl/AppWindowCapture.swift` | ⚠️ shared/logger | Per-app window capture. |
