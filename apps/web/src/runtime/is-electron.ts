/**
 * Ambient declaration of the `window.vellum` bridge exposed by the Electron
 * preload script (see `apps/macos/src/preload/index.ts`). Types are imported
 * from `@vellumai/ipc-contract` — the single source of truth for IPC payload
 * shapes shared by main, preload, and renderer.
 *
 * Feature code in `apps/web/` should NOT call `window.vellum.*` directly.
 * Instead, wrap each persisted capability in a per-feature module under
 * `apps/web/src/runtime/` with named functions (see `native-biometric.ts`
 * for the established shape: `isBiometricEnabled()` / `setBiometricEnabled()`).
 * The module owns the cross-platform branch — `isElectron()` calls into
 * `window.vellum`, `isNativePlatform()` calls Capacitor, and the web branch
 * uses `localStorage` — so consumers stay platform-agnostic.
 */
import type {
  Lockfile,
  LockfileWriteResult,
} from "@vellumai/local-mode/contract";
import type {
  AppVersionInfo,
  AssistantStatus,
  BundleScanData,
  ConnectivityState,
  ConnectorStatus,
  ConnectorTool,
  CueLiveGoal,
  CueLivePermissions,
  CueLiveSettingsPane,
  CueLiveStatus,
  CueLiveVoiceKeyField,
  CueLiveVoiceKeysStatus,
  DeepLink,
  DictationOverlayMessage,
  DictationOverlayState,
  DictationPartialEvent,
  DictationPartialsResult,
  FnPushToTalkResult,
  HelperRestartResult,
  HelperState,
  HotkeyEvent,
  HotkeyEventState,
  HotkeyScope,
  LocalWakeOptions,
  NotificationActionEvent,
  NotificationCategory,
  PowerEvent,
  PowerEventKind,
  ResolvedHotkey,
  ShowNotificationPayload,
  SystemPermissionKind,
  SystemPermissionStateItem,
  SystemPermissionStatus,
  SystemPermissionsState,
  TextInsertionResult,
  UpdateState,
  UpdateStatus,
  VellumCommand,
  CornerContext,
  CornerSelection,
  NeedsYouItem,
} from "@vellumai/ipc-contract";

export type {
  AppVersionInfo,
  AssistantStatus,
  BundleScanData,
  ConnectivityState,
  ConnectorStatus,
  ConnectorTool,
  CueLiveStatus,
  CueLiveVoiceKeyField,
  CueLiveVoiceKeysStatus,
  DeepLink,
  DictationOverlayMessage,
  DictationOverlayState,
  DictationPartialEvent,
  DictationPartialsResult,
  FnPushToTalkResult,
  HelperRestartResult,
  HelperState,
  HotkeyEvent,
  HotkeyEventState,
  HotkeyScope,
  NotificationCategory,
  PowerEvent,
  PowerEventKind,
  ResolvedHotkey,
  SystemPermissionKind,
  SystemPermissionStateItem,
  SystemPermissionStatus,
  SystemPermissionsState,
  UpdateState,
  UpdateStatus,
  VellumCommand,
};

// Legacy aliases — existing consumers import these `Electron`-prefixed names.
// They are structurally identical to the contract types.
export type ElectronShowNotificationPayload = ShowNotificationPayload;
export type ElectronTextInsertionResult = TextInsertionResult;
export type ElectronNotificationActionEvent = NotificationActionEvent;

// ─── Window augmentation ────────────────────────────────────────────────
// The renderer's `window.vellum` declaration intentionally marks many
// capability groups optional for version-skew tolerance: a newer renderer
// can run against an older Electron preload that predates a channel.
// The `VellumBridge` interface in the contract represents the canonical
// (fully-wired) shape; the global declaration below is the renderer's
// defensive view that guards on presence.

