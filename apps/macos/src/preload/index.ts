import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

import type { Lockfile, LockfileWriteResult } from "@vellumai/local-mode";
import type {
  AppVersionInfo,
  AssistantStatus,
  BundleScanData,
  CompanionStatePayload,
  ConnectivityState,
  ConnectorStatus,
  ConnectorTool,
  CornerContext,
  CornerSelection,
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
  LocalWakeOptions,
  NeedsYouItem,
  NotificationActionEvent,
  PowerEvent,
  ResolvedHotkey,
  ShowNotificationPayload,
  SystemPermissionKind,
  SystemPermissionStateItem,
  SystemPermissionsState,
  TextInsertionResult,
  UpdateState,
  VellumBridge,
  VellumCommand,
} from "@vellumai/ipc-contract";

export type {
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
  NotificationActionEvent,
  PowerEvent,
  ResolvedHotkey,
  ShowNotificationPayload,
  SystemPermissionKind,
  SystemPermissionStateItem,
  SystemPermissionsState,
  TextInsertionResult,
  UpdateState,
  VellumBridge,
  VellumCommand,
};

const notImplemented = (name: string) => (): Promise<never> =>
  Promise.reject(new Error(`window.vellum.${name} is not implemented yet`));

const subscribeDictationEvent =
  (channel: string) =>
  (callback: (event: DictationPartialEvent) => void): (() => void) => {
    const handler = (
      _event: IpcRendererEvent,
      payload: DictationPartialEvent,
    ) => {
      callback(payload);
    };
    ipcRenderer.on(channel, handler);
    return () => {
      ipcRenderer.off(channel, handler);
    };
  };

