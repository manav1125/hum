/**
 * The `VellumBridge` interface — the shape of `window.vellum` as
 * implemented by the Electron preload script.
 *
 * All surfaces are required: the preload implements every method, so this
 * interface type-checks completeness at the implementation site. The
 * renderer's `declare global` makes version-skew-tolerant surfaces
 * optional (older preloads may not expose them), which is a separate
 * concern handled at the consumer site.
 *
 * This is the single canonical definition of the bridge shape. The
 * preload types its `contextBridge.exposeInMainWorld` value against this
 * interface; the renderer references the payload types (from `./types.ts`)
 * in its ambient declaration.
 */
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
  Lockfile,
  LockfileWriteResult,
  NotificationActionEvent,
  PowerEvent,
  ResolvedHotkey,
  ShowNotificationPayload,
  SystemPermissionKind,
  SystemPermissionStateItem,
  SystemPermissionsState,
  TextInsertionResult,
  UpdateState,
  VellumCommand,
} from "./types";

/**
 * Options for `localMode.wake`. `repairGuardian` re-provisions a
 * missing/expired guardian token via the CLI's `--repair-guardian` — it
 * revokes the assistant's other device-bound tokens, so callers must gate it
 * behind explicit user confirmation, never silent auto-repair.
 */
/**
 * What the owner had highlighted when they summoned the corner.
 *
 * The panel quotes `text` verbatim above the actions, so a wrong selection is
 * obvious before anything acts on it, and prints `wordCount` beside it
 * ("YOU SELECTED · 41 WORDS"). `appName` is where it came from, and is null
 * when that could not be determined — provenance is nice to have and must
 * never cost the selection.
 */
/** One thing waiting on the owner, as the menu bar lists it. */
export interface NeedsYouItem {
  id: string;
  title: string;
  /** "waiting 2 days", "before your 10:30" — why it is worth a look now. */
  detail?: string;
}

/**
 * What the corner knows about the window in front, and whether this is the
 * summon that should offer to read it.
 *
 * `consent` has three states because "never asked" and "declined" are
 * different: the offer is made once, on the second summon, and a decline
 * stays declined until the owner changes it.
 */
export interface CornerContext {
  screen: { description: string; appName: string | null } | null;
  offerScreenReading: boolean;
  consent: "granted" | "declined" | "unasked";
}

export interface CornerSelection {
  text: string;
  wordCount: number;
  appName: string | null;
}

export interface LocalWakeOptions {
  repairGuardian?: boolean;
}