declare global {
  interface Window {
    vellum?: {
      platform: "electron";
      app: {
        versionInfo(): Promise<AppVersionInfo>;
        openWebsite(): Promise<void>;
      };
      /**
       * Which Cue instance this install points at. Optional like the rest:
       * an older preload predates it, and the web build has no bridge at all.
       */
      selfHost?: {
        connect(link: string): Promise<string | null>;
        connected(): Promise<string | null>;
      };
      text?: {
        insertIntoFrontApp(text: string): Promise<TextInsertionResult>;
        openAutomationSettings(): Promise<void>;
      };
      hotkeys?: {
        get(): Promise<ResolvedHotkey[]>;
        set(key: string, accelerator: string | null): Promise<void>;
        onChange(callback: (catalog: ResolvedHotkey[]) => void): () => void;
      };
      launchAtLogin?: {
        get(): Promise<boolean>;
        set(enabled: boolean): Promise<void>;
      };
      connectors?: {
        available(): Promise<boolean>;
        list(): Promise<ConnectorStatus[]>;
        connect(slug: string): Promise<string | null>;
        disconnect(slug: string): Promise<ConnectorStatus[]>;
        tools?(slug: string): Promise<ConnectorTool[]>;
        setTool?(
          slug: string,
          tool: string,
          enabled: boolean,
        ): Promise<ConnectorTool[]>;
      };
      cueLive?: {
        status(): Promise<CueLiveStatus>;
        setEnabled(enabled: boolean): Promise<CueLiveStatus>;
        setTakeControl?(enabled: boolean): Promise<CueLiveStatus>;
        summon(): Promise<void>;
        permissions?(): Promise<CueLivePermissions>;
        openSystemSettings?(pane: CueLiveSettingsPane): Promise<void>;
        stop?(): Promise<void>;
        runGoal?(goal: string, takeControl: boolean): Promise<void>;
        voiceKeysStatus?(): Promise<CueLiveVoiceKeysStatus>;
        setVoiceKey?(
          field: CueLiveVoiceKeyField,
          value: string | null,
        ): Promise<CueLiveVoiceKeysStatus>;
        listGoals?(): Promise<CueLiveGoal[]>;
        saveGoal?(
          goal: Omit<CueLiveGoal, "id"> & { id?: string },
        ): Promise<CueLiveGoal[]>;
        deleteGoal?(id: string): Promise<CueLiveGoal[]>;
        /** ⌥R push-to-talk run hotkey (backlog #29) → start Cue Live voice. */
        onStartVoice?(callback: () => void): () => void;
      };
      featureFlags?: {
        set(flags: Record<string, boolean>): void;
      };
      helper?: {
        ping?(): Promise<"pong">;
        getState?(): Promise<HelperState>;
        restart?(): Promise<HelperRestartResult>;
        onState?(callback: (state: HelperState) => void): () => void;
        hotkey?: {
          fnPushToTalk(enable: boolean): Promise<FnPushToTalkResult>;
          onEvent(callback: (event: HotkeyEvent) => void): () => void;
        };
        dictation?: {
          setPartials(
            enable: boolean,
            deviceName?: string,
            pushAudio?: boolean,
          ): Promise<DictationPartialsResult>;
          pushAudioChunk?(chunk: ArrayBuffer): void;
          onPartial(
            callback: (event: DictationPartialEvent) => void,
          ): () => void;
          onFinalized?(
            callback: (event: DictationPartialEvent) => void,
          ): () => void;
          transcribe?(
            audio: ArrayBuffer,
          ): Promise<{ ok: boolean; reason?: string }>;
          onTranscribed?(
            callback: (event: DictationPartialEvent) => void,
          ): () => void;
        };
      };
      permissions?: {
        getState(): Promise<SystemPermissionsState>;
        request(kind: SystemPermissionKind): Promise<SystemPermissionStateItem>;
        openSettings(
          kind: SystemPermissionKind,
        ): Promise<SystemPermissionStateItem>;
        quitAndReopen(): Promise<void>;
        onState(callback: (state: SystemPermissionsState) => void): () => void;
      };
      commands: {
        on(callback: (command: VellumCommand) => void): () => void;
      };
      status?: {
        setConnection(status: AssistantStatus): void;
      };
      icon?: {
        setAvatar(png: Uint8Array | null): void;
      };
      dock: {
        setBadge(count: number): void;
        setSignedIn(signedIn: boolean): void;
      };
      menu: {
        setPlatformSession(has: boolean): Promise<void>;
      };
      localMode: {
        hatch(
          species: string,
          remote?: string,
        ): Promise<{
          ok: boolean;
          assistantId?: string;
          error?: string;
        }>;
        readLockfile(): Promise<Lockfile>;
        saveLockfileAssistant(
          assistant: Record<string, unknown>,
          activeAssistant?: string,
        ): Promise<LockfileWriteResult>;
        replacePlatformAssistants(
          platformAssistants: Array<Record<string, unknown>>,
          organizationId?: string,
        ): Promise<LockfileWriteResult>;
        retire(assistantId: string): Promise<{ ok: boolean; error?: string }>;
        wake?(
          assistantId: string,
          options?: LocalWakeOptions,
        ): Promise<{ ok: boolean; error?: string }>;
        guardianToken(
          assistantId: string,
        ): Promise<
          | { ok: true; accessToken: string }
          | { ok: false; status: number; error: string }
        >;
      };
      auth?: {
        startOAuth(options: {
          providerHint?: string;
          loginHint?: string;
          intent?: string;
        }): Promise<{ sessionToken: string }>;
        cancelOAuth(): Promise<void>;
        getSessionToken?(): string | null;
        signOut?(): Promise<void>;
      };
      mainWindow: {
        ensureVisible(): Promise<void>;
        setOnboarding(active: boolean): Promise<void>;
      };
      power: {
        onEvent(callback: (event: PowerEvent) => void): () => void;
      };
      deepLinks: {
        drain(): Promise<DeepLink[]>;
        onLink(callback: (link: DeepLink) => void): () => void;
      };
      fileOpen?: {
        drain(): Promise<string[]>;
        onFile(callback: (filePath: string) => void): () => void;
      };
      feedback?: {
        diagnostics(): Promise<Record<string, unknown>>;
        logs(): Promise<string>;
      };
      connectivity?: {
        onState(callback: (state: ConnectivityState) => void): () => void;
        get(): Promise<ConnectivityState>;
        setDevice(online: boolean): void;
        retry(): Promise<ConnectivityState>;
      };
      quickInput?: {
        submit(message: string): Promise<void>;
        dismiss(): Promise<void>;
      };
      commandPalette?: {
        open(): Promise<void>;
        dismiss(): Promise<void>;
        select(command: VellumCommand): Promise<void>;
      };
      dictationOverlay?: {
        setState(state: DictationOverlayMessage): void;
        onState(callback: (state: DictationOverlayState) => void): () => void;
        getState(): Promise<DictationOverlayState | null>;
      };
      notifications?: {
        show(
          payload: ShowNotificationPayload,
        ): Promise<{ success: boolean; errorMessage?: string }>;
        onAction(
          callback: (event: NotificationActionEvent) => void,
        ): () => void;
      };
      popout?: {
        open(conversationId: string): Promise<void>;
      };
      /**
       * Floating desktop companion (slice 1) — the corner orb window's
       * bridge surface. Optional like the rest: older preloads predate it.
       * See `apps/web/src/domains/companion/companion-bridge.ts`.
       */
      companion?: {
        talk(): Promise<void>;
        openCue(): Promise<void>;
        hide(): Promise<void>;
        getStatus(): Promise<AssistantStatus>;
        onStatus(callback: (status: AssistantStatus) => void): () => void;
        /**
         * Every phase change, published by main.
         *
         * The renderer never invents a phase — including hover. Main tracks
         * the pointer through `setIgnoreMouseEvents(true, {forward:true})`,
         * which is what lets it know where the pointer is without the window
         * having claimed a canvas many times the size of the pill. See
         * `apps/macos/src/main/companion-hit-test.ts`.
         */
        onState?(
          callback: (state: Record<string, unknown>) => void,
        ): () => void;
        /**
         * Whether the pointer is over anything actually drawn.
         *
         * The other half of the forwarding trick: main hands the canvas back
         * whenever this says no, so the empty region stays transparent to
         * clicks meant for the application behind.
         */
        setPointerOver?(over: boolean): void;
        /** A press landed on the creature; main reads the cursor from here. */
        dragBegin?(): void;
        /** The button came up, wherever it came up. */
        dragEnd?(): void;
        /** A named size step (`C12`). The one legitimate canvas resize. */
        setSize?(size: string): Promise<void>;
        /** One-shot pull, for a cold window that missed the first publish. */
        getState?(): Promise<Record<string, unknown>>;
      };
      /**
       * The floating corner — `⌥C`, one exchange, then finished. Optional
       * like the rest: older preloads predate it, and the route renders
       * harmlessly in a browser where the whole bridge is absent.
       * See `apps/web/src/domains/corner/corner-bridge.ts`.
       */
      /**
       * The menu-bar "needs you" count — the surface that waits, so the
       * corner never has to interrupt. Optional like the rest.
       */
      needsYou?: {
        set(payload: { count: number; items: NeedsYouItem[] }): void;
      };
      corner?: {
        getSelection(): Promise<CornerSelection | null>;
        onSelection(
          callback: (selection: CornerSelection | null) => void,
        ): () => void;
        getContext(): Promise<CornerContext>;
        onContext(callback: (context: CornerContext) => void): () => void;
        setScreenReading(granted: boolean): Promise<void>;
        hide(): Promise<void>;
        openInCue(text: string): Promise<void>;
      };
      /**
       * Embedded VentureVerse app view (desktop inline embedding). Drives a
       * native WebContentsView composited into the Cue window so a
       * VentureVerse app runs first-party (SSO works) while visually embedded.
       * Absent on web and on older desktop builds — callers must feature-check.
       */
      vvView?: {
        open(
          url: string,
          bounds: { x: number; y: number; width: number; height: number },
        ): Promise<void>;
        setBounds(bounds: {
          x: number;
          y: number;
          width: number;
          height: number;
        }): Promise<void>;
        close(): Promise<void>;
      };
      bundleConfirm?: {
        getData(): Promise<BundleScanData | null>;
        respond(accepted: boolean): void;
      };
      update?: {
        getState(): Promise<UpdateState>;
        check(): Promise<void>;
        install(): Promise<void>;
        onState(callback: (state: UpdateState) => void): () => void;
      };
    };
  }
}

/**
 * True when the renderer is running inside the Electron host. Safe to call
 * server-side / before hydration — falls through to `false` when `window`
 * isn't defined yet.
 *
 * Use this to branch behavior that differs between the web host and the
 * Electron host. For branches that differ between web and Capacitor iOS,
 * use `isNativePlatform` from `@/runtime/native-auth.js` instead.
 */
export function isElectron(): boolean {
  return (
    typeof window !== "undefined" && window.vellum?.platform === "electron"
  );
}