const bridge: VellumBridge = {
  platform: "electron",
  app: {
    versionInfo: (): Promise<AppVersionInfo> =>
      ipcRenderer.invoke("vellum:app:versionInfo") as Promise<AppVersionInfo>,
    openWebsite: (): Promise<void> =>
      ipcRenderer.invoke("vellum:app:openWebsite") as Promise<void>,
  },
  selfHost: {
    connect: (link: string): Promise<string | null> =>
      ipcRenderer.invoke("vellum:selfHost:connect", link) as Promise<
        string | null
      >,
    connected: (): Promise<string | null> =>
      ipcRenderer.invoke("vellum:selfHost:connected") as Promise<string | null>,
  },
  text: {
    insertIntoFrontApp: (text: string): Promise<TextInsertionResult> =>
      ipcRenderer.invoke(
        "vellum:text:insertIntoFrontApp",
        text,
      ) as Promise<TextInsertionResult>,
    openAutomationSettings: (): Promise<void> =>
      ipcRenderer.invoke("vellum:text:openAutomationSettings") as Promise<void>,
  },
  auth: {
    startOAuth: (options: {
      providerHint?: string;
      loginHint?: string;
      intent?: string;
    }): Promise<{ sessionToken: string }> =>
      ipcRenderer.invoke("vellum:auth:startOAuth", options) as Promise<{
        sessionToken: string;
      }>,
    cancelOAuth: (): Promise<void> =>
      ipcRenderer.invoke("vellum:auth:cancelOAuth") as Promise<void>,
    getSessionToken: (): string | null =>
      ipcRenderer.sendSync("vellum:auth:getSessionToken") as string | null,
    signOut: (): Promise<void> =>
      ipcRenderer.invoke("vellum:auth:signOut") as Promise<void>,
  },
  hotkeys: {
    get: (): Promise<ResolvedHotkey[]> =>
      ipcRenderer.invoke("vellum:hotkeys:get") as Promise<ResolvedHotkey[]>,
    set: (key: string, accelerator: string | null): Promise<void> =>
      ipcRenderer.invoke(
        "vellum:hotkeys:set",
        key,
        accelerator,
      ) as Promise<void>,
    onChange: (callback) => {
      const handler = (
        _event: IpcRendererEvent,
        catalog: ResolvedHotkey[],
      ): void => {
        callback(catalog);
      };
      ipcRenderer.on("vellum:hotkeys:changed", handler);
      return () => {
        ipcRenderer.off("vellum:hotkeys:changed", handler);
      };
    },
  },
  launchAtLogin: {
    get: (): Promise<boolean> =>
      ipcRenderer.invoke("vellum:launchAtLogin:get") as Promise<boolean>,
    set: (enabled: boolean): Promise<void> =>
      ipcRenderer.invoke("vellum:launchAtLogin:set", enabled) as Promise<void>,
  },
  connectors: {
    available: (): Promise<boolean> =>
      ipcRenderer.invoke("vellum:connectors:available") as Promise<boolean>,
    list: (): Promise<ConnectorStatus[]> =>
      ipcRenderer.invoke("vellum:connectors:list") as Promise<
        ConnectorStatus[]
      >,
    connect: (slug: string): Promise<string | null> =>
      ipcRenderer.invoke("vellum:connectors:connect", slug) as Promise<
        string | null
      >,
    disconnect: (slug: string): Promise<ConnectorStatus[]> =>
      ipcRenderer.invoke("vellum:connectors:disconnect", slug) as Promise<
        ConnectorStatus[]
      >,
    tools: (slug: string): Promise<ConnectorTool[]> =>
      ipcRenderer.invoke("vellum:connectors:tools", slug) as Promise<
        ConnectorTool[]
      >,
    setTool: (
      slug: string,
      tool: string,
      enabled: boolean,
    ): Promise<ConnectorTool[]> =>
      ipcRenderer.invoke(
        "vellum:connectors:setTool",
        slug,
        tool,
        enabled,
      ) as Promise<ConnectorTool[]>,
  },
  cueLive: {
    status: (): Promise<CueLiveStatus> =>
      ipcRenderer.invoke("vellum:cueLive:status") as Promise<CueLiveStatus>,
    setEnabled: (enabled: boolean): Promise<CueLiveStatus> =>
      ipcRenderer.invoke(
        "vellum:cueLive:setEnabled",
        enabled,
      ) as Promise<CueLiveStatus>,
    setTakeControl: (enabled: boolean): Promise<CueLiveStatus> =>
      ipcRenderer.invoke(
        "vellum:cueLive:setTakeControl",
        enabled,
      ) as Promise<CueLiveStatus>,
    summon: (): Promise<void> =>
      ipcRenderer.invoke("vellum:cueLive:summon") as Promise<void>,
    permissions: (): Promise<CueLivePermissions> =>
      ipcRenderer.invoke(
        "vellum:cueLive:permissions",
      ) as Promise<CueLivePermissions>,
    requestScreenRecording: (): Promise<{
      granted: boolean;
      prompted: boolean;
      unavailable?: boolean;
    }> =>
      ipcRenderer.invoke("vellum:cueLive:requestScreenRecording") as Promise<{
        granted: boolean;
        prompted: boolean;
        unavailable?: boolean;
      }>,
    openSystemSettings: (pane: CueLiveSettingsPane): Promise<void> =>
      ipcRenderer.invoke(
        "vellum:cueLive:openSystemSettings",
        pane,
      ) as Promise<void>,
    stop: (): Promise<void> =>
      ipcRenderer.invoke("vellum:cueLive:stop") as Promise<void>,
    stopScreenStream: (): Promise<CueLiveStatus> =>
      ipcRenderer.invoke(
        "vellum:cueLive:stopScreenStream",
      ) as Promise<CueLiveStatus>,
    runGoal: (goal: string, takeControl: boolean): Promise<void> =>
      ipcRenderer.invoke(
        "vellum:cueLive:runGoal",
        goal,
        takeControl,
      ) as Promise<void>,
    voiceKeysStatus: (): Promise<CueLiveVoiceKeysStatus> =>
      ipcRenderer.invoke(
        "vellum:cueLive:voiceKeysStatus",
      ) as Promise<CueLiveVoiceKeysStatus>,
    setVoiceKey: (
      field: CueLiveVoiceKeyField,
      value: string | null,
    ): Promise<CueLiveVoiceKeysStatus> =>
      ipcRenderer.invoke(
        "vellum:cueLive:setVoiceKey",
        field,
        value,
      ) as Promise<CueLiveVoiceKeysStatus>,
    listGoals: (): Promise<CueLiveGoal[]> =>
      ipcRenderer.invoke("vellum:cueLive:listGoals") as Promise<CueLiveGoal[]>,
    saveGoal: (
      goal: Omit<CueLiveGoal, "id"> & { id?: string },
    ): Promise<CueLiveGoal[]> =>
      ipcRenderer.invoke("vellum:cueLive:saveGoal", goal) as Promise<
        CueLiveGoal[]
      >,
    deleteGoal: (id: string): Promise<CueLiveGoal[]> =>
      ipcRenderer.invoke("vellum:cueLive:deleteGoal", id) as Promise<
        CueLiveGoal[]
      >,
    onStartVoice: (callback: () => void) => {
      const handler = () => {
        callback();
      };
      ipcRenderer.on("vellum:cueLive:startVoice", handler);
      return () => {
        ipcRenderer.off("vellum:cueLive:startVoice", handler);
      };
    },
  },
  featureFlags: {
    set: (flags: Record<string, boolean>): void => {
      ipcRenderer.send("vellum:featureFlags:set", flags);
    },
  },
  helper: {
    ping: () => ipcRenderer.invoke("vellum:helper:ping") as Promise<"pong">,
    getState: () =>
      ipcRenderer.invoke("vellum:helper:state:get") as Promise<HelperState>,
    restart: () =>
      ipcRenderer.invoke(
        "vellum:helper:restart",
      ) as Promise<HelperRestartResult>,
    onState: (callback) => {
      const handler = (_event: IpcRendererEvent, payload: HelperState) => {
        callback(payload);
      };
      ipcRenderer.on("vellum:helper:state", handler);
      return () => {
        ipcRenderer.off("vellum:helper:state", handler);
      };
    },
    hotkey: {
      fnPushToTalk: (enable: boolean): Promise<FnPushToTalkResult> =>
        ipcRenderer.invoke(
          "vellum:helper:hotkey:fnPushToTalk",
          enable,
        ) as Promise<FnPushToTalkResult>,
      onEvent: (callback) => {
        const handler = (_event: IpcRendererEvent, payload: HotkeyEvent) => {
          callback(payload);
        };
        ipcRenderer.on("vellum:helper:hotkey:event", handler);
        return () => {
          ipcRenderer.off("vellum:helper:hotkey:event", handler);
        };
      },
    },
    dictation: {
      setPartials: (
        enable: boolean,
        deviceName?: string,
        pushAudio?: boolean,
      ): Promise<DictationPartialsResult> =>
        ipcRenderer.invoke(
          "vellum:helper:dictation:setPartials",
          enable,
          deviceName,
          pushAudio,
        ) as Promise<DictationPartialsResult>,
      pushAudioChunk: (chunk: ArrayBuffer): void => {
        ipcRenderer.send("vellum:helper:dictation:audio", chunk);
      },
      onPartial: subscribeDictationEvent("vellum:helper:dictation:partial"),
      onFinalized: subscribeDictationEvent("vellum:helper:dictation:finalized"),
      transcribe: (
        audio: ArrayBuffer,
      ): Promise<{ ok: boolean; reason?: string }> =>
        ipcRenderer.invoke(
          "vellum:helper:dictation:transcribe",
          audio,
        ) as Promise<{ ok: boolean; reason?: string }>,
      onTranscribed: subscribeDictationEvent(
        "vellum:helper:dictation:transcribed",
      ),
    },
  },
  permissions: {
    getState: (): Promise<SystemPermissionsState> =>
      ipcRenderer.invoke(
        "vellum:permissions:getState",
      ) as Promise<SystemPermissionsState>,
    request: (kind: SystemPermissionKind): Promise<SystemPermissionStateItem> =>
      ipcRenderer.invoke(
        "vellum:permissions:request",
        kind,
      ) as Promise<SystemPermissionStateItem>,
    openSettings: (
      kind: SystemPermissionKind,
    ): Promise<SystemPermissionStateItem> =>
      ipcRenderer.invoke(
        "vellum:permissions:openSettings",
        kind,
      ) as Promise<SystemPermissionStateItem>,
    quitAndReopen: (): Promise<void> =>
      ipcRenderer.invoke("vellum:permissions:quitAndReopen") as Promise<void>,
    onState: (callback) => {
      const handler = (
        _event: IpcRendererEvent,
        state: SystemPermissionsState,
      ) => {
        callback(state);
      };
      ipcRenderer.on("vellum:permissions:state", handler);
      return () => {
        ipcRenderer.off("vellum:permissions:state", handler);
      };
    },
  },
  commands: {
    on: (callback) => {
      const handler = (_event: IpcRendererEvent, command: VellumCommand) => {
        callback(command);
      };
      ipcRenderer.on("vellum:command", handler);
      return () => {
        ipcRenderer.off("vellum:command", handler);
      };
    },
  },
  status: {
    setConnection: (status: AssistantStatus): void => {
      ipcRenderer.send("vellum:status:connection", status);
    },
  },
  icon: {
    setAvatar: (png: Uint8Array | null): void => {
      ipcRenderer.send("vellum:icon:setAvatar", png);
    },
  },
  dock: {
    setBadge: (count: number): void => {
      ipcRenderer.send("vellum:dock:setBadge", count);
    },
    setSignedIn: (signedIn: boolean): void => {
      ipcRenderer.send("vellum:dock:setSignedIn", signedIn);
    },
  },
  localMode: {
    hatch: (species: string, remote?: string) =>
      ipcRenderer.invoke("vellum:localMode:hatch", species, remote) as Promise<{
        ok: boolean;
        assistantId?: string;
        error?: string;
      }>,
    readLockfile: () =>
      ipcRenderer.invoke("vellum:localMode:readLockfile") as Promise<Lockfile>,
    saveLockfileAssistant: (
      assistant: Record<string, unknown>,
      activeAssistant?: string,
    ) =>
      ipcRenderer.invoke(
        "vellum:localMode:saveLockfileAssistant",
        assistant,
        activeAssistant,
      ) as Promise<LockfileWriteResult>,
    replacePlatformAssistants: (
      platformAssistants: Array<Record<string, unknown>>,
      organizationId?: string,
    ) =>
      ipcRenderer.invoke(
        "vellum:localMode:replacePlatformAssistants",
        platformAssistants,
        organizationId,
      ) as Promise<LockfileWriteResult>,
    wake: (assistantId: string, options?: LocalWakeOptions) =>
      ipcRenderer.invoke(
        "vellum:localMode:wake",
        assistantId,
        options,
      ) as Promise<{
        ok: boolean;
        error?: string;
      }>,
    retire: (assistantId: string) =>
      ipcRenderer.invoke("vellum:localMode:retire", assistantId) as Promise<{
        ok: boolean;
        error?: string;
      }>,
    guardianToken: (assistantId: string) =>
      ipcRenderer.invoke(
        "vellum:localMode:guardianToken",
        assistantId,
      ) as Promise<
        | { ok: true; accessToken: string }
        | { ok: false; status: number; error: string }
      >,
  },
  menu: {
    setPlatformSession: (has: boolean): Promise<void> =>
      ipcRenderer.invoke(
        "vellum:menu:setPlatformSession",
        has,
      ) as Promise<void>,
  },
  mainWindow: {
    ensureVisible: (): Promise<void> =>
      ipcRenderer.invoke("vellum:mainWindow:ensureVisible") as Promise<void>,
    setOnboarding: (active: boolean): Promise<void> =>
      ipcRenderer.invoke(
        "vellum:mainWindow:setOnboarding",
        active,
      ) as Promise<void>,
  },
  power: {
    onEvent: (callback) => {
      const handler = (_event: IpcRendererEvent, payload: PowerEvent) => {
        callback(payload);
      };
      ipcRenderer.on("vellum:power:event", handler);
      return () => {
        ipcRenderer.off("vellum:power:event", handler);
      };
    },
  },
  deepLinks: {
    drain: (): Promise<DeepLink[]> =>
      ipcRenderer.invoke("vellum:deepLinks:drain") as Promise<DeepLink[]>,
    onLink: (callback) => {
      const handler = (_event: IpcRendererEvent, payload: DeepLink) => {
        callback(payload);
      };
      ipcRenderer.on("vellum:deepLinks:event", handler);
      // Tell main we're listening so it switches from "buffer" mode
      // to "broadcast only" mode. Without this, every live link
      // would also enter the buffer and be replayed on a future
      // drain (renderer reload, logout-relogin).
      ipcRenderer.send("vellum:deepLinks:subscribe");
      return () => {
        ipcRenderer.off("vellum:deepLinks:event", handler);
        ipcRenderer.send("vellum:deepLinks:unsubscribe");
      };
    },
  },
  fileOpen: {
    drain: (): Promise<string[]> =>
      ipcRenderer.invoke("vellum:fileOpen:drain") as Promise<string[]>,
    onFile: (callback) => {
      ipcRenderer.send("vellum:fileOpen:subscribe");
      const handler = (_event: IpcRendererEvent, filePath: string) => {
        callback(filePath);
      };
      ipcRenderer.on("vellum:fileOpen:event", handler);
      return () => {
        ipcRenderer.send("vellum:fileOpen:unsubscribe");
        ipcRenderer.off("vellum:fileOpen:event", handler);
      };
    },
  },
  feedback: {
    diagnostics: () =>
      ipcRenderer.invoke("vellum:feedback:diagnostics") as Promise<
        Record<string, unknown>
      >,
    logs: () => ipcRenderer.invoke("vellum:feedback:logs") as Promise<string>,
  },
  connectivity: {
    onState: (callback) => {
      const handler = (_event: IpcRendererEvent, state: ConnectivityState) => {
        callback(state);
      };
      ipcRenderer.on("vellum:connectivity:state", handler);
      // Emit the current state so late subscribers (window loaded after
      // the first probe) don't wait for the next state transition.
      void (
        ipcRenderer.invoke(
          "vellum:connectivity:get",
        ) as Promise<ConnectivityState>
      ).then(callback);
      return () => {
        ipcRenderer.off("vellum:connectivity:state", handler);
      };
    },
    get: () =>
      ipcRenderer.invoke(
        "vellum:connectivity:get",
      ) as Promise<ConnectivityState>,
    setDevice: (online: boolean): void => {
      ipcRenderer.send("vellum:connectivity:device", online);
    },
    retry: () =>
      ipcRenderer.invoke(
        "vellum:connectivity:retry",
      ) as Promise<ConnectivityState>,
  },
  notifications: {
    show: (
      payload: ShowNotificationPayload,
    ): Promise<{ success: boolean; errorMessage?: string }> =>
      ipcRenderer.invoke("vellum:notifications:show", payload) as Promise<{
        success: boolean;
        errorMessage?: string;
      }>,
    onAction: (callback) => {
      const handler = (
        _event: IpcRendererEvent,
        event: NotificationActionEvent,
      ) => {
        callback(event);
      };
      ipcRenderer.on("vellum:notifications:action", handler);
      return () => {
        ipcRenderer.off("vellum:notifications:action", handler);
      };
    },
  },
  bundleConfirm: {
    getData: () =>
      ipcRenderer.invoke(
        "vellum:bundleConfirm:getData",
      ) as Promise<BundleScanData | null>,
    respond: (accepted: boolean): void => {
      ipcRenderer.send("vellum:bundleConfirm:respond", accepted);
    },
  },
  quickInput: {
    submit: (message: string): Promise<void> =>
      ipcRenderer.invoke("vellum:quickInput:submit", message) as Promise<void>,
    dismiss: (): Promise<void> =>
      ipcRenderer.invoke("vellum:quickInput:dismiss") as Promise<void>,
  },
  commandPalette: {
    open: (): Promise<void> =>
      ipcRenderer.invoke("vellum:commandPalette:open") as Promise<void>,
    dismiss: (): Promise<void> =>
      ipcRenderer.invoke("vellum:commandPalette:dismiss") as Promise<void>,
    select: (command: VellumCommand): Promise<void> =>
      ipcRenderer.invoke(
        "vellum:commandPalette:select",
        command,
      ) as Promise<void>,
  },
  dictationOverlay: {
    setState: (state: DictationOverlayMessage): void => {
      ipcRenderer.send("vellum:dictationOverlay:setState", state);
    },
    onState: (callback) => {
      const handler = (
        _event: IpcRendererEvent,
        payload: DictationOverlayState,
      ) => {
        callback(payload);
      };
      ipcRenderer.on("vellum:dictationOverlay:state", handler);
      return () => {
        ipcRenderer.off("vellum:dictationOverlay:state", handler);
      };
    },
    getState: (): Promise<DictationOverlayState | null> =>
      ipcRenderer.invoke(
        "vellum:dictationOverlay:getState",
      ) as Promise<DictationOverlayState | null>,
  },
  popout: {
    open: (conversationId: string): Promise<void> =>
      ipcRenderer.invoke("vellum:popout:open", conversationId) as Promise<void>,
  },
  /**
   * The always-on companion. Main owns the canvas, where the creature is,
   * which way it has room to unfurl, and who owns the clicks; the renderer
   * draws what it is given and reports back what the pointer is over. Status
   * mirrors the tray's assistant-status state machine (pushed on change,
   * pulled once at mount). See main/companion-window.ts.
   */
  companion: {
    /**
     * Whether the pointer is over anything actually drawn.
     *
     * Half of the technique that keeps an oversized, always-on-top canvas
     * from swallowing clicks meant for other applications: main hands the
     * canvas back the moment this says no. Fire-and-forget — a hover report
     * nobody waits for must not be able to stall a pointer move.
     */
    setPointerOver: (over: boolean): void => {
      void ipcRenderer.invoke("vellum:companion:setPointerOver", over);
    },
    /** A press landed on the creature. Main reads the cursor from here on. */
    dragBegin: (): void => {
      void ipcRenderer.invoke("vellum:companion:dragBegin");
    },
    /** The button came up — wherever it came up. */
    dragEnd: (): void => {
      void ipcRenderer.invoke("vellum:companion:dragEnd");
    },
    /**
     * "I am the companion." Sent by `CompanionPage` on mount.
     *
     * Main creates the window hidden and shows it only on this, because it
     * cannot tell what the SPA will render for a route — an unready app turns
     * any route into a sign-in screen.
     */
    /**
     * The rectangle this page drew, in window coordinates.
     *
     * Main hit-tests the cursor against it rather than waiting for a
     * `mousemove` that a click-through panel may never receive — which is
     * what left the introduction on screen and unclickable.
     */
    setDrawnRect: (rect: {
      x: number;
      y: number;
      width: number;
      height: number;
    }): void => {
      void ipcRenderer.invoke("vellum:companion:setDrawnRect", rect);
    },
    ready: (): Promise<void> =>
      ipcRenderer.invoke("vellum:companion:ready") as Promise<void>,
    /** Pop the right-click menu (`C5`). Native: it outgrows the canvas. */
    menu: (): Promise<void> =>
      ipcRenderer.invoke("vellum:companion:menu") as Promise<void>,
    introNext: (fromBeat: number): Promise<void> =>
      ipcRenderer.invoke(
        "vellum:companion:introNext",
        fromBeat,
      ) as Promise<void>,
    introDismiss: (): Promise<void> =>
      ipcRenderer.invoke("vellum:companion:introDismiss") as Promise<void>,
    /**
     * A drag is passing over the creature (`C10`). The arc opens toward it.
     */
    dragOver: (over: boolean): Promise<void> =>
      ipcRenderer.invoke("vellum:companion:dragOver", over) as Promise<void>,
    /** Something landed. Held, not kept, until a choice is made. */
    drop: (item: { kind: string; value: string }): Promise<void> =>
      ipcRenderer.invoke("vellum:companion:drop", item) as Promise<void>,
    dropChoose: (choice: string): Promise<void> =>
      ipcRenderer.invoke("vellum:companion:dropChoose", choice) as Promise<void>,
    dropRelease: (): Promise<void> =>
      ipcRenderer.invoke("vellum:companion:dropRelease") as Promise<void>,
    /**
     * The typing card's two verbs (`C2`). Both hand off to the app — the
     * companion talks, and only the app acts.
     */
    ask: (message: string): Promise<void> =>
      ipcRenderer.invoke("vellum:companion:ask", message) as Promise<void>,
    keepAsNote: (note: string): Promise<void> =>
      ipcRenderer.invoke("vellum:companion:keepAsNote", note) as Promise<void>,
    /** `✎ Type` on the hover pill — the same thing `⌥Space` does. */
    openCard: (): Promise<void> =>
      ipcRenderer.invoke("vellum:companion:openCard") as Promise<void>,
    /** `esc`. Closes the card and cancels nothing. */
    closeCard: (): Promise<void> =>
      ipcRenderer.invoke("vellum:companion:closeCard") as Promise<void>,
    /**
     * A mic is open in the companion window, or has just closed.
     *
     * The renderer is the only side that can hold a microphone, and main is
     * the only side that may decide a phase — so the renderer reports and
     * main resolves. The alternative, a renderer that drew `listening` for
     * itself, is the creature showing one thing while main believes another,
     * which is also main deciding who owns the clicks on a surface it is not
     * drawing.
     */
    listening: (on: boolean): Promise<void> =>
      ipcRenderer.invoke("vellum:companion:listening", on) as Promise<void>,
    /**
     * The app's window telling main what the conversation looks like now.
     *
     * Sent by the MAIN window, not the companion: only that window owns a
     * conversation, and only main may publish to the companion. Already
     * truncated to a glance by the caller.
     */
    publishTurns: (
      turns: Array<{ role: "user" | "assistant"; text: string }>,
      thinking: boolean,
    ): Promise<void> =>
      ipcRenderer.invoke(
        "vellum:companion:publishTurns",
        turns,
        thinking,
      ) as Promise<void>,
    /** The pill's `Stop`. Main decides what it stops — see the handler. */
    stop: (): Promise<void> =>
      ipcRenderer.invoke("vellum:companion:stop") as Promise<void>,
    nudgeOpen: (): Promise<void> =>
      ipcRenderer.invoke("vellum:companion:nudgeOpen") as Promise<void>,
    nudgeDismiss: (): Promise<void> =>
      ipcRenderer.invoke("vellum:companion:nudgeDismiss") as Promise<void>,
    setSize: (size: string): Promise<void> =>
      ipcRenderer.invoke("vellum:companion:setSize", size) as Promise<void>,
    getState: (): Promise<CompanionStatePayload> =>
      ipcRenderer.invoke(
        "vellum:companion:getState",
      ) as Promise<CompanionStatePayload>,
    onState: (callback: (state: CompanionStatePayload) => void) => {
      const handler = (
        _event: IpcRendererEvent,
        state: CompanionStatePayload,
      ): void => {
        callback(state);
      };
      ipcRenderer.on("vellum:companion:state", handler);
      return () => {
        ipcRenderer.off("vellum:companion:state", handler);
      };
    },
    talk: (): Promise<void> =>
      ipcRenderer.invoke("vellum:companion:talk") as Promise<void>,
    openCue: (): Promise<void> =>
      ipcRenderer.invoke("vellum:companion:openCue") as Promise<void>,
    hide: (): Promise<void> =>
      ipcRenderer.invoke("vellum:companion:hide") as Promise<void>,
  },
  /**
   * The floating corner. Main reads the selection while the owner's own app
   * is still frontmost and then shows the panel, so the renderer both pulls
   * (for a cold window whose route chunk is still loading) and listens (for a
   * window that was already open). See main/corner-window.ts.
   */
  /**
   * What is waiting on the owner, published to the menu bar. One-way and
   * fire-and-forget, like the dock badge — the renderer owns the number and
   * main owns the presentation. See main/needs-you.ts for why main must
   * never count for itself.
   */
  needsYou: {
    set: (payload: { count: number; items: NeedsYouItem[] }): void => {
      ipcRenderer.send("vellum:needsYou:set", payload);
    },
  },
  corner: {
    getSelection: (): Promise<CornerSelection | null> =>
      ipcRenderer.invoke(
        "vellum:corner:getSelection",
      ) as Promise<CornerSelection | null>,
    onSelection: (callback: (selection: CornerSelection | null) => void) => {
      const handler = (
        _event: IpcRendererEvent,
        selection: CornerSelection | null,
      ): void => {
        callback(selection);
      };
      ipcRenderer.on("vellum:corner:selection", handler);
      return () => {
        ipcRenderer.off("vellum:corner:selection", handler);
      };
    },
    getContext: (): Promise<CornerContext> =>
      ipcRenderer.invoke("vellum:corner:getContext") as Promise<CornerContext>,
    onContext: (callback: (context: CornerContext) => void) => {
      const handler = (
        _event: IpcRendererEvent,
        context: CornerContext,
      ): void => {
        callback(context);
      };
      ipcRenderer.on("vellum:corner:context", handler);
      return () => {
        ipcRenderer.off("vellum:corner:context", handler);
      };
    },
    setScreenReading: (granted: boolean): Promise<void> =>
      ipcRenderer.invoke(
        "vellum:corner:setScreenReading",
        granted,
      ) as Promise<void>,
    hide: (): Promise<void> =>
      ipcRenderer.invoke("vellum:corner:hide") as Promise<void>,
    openInCue: (text: string): Promise<void> =>
      ipcRenderer.invoke("vellum:corner:openInCue", text) as Promise<void>,
  },
  /**
   * Embedded VentureVerse app view (desktop inline embedding). The SPA's app
   * page drives a native WebContentsView composited into the Cue window: open
   * it at a rectangle, keep it aligned as the layout resizes, tear it down on
   * navigate-away. See main/ventureverse-view.ts for why this is a top-level
   * view and not an iframe.
   */
  vvView: {
    open: (
      url: string,
      bounds: { x: number; y: number; width: number; height: number },
    ): Promise<void> =>
      ipcRenderer.invoke("vellum:vvView:open", url, bounds) as Promise<void>,
    setBounds: (bounds: {
      x: number;
      y: number;
      width: number;
      height: number;
    }): Promise<void> =>
      ipcRenderer.invoke("vellum:vvView:setBounds", bounds) as Promise<void>,
    close: (): Promise<void> =>
      ipcRenderer.invoke("vellum:vvView:close") as Promise<void>,
  },
  update: {
    getState: (): Promise<UpdateState> =>
      ipcRenderer.invoke("vellum:update:getState") as Promise<UpdateState>,
    check: (): Promise<void> =>
      ipcRenderer.invoke("vellum:update:check") as Promise<void>,
    install: (): Promise<void> =>
      ipcRenderer.invoke("vellum:update:install") as Promise<void>,
    onState: (callback) => {
      const handler = (_event: IpcRendererEvent, state: UpdateState) => {
        callback(state);
      };
      ipcRenderer.on("vellum:update:state", handler);
      return () => {
        ipcRenderer.off("vellum:update:state", handler);
      };
    },
  },
};

