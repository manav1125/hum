import { getGatewayToken } from "@/lib/auth/gateway-session";

/**
 * The web side of the Halo bridge.
 *
 * Cue's mobile client is a web SPA, and almost everything belongs there. Halo
 * does not: its surfaces are native (see `apps/ios/App/App/HaloPlugin.swift`
 * for why), so the SPA's job is to hand over the instance it is signed into
 * and then get out of the way.
 *
 * The seam is deliberately narrow — configure, open a surface — because every
 * capability that crosses it has to be maintained on both sides.
 */

/** What the native plugin exposes. Mirrors `HaloPlugin.pluginMethods`. */
export interface HaloNativePlugin {
  configure(options: { baseURL: string; token: string }): Promise<void>;
  openDay(): Promise<{ state?: string }>;
  openQueue(): Promise<{ state?: string }>;
  openRecap(): Promise<{ state?: string }>;
  openOnboarding(): Promise<void>;
}

interface CapacitorGlobal {
  Plugins?: Record<string, unknown>;
  isNativePlatform?: () => boolean;
}

/**
 * Resolve the plugin, or null off-native.
 *
 * Returning null rather than throwing is the point: every caller here is a
 * button that should simply not be shown on web, and a bridge that throws
 * would push that decision into a try/catch at each call site.
 *
 * Note the shape check. `Capacitor.Plugins` is permanently `{}` when the shell
 * runs without a bundler — the trap that once swallowed the iOS magic-link
 * hand-off — so presence of the object proves nothing and the method has to be
 * probed for.
 */
export function resolveHalo(): HaloNativePlugin | null {
  const capacitor = (globalThis as { Capacitor?: CapacitorGlobal }).Capacitor;
  if (!capacitor?.isNativePlatform?.()) return null;

  const plugin = capacitor.Plugins?.Halo as HaloNativePlugin | undefined;
  if (!plugin || typeof plugin.openDay !== "function") return null;
  return plugin;
}

/** True when Halo's native surfaces can actually be opened. */
export function isHaloAvailable(): boolean {
  return resolveHalo() !== null;
}

/**
 * Hand the native side the instance the SPA is signed into.
 *
 * Deliberately passes the SPA's own base URL and token rather than letting the
 * plugin discover them: a second copy of auth on the native side could
 * disagree about which instance somebody is signed into, and "my Halo is
 * showing someone else's day" is not a bug worth risking to save a parameter.
 */
export async function configureHalo(
  baseURL: string,
  token: string,
): Promise<boolean> {
  const halo = resolveHalo();
  if (!halo) return false;
  await halo.configure({ baseURL, token });
  return true;
}

/**
 * Configure once per page, lazily, from the session the SPA is already using.
 *
 * The native side needs an instance URL and a token before it can open
 * anything. Leaving that to callers is how the door ends up doing nothing on a
 * real device: every call site has to remember, and the one that forgets fails
 * silently with "Halo is not configured" — which is exactly the state this
 * shipped in before a device ever ran it.
 *
 * `location.origin` is the instance, because the SPA is served by it. Taking
 * the base URL from anywhere else would risk the native surfaces reading a
 * different instance than the app around them.
 */
let configured: Promise<boolean> | null = null;

export interface HaloSession {
  baseURL: string;
  token: string;
}

/**
 * Where the session comes from. Overridable because the default reads
 * `localStorage`, which does not exist outside a browser — and a bridge whose
 * central behaviour can only be exercised in a DOM is a bridge whose central
 * behaviour goes untested.
 */
let resolveSession: () => HaloSession | null = () => {
  const token = getGatewayToken();
  if (!token) return null;
  return { baseURL: globalThis.location.origin, token };
};

/** Test-only override. Pass `null` to restore the real resolver. */
export function _setHaloSessionForTests(
  resolver: (() => HaloSession | null) | null,
): void {
  resolveSession =
    resolver ??
    (() => {
      const token = getGatewayToken();
      if (!token) return null;
      return { baseURL: globalThis.location.origin, token };
    });
  configured = null;
}

async function ensureConfigured(): Promise<boolean> {
  if (configured) return configured;
  configured = (async () => {
    const halo = resolveHalo();
    if (!halo) return false;
    const session = resolveSession();
    // No usable session — an expired token must not configure Halo, and an
    // unconfigured surface must not open.
    if (!session) return false;
    await halo.configure(session);
    return true;
  })();
  return configured;
}

/** Forget the cached configuration — used when the session changes. */
export function resetHaloConfiguration(): void {
  configured = null;
}

export type HaloSurface = "day" | "queue" | "recap" | "onboarding";

/**
 * Open a Halo surface. Resolves false when Halo is not available, so callers
 * can fall back to the web route without branching on the platform.
 */
export async function openHalo(surface: HaloSurface): Promise<boolean> {
  const halo = resolveHalo();
  if (!halo) return false;
  // Self-configuring: a surface that opens to "not configured" is worse than
  // one that never opened, because it looks like the feature is broken.
  if (!(await ensureConfigured())) return false;

  switch (surface) {
    case "day":
      await halo.openDay();
      return true;
    case "queue":
      await halo.openQueue();
      return true;
    case "recap":
      await halo.openRecap();
      return true;
    case "onboarding":
      await halo.openOnboarding();
      return true;
  }
}
