/**
 * Learn sidecar configuration — the env contract for provisioning a
 * per-customer Cue Learn (OpenMAIC fork) app next to the instance.
 *
 * All-or-nothing env gate, same idiom as `customDomainConfig`: the feature is
 * ON only when BOTH `HQ_LEARN_IMAGE_REF` (the fleet sidecar image — built by
 * `hq/scripts/learn-release.sh` from the repo's `learn/` tree, WITHOUT the
 * server-persistence build flags, see below) and `HQ_LEARN_GOOGLE_API_KEY`
 * are set. Everything else is optional enrichment.
 *
 * Fleet sidecars deliberately run the browser-persistence build: server
 * persistence compiles a bearer token into the client bundle, and one shared
 * fleet image would mean one shared token across every customer on the same
 * 6PN network — a cross-tenant hole. Until sidecar builds are per-customer,
 * the fleet image must NOT enable NEXT_PUBLIC_PERSISTENCE.
 *
 * The sidecar gets NO public IPs and no services: it is reachable only as
 * `http://<app>.internal:3000` from the customer's instance, whose gateway
 * fronts it with the learn-session cookie.
 */

export interface LearnSidecarEnvConfig {
  image: string;
  /** Shared platform env for every sidecar (keys, model defaults). */
  env: Record<string, string>;
}

export function learnSidecarConfig(): LearnSidecarEnvConfig | null {
  const image = process.env.HQ_LEARN_IMAGE_REF?.trim();
  const googleKey = process.env.HQ_LEARN_GOOGLE_API_KEY?.trim();
  if (!image || !googleKey) return null;

  const env: Record<string, string> = {
    // Fly private networking is IPv6-only; the upstream image's 0.0.0.0
    // default binds IPv4 and is unreachable over 6PN.
    HOSTNAME: "::",
    OPENMAIC_BASE_PATH: "/learn",
    // One owner per deployment: the browser, the gateway, and the daemon all
    // resolve to the same course owner (the fork's OPENMAIC_FIXED_OWNER_ID).
    OPENMAIC_FIXED_OWNER_ID: "cue-owner",
    // Persistence auth happened upstream at the gateway (access-secret
    // middleware) — the compiled-in dev token is not consulted, which is
    // what lets one shared image serve many single-tenant sidecars.
    OPENMAIC_TRUST_PROXY_AUTH: "1",
    DEFAULT_MODEL:
      process.env.HQ_LEARN_DEFAULT_MODEL?.trim() ||
      "google:gemini-3-flash-preview",
    PARALLEL_SCENE_CONCURRENCY:
      process.env.HQ_LEARN_SCENE_CONCURRENCY?.trim() || "3",
    // One Google key powers LLM, image (Nano Banana), and video (Veo).
    GOOGLE_API_KEY: googleKey,
    IMAGE_NANO_BANANA_API_KEY: googleKey,
    VIDEO_VEO_API_KEY: googleKey,
  };
  const elevenlabs = process.env.HQ_LEARN_ELEVENLABS_API_KEY?.trim();
  if (elevenlabs) {
    env.TTS_ELEVENLABS_API_KEY = elevenlabs;
    env.ASR_ELEVENLABS_API_KEY = elevenlabs;
  }
  const tavily = process.env.HQ_LEARN_TAVILY_API_KEY?.trim();
  if (tavily) env.TAVILY_API_KEY = tavily;

  return { image, env };
}