export interface VellumBridge {
  platform: "electron";
  app: {
    versionInfo(): Promise<AppVersionInfo>;
    openWebsite(): Promise<void>;
  };
  /**
   * The Cue instance this install points at. Each owner runs their own
   * deployment, so the app ships connected to nothing and the Connect screen
   * names it once.
   */
  selfHost: {
    /** Connect to (and load) an instance. Returns the resolved SPA URL, or
     *  null when the link isn't a usable https instance. */
    connect(link: string): Promise<string | null>;
    /** The connected instance's SPA URL, or null when not connected yet. */
    connected(): Promise<string | null>;
  };
  text: {
    insertIntoFrontApp(text: string): Promise<TextInsertionResult>;
    openAutomationSettings(): Promise<void>;
  };
  auth: {
    startOAuth(options: {
      providerHint?: string;
      loginHint?: string;
      intent?: string;
    }): Promise<{ sessionToken: string }>;
    cancelOAuth(): Promise<void>;
    getSessionToken(): string | null;
    signOut(): Promise<void>;
  };
  hotkeys: {
    get(): Promise<ResolvedHotkey[]>;
    set(key: string, accelerator: string | null): Promise<void>;
    onChange(callback: (catalog: ResolvedHotkey[]) => void): () => void;
  };
  launchAtLogin: {
    get(): Promise<boolean>;
    set(enabled: boolean): Promise<void>;
  };
  connectors: {
    available(): Promise<boolean>;
    list(): Promise<ConnectorStatus[]>;
    connect(slug: string): Promise<string | null>;
    disconnect(slug: string): Promise<ConnectorStatus[]>;
    tools(slug: string): Promise<ConnectorTool[]>;
    setTool(
      slug: string,
      tool: string,
      enabled: boolean,
    ): Promise<ConnectorTool[]>;
  };
  cueLive: {
    status(): Promise<CueLiveStatus>;
    setEnabled(enabled: boolean): Promise<CueLiveStatus>;
    setTakeControl(enabled: boolean): Promise<CueLiveStatus>;
    summon(): Promise<void>;
    /** Non-prompting read of the macOS Accessibility + Screen Recording grants. */
    permissions(): Promise<CueLivePermissions>;
    /**
     * PROMPTING ask for Screen Recording. Unlike `permissions()`, this is what
     * registers Cue in the System Settings ▸ Screen Recording list — macOS only
     * lists an app once it has requested. `prompted` is true when the consent
     * dialog was shown; `unavailable` when the helper wasn't reachable to ask.
     */
    requestScreenRecording(): Promise<{
      granted: boolean;
      prompted: boolean;
      unavailable?: boolean;
    }>;
    /** Deep-link the user to a System Settings privacy pane. */
    openSystemSettings(pane: CueLiveSettingsPane): Promise<void>;
    /** Stop everything: abort any auto-run and hide the overlay (⌥ esc mirror). */
    stop(): Promise<void>;
    /**
     * Stop only the screen stream to the remote viewer, from this Mac. The web
     * viewer can stop it as well; this is the half of that promise that lives
     * on the machine being watched.
     */
    stopScreenStream(): Promise<CueLiveStatus>;
    runGoal(goal: string, takeControl: boolean): Promise<void>;
    voiceKeysStatus(): Promise<CueLiveVoiceKeysStatus>;
    setVoiceKey(
      field: CueLiveVoiceKeyField,
      value: string | null,
    ): Promise<CueLiveVoiceKeysStatus>;
    /** List the persisted auto-run goals. */
    listGoals(): Promise<CueLiveGoal[]>;
    /** Upsert a goal (id absent → create with a fresh id); returns the list. */
    saveGoal(
      goal: Omit<CueLiveGoal, "id"> & { id?: string },
    ): Promise<CueLiveGoal[]>;
    /** Remove a goal by id; returns the updated list. */
    deleteGoal(id: string): Promise<CueLiveGoal[]>;
    /**
     * Subscribe to the ⌥R push-to-talk run hotkey (backlog #29). Fired from
     * Electron-main when the native helper reports the run key; the renderer
     * starts Cue Live voice (begins listening — the `useLiveVoice` flow).
     * Returns an unsubscribe function.
     */
    onStartVoice(callback: () => void): () => void;
  };
  featureFlags: {
    set(flags: Record<string, boolean>): void;
  };
  helper: {
    ping(): Promise<"pong">;
    getState(): Promise<HelperState>;
    restart(): Promise<HelperRestartResult>;
    onState(callback: (state: HelperState) => void): () => void;
    hotkey: {
      fnPushToTalk(enable: boolean): Promise<FnPushToTalkResult>;
      onEvent(callback: (event: HotkeyEvent) => void): () => void;
    };
    dictation: {
      setPartials(
        enable: boolean,
        deviceName?: string,
        pushAudio?: boolean,
      ): Promise<DictationPartialsResult>;
      /** Fire-and-forget 16 kHz mono Int16 LE PCM for push-mode partials. */
      pushAudioChunk?(chunk: ArrayBuffer): void;
      onPartial(callback: (event: DictationPartialEvent) => void): () => void;
      /**
       * The session's completed transcript, delivered after a graceful
       * `setPartials(false)` — short dictations end before the first
       * partial, so the recognizer runs to completion instead of being
       * cancelled.
       */
      onFinalized?(
        callback: (event: DictationPartialEvent) => void,
      ): () => void;
      /**
       * One-shot whole-utterance recognition of recorded 16 kHz mono Int16
       * PCM — the offline transcript authority. Result arrives via
       * `onTranscribed`.
       */
      transcribe?(
        audio: ArrayBuffer,
      ): Promise<{ ok: boolean; reason?: string }>;
      onTranscribed?(
        callback: (event: DictationPartialEvent) => void,
      ): () => void;
    };
  };
  permissions: {
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
  status: {
    setConnection(status: AssistantStatus): void;
  };
  icon: {
    setAvatar(png: Uint8Array | null): void;
  };
  dock: {
    setBadge(count: number): void;
    setSignedIn(signedIn: boolean): void;
  };
  /**
   * What is waiting on the owner, published to the menu bar.
   *
   * The corner **never appears unbidden** — a panel that seizes focus over
   * your work to ask for money is the behaviour that gets an app quit. So
   * approvals reach you as a count you pull down instead: one surface you
   * summon, one that waits.
   *
   * This carries **the same post-valve number HQ's badge shows**, published
   * from the one hook both already read, so the menu bar can never become a
   * second and louder count that disagrees with the app.
   */
  needsYou: {
    set(payload: { count: number; items: NeedsYouItem[] }): void;
  };
  localMode: {
    hatch(
      species: string,
      remote?: string,
    ): Promise<{ ok: boolean; assistantId?: string; error?: string }>;
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
    wake(
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
  menu: {
    setPlatformSession(has: boolean): Promise<void>;
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
  fileOpen: {
    drain(): Promise<string[]>;
    onFile(callback: (filePath: string) => void): () => void;
  };
  feedback: {
    diagnostics(): Promise<Record<string, unknown>>;
    logs(): Promise<string>;
  };
  connectivity: {
    onState(callback: (state: ConnectivityState) => void): () => void;
    /** Pull the current state — lets the renderer re-sync after a missed
     * `onState` broadcast (e.g. on window focus). */
    get(): Promise<ConnectivityState>;
    setDevice(online: boolean): void;
    /** Probe immediately and resolve with the post-probe state, so a manual
     * retry recovers even when the broadcast channel failed. */
    retry(): Promise<ConnectivityState>;
  };
  notifications: {
    show(
      payload: ShowNotificationPayload,
    ): Promise<{ success: boolean; errorMessage?: string }>;
    onAction(callback: (event: NotificationActionEvent) => void): () => void;
  };
  bundleConfirm: {
    getData(): Promise<BundleScanData | null>;
    respond(accepted: boolean): void;
  };
  quickInput: {
    submit(message: string): Promise<void>;
    dismiss(): Promise<void>;
  };
  commandPalette: {
    open(): Promise<void>;
    dismiss(): Promise<void>;
    select(command: VellumCommand): Promise<void>;
  };
  dictationOverlay: {
    setState(state: DictationOverlayMessage): void;
    onState(callback: (state: DictationOverlayState) => void): () => void;
    getState(): Promise<DictationOverlayState | null>;
  };
  popout: {
    open(conversationId: string): Promise<void>;
  };
  /**
   * The always-on companion: the always-on-top creature rendered by the SPA's
   * `/assistant/floating/companion` route.
   *
   * The division of labour is the thing to understand here. Main owns the
   * canvas (which never resizes on a phase), where the creature is, which way
   * it has room to unfurl, and who owns the clicks; the renderer draws what
   * it is given and reports back what the pointer is over. That is not
   * fastidiousness — the window is many times the size of anything drawn in
   * it, and a renderer that decided its own hover would have to claim the
   * whole canvas to find out, which is how an always-on-top surface ends up
   * swallowing clicks meant for other applications.
   *
   * `setPointerOver` is that report, and `onState`/`getState` carry main's
   * answer back. `dragBegin`/`dragEnd` bracket a press: every coordinate in
   * between is read from the cursor by main, because a window moved one IPC
   * message at a time cannot keep up with a fast hand. `setSize` is the one
   * thing that legitimately resizes the canvas. `talk` surfaces the main
   * window and starts the voice-room entry path; `openCue` surfaces it;
   * `hide` hides the companion (persisted until re-enabled from the tray).
   *
   * There is deliberately no status channel here: whose turn it is reaches
   * the creature as a *phase*, resolved by main against everything else it
   * knows. A renderer holding the raw status too would be one question with
   * two answers, and the one that loses is whichever the user is looking at.
   */
  companion: {
    setPointerOver(over: boolean): void;
    dragBegin(): void;
    dragEnd(): void;
    menu(): Promise<void>;
    setSize(size: string): Promise<void>;
    getState(): Promise<Record<string, unknown>>;
    onState(callback: (state: Record<string, unknown>) => void): () => void;
    talk(): Promise<void>;
    openCue(): Promise<void>;
    hide(): Promise<void>;
  };
  /**
   * The floating corner: one exchange, summoned with `⌥C`, then finished.
   * Rendered by the SPA's `/assistant/floating/corner` route.
   *
   * `getSelection` pulls whatever the owner had highlighted when they
   * summoned — main reads it BEFORE showing the panel, while their own app is
   * still frontmost, and `onSelection` carries the same value for a window
   * that is already open. `null` means nothing was selected, which is an
   * ordinary state and not an error. `hide` closes the panel and deliberately
   * cancels nothing: work in flight keeps running and reports in HQ.
   * `openInCue` hands the exchange to the app — the escape hatch that stops
   * the panel growing back into a thread.
   */
  corner: {
    getSelection(): Promise<CornerSelection | null>;
    onSelection(
      callback: (selection: CornerSelection | null) => void,
    ): () => void;
    getContext(): Promise<CornerContext>;
    onContext(callback: (context: CornerContext) => void): () => void;
    /** Answer the screen-reading invite. Recorded once and honoured. */
    setScreenReading(granted: boolean): Promise<void>;
    hide(): Promise<void>;
    openInCue(text: string): Promise<void>;
  };
  /**
   * Embedded VentureVerse app view (desktop inline embedding). The SPA's app
   * page drives a native WebContentsView composited into the Cue window so a
   * VentureVerse app runs first-party (its SSO handshake completes) while
   * visually embedded. See apps/macos/src/main/ventureverse-view.ts.
   */
  vvView: {
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
  update: {
    getState(): Promise<UpdateState>;
    check(): Promise<void>;
    install(): Promise<void>;
    onState(callback: (state: UpdateState) => void): () => void;
  };
}