contextBridge.exposeInMainWorld("vellum", bridge);

const vellumConfig = ipcRenderer.sendSync("vellum:config:get") as {
  webUrl: string;
  platformUrl: string;
  disablePlatform?: boolean;
  deviceId: string | null;
} | null;
if (vellumConfig) {
  contextBridge.exposeInMainWorld("__VELLUM_CONFIG__", vellumConfig);
}

const flagOverrides: Record<string, boolean | string> = {};
for (const [key, value] of Object.entries(process.env)) {
  if (!key.startsWith("VELLUM_FLAG_") || value === undefined) continue;
  const flagKey = key
    .slice("VELLUM_FLAG_".length)
    .toLowerCase()
    .replace(/_/g, "-");
  const lower = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(lower)) flagOverrides[flagKey] = true;
  else if (["false", "0", "no", "off"].includes(lower))
    flagOverrides[flagKey] = false;
  else flagOverrides[flagKey] = value.trim();
}
if (Object.keys(flagOverrides).length > 0) {
  contextBridge.exposeInMainWorld("__VELLUM_FLAG_OVERRIDES__", flagOverrides);
}

declare global {
  interface Window {
    vellum: VellumBridge;
    __VELLUM_FLAG_OVERRIDES__?: Record<string, boolean | string>;
  }
}
