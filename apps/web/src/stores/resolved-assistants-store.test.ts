import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  assistantsValidForOrg,
  useResolvedAssistantsStore,
  type ResolvedAssistant,
} from "@/stores/resolved-assistants-store";
import { SELECTED_ASSISTANT_STORAGE_KEY } from "@/assistant/selected-assistant-storage";
import { useLockfileStore } from "@/stores/lockfile-store";
import type { Lockfile, LockfileAssistant } from "@/runtime/local-mode-host";

// A platform entry is identified by `cloud === "vellum"` and carries an
// `organizationId`; a local entry has a non-vellum cloud + gateway port and no org.
const platformAssistant: LockfileAssistant = {
  assistantId: "asst-platform",
  name: "Platform",
  cloud: "vellum",
  organizationId: "org-1",
};

const localAssistant: LockfileAssistant = {
  assistantId: "asst-local",
  name: "Local",
  cloud: "local",
  resources: { gatewayPort: 7830, daemonPort: 7831 },
};

beforeEach(() => {
  localStorage.removeItem(SELECTED_ASSISTANT_STORAGE_KEY);
  useLockfileStore.setState({ lockfile: null, committed: false });
  useResolvedAssistantsStore.setState({
    assistants: [],
    selectedAssistantId: null,
    assistantsHydrated: false,
  });
});

describe("setFromLockfile", () => {
  it("copies organizationId for platform entries", () => {
    const lockfile: Lockfile = {
      assistants: [platformAssistant],
      activeAssistant: null,
    };
    useResolvedAssistantsStore.getState().setFromLockfile(lockfile);

    const entry = useResolvedAssistantsStore.getState().assistants[0];
    expect(entry.id).toBe("asst-platform");
    expect(entry.isPlatformHosted).toBe(true);
    expect(entry.organizationId).toBe("org-1");
  });

  it("leaves organizationId undefined for local entries", () => {
    const lockfile: Lockfile = {
      assistants: [localAssistant],
      activeAssistant: null,
    };
    useResolvedAssistantsStore.getState().setFromLockfile(lockfile);

    const entry = useResolvedAssistantsStore.getState().assistants[0];
    expect(entry.id).toBe("asst-local");
    expect(entry.isLocal).toBe(true);
    expect(entry.organizationId).toBeUndefined();
  });

  it("collapses duplicate ids so the picker shows one card per assistant", () => {
    // The same id present twice (e.g. the local set and a synced platform list
    // both carrying it) must not render as two identical cards.
    const lockfile: Lockfile = {
      assistants: [localAssistant, { ...localAssistant, name: "Local (dupe)" }],
      activeAssistant: null,
    };
    useResolvedAssistantsStore.getState().setFromLockfile(lockfile);

    const { assistants } = useResolvedAssistantsStore.getState();
    expect(assistants).toHaveLength(1);
    expect(assistants[0].id).toBe("asst-local");
    // First occurrence wins.
    expect(assistants[0].name).toBe("Local");
  });
});

describe("setFromApi dedup", () => {
  it("collapses duplicate ids from the platform list", () => {
    type ApiAssistant = Parameters<
      ReturnType<typeof useResolvedAssistantsStore.getState>["setFromApi"]
    >[0][number];
    const entries: ApiAssistant[] = [
      { id: "asst-x", name: "X", is_local: true, created: "2026-01-01" },
      { id: "asst-x", name: "X again", is_local: true, created: "2026-01-02" },
      { id: "asst-y", name: "Y", is_local: false, created: "2026-01-03" },
    ] as ApiAssistant[];
    useResolvedAssistantsStore.getState().setFromApi(entries);

    const ids = useResolvedAssistantsStore
      .getState()
      .assistants.map((a) => a.id);
    expect(ids).toEqual(["asst-x", "asst-y"]);
  });
});

describe("upsertFromApi", () => {
  it("preserves a lockfile-seeded organizationId on refresh (API has no org)", () => {
    useResolvedAssistantsStore.getState().setFromLockfile({
      assistants: [platformAssistant],
      activeAssistant: null,
    });

    // A lifecycle refresh upserts the API-shaped payload, which carries no org.
    useResolvedAssistantsStore.getState().upsertFromApi({
      id: "asst-platform",
      name: "Platform (refreshed)",
      created: "2026-01-01T00:00:00Z",
      is_local: false,
    } as Parameters<
      ReturnType<typeof useResolvedAssistantsStore.getState>["upsertFromApi"]
    >[0]);

    const entry = useResolvedAssistantsStore.getState().assistants[0];
    expect(entry.id).toBe("asst-platform");
    expect(entry.name).toBe("Platform (refreshed)");
    expect(entry.organizationId).toBe("org-1");
  });

  it("seeds organizationId from the lockfile cache when inserting a new entry", () => {
    // A lifecycle refresh can land before the lockfile subscription has seeded
    // the resolved list; the insert must still pick up the org the lockfile knows.
    useLockfileStore.getState().setLockfile({
      assistants: [platformAssistant],
      activeAssistant: null,
    });

    useResolvedAssistantsStore.getState().upsertFromApi({
      id: "asst-platform",
      name: "Platform",
      created: "2026-01-01T00:00:00Z",
      is_local: false,
    } as Parameters<
      ReturnType<typeof useResolvedAssistantsStore.getState>["upsertFromApi"]
    >[0]);

    const entry = useResolvedAssistantsStore.getState().assistants[0];
    expect(entry.id).toBe("asst-platform");
    expect(entry.organizationId).toBe("org-1");
  });
});

describe("assistantsValidForOrg", () => {
  const local: ResolvedAssistant = {
    id: "local",
    isLocal: true,
    isPlatformHosted: false,
  };
  const activeOrg: ResolvedAssistant = {
    id: "active-org",
    isLocal: false,
    isPlatformHosted: true,
    organizationId: "org-1",
  };
  const otherOrg: ResolvedAssistant = {
    id: "other-org",
    isLocal: false,
    isPlatformHosted: true,
    organizationId: "org-2",
  };
  const legacy: ResolvedAssistant = {
    id: "legacy",
    isLocal: false,
    isPlatformHosted: true,
  };

  it("always keeps local entries", () => {
    expect(assistantsValidForOrg([local], "org-1")).toEqual([local]);
    expect(assistantsValidForOrg([local], null)).toEqual([local]);
  });

  it("keeps platform entries only when owned by the active org", () => {
    const result = assistantsValidForOrg([activeOrg, otherOrg], "org-1");
    expect(result).toEqual([activeOrg]);
  });

  it("keeps legacy entries with no org (undefined)", () => {
    expect(assistantsValidForOrg([legacy], "org-1")).toEqual([legacy]);
  });

  it("drops cross-org platform entries", () => {
    expect(assistantsValidForOrg([otherOrg], "org-1")).toEqual([]);
  });
});

describe("setSelectedAssistant", () => {
  it("moves the reactive slice and the persisted key together", () => {
    useResolvedAssistantsStore.getState().setSelectedAssistant("asst-1");
    expect(useResolvedAssistantsStore.getState().selectedAssistantId).toBe(
      "asst-1",
    );
    expect(localStorage.getItem(SELECTED_ASSISTANT_STORAGE_KEY)).toBe("asst-1");

    useResolvedAssistantsStore.getState().setSelectedAssistant(null);
    expect(
      useResolvedAssistantsStore.getState().selectedAssistantId,
    ).toBeNull();
    expect(localStorage.getItem(SELECTED_ASSISTANT_STORAGE_KEY)).toBeNull();
  });
});

describe("selection reconcile on hydration", () => {
  it("clears a selection absent from the lockfile (the ghost case)", () => {
    useResolvedAssistantsStore.getState().setSelectedAssistant("asst-ghost");
    useResolvedAssistantsStore.getState().setFromLockfile({
      assistants: [localAssistant],
      activeAssistant: null,
    });
    expect(
      useResolvedAssistantsStore.getState().selectedAssistantId,
    ).toBeNull();
    expect(localStorage.getItem(SELECTED_ASSISTANT_STORAGE_KEY)).toBeNull();
  });

  it("preserves a selection still present in the lockfile", () => {
    useResolvedAssistantsStore.getState().setSelectedAssistant("asst-local");
    useResolvedAssistantsStore.getState().setFromLockfile({
      assistants: [localAssistant],
      activeAssistant: null,
    });
    expect(useResolvedAssistantsStore.getState().selectedAssistantId).toBe(
      "asst-local",
    );
  });

  it("does NOT clear a cross-org selection on the org-scoped API list", () => {
    // setFromApi reflects only the active org's assistants; a selection for a
    // different org must survive (it's filtered on read, never deleted here).
    const apiEntry = {
      id: "asst-active-org",
      name: "Active",
      created: "2026-01-01T00:00:00Z",
      is_local: false,
    } as Parameters<
      ReturnType<typeof useResolvedAssistantsStore.getState>["upsertFromApi"]
    >[0];
    useResolvedAssistantsStore
      .getState()
      .setSelectedAssistant("asst-other-org");
    useResolvedAssistantsStore.getState().setFromApi([apiEntry]);
    expect(useResolvedAssistantsStore.getState().selectedAssistantId).toBe(
      "asst-other-org",
    );
  });
});

describe("selection adopt activeAssistant (local mode, hydration)", () => {
  // The store gates the adopt step on `isLocalMode()`, which reads
  // `import.meta.env.VITE_PLATFORM_MODE` live; test-setup forces platform mode,
  // so flip the env to local for this block and restore it after.
  let prevMode: string | undefined;
  beforeEach(() => {
    prevMode = process.env.VITE_PLATFORM_MODE;
    delete process.env.VITE_PLATFORM_MODE;
  });
  afterEach(() => {
    if (prevMode === undefined) delete process.env.VITE_PLATFORM_MODE;
    else process.env.VITE_PLATFORM_MODE = prevMode;
  });

  const newer: LockfileAssistant = {
    assistantId: "asst-newer",
    name: "Newer",
    cloud: "local",
    resources: { gatewayPort: 7831, daemonPort: 7832 },
  };

  it("adopts the lockfile activeAssistant when a present-but-stale local selection diverges", () => {
    // The stuck-on-"Connecting" bug: a selection persisted from a prior session
    // points at a local assistant that is still listed but is no longer the
    // active one (a newer assistant was hatched/activated since). `reconcile`
    // leaves the present id alone, so without the adopt step the lifecycle would
    // try to connect to the superseded — possibly stopped — gateway and hang.
    useResolvedAssistantsStore.getState().setSelectedAssistant("asst-local");
    useResolvedAssistantsStore.getState().setFromLockfile({
      assistants: [localAssistant, newer],
      activeAssistant: "asst-newer",
    });
    expect(useResolvedAssistantsStore.getState().selectedAssistantId).toBe(
      "asst-newer",
    );
    // Mirrored into the key getSelectedAssistant reads, so the connect flow
    // targets the live gateway.
    expect(localStorage.getItem(SELECTED_ASSISTANT_STORAGE_KEY)).toBe(
      "asst-newer",
    );
  });

  it("ignores a dangling activeAssistant absent from the list", () => {
    useResolvedAssistantsStore.getState().setSelectedAssistant("asst-local");
    useResolvedAssistantsStore.getState().setFromLockfile({
      assistants: [localAssistant],
      activeAssistant: "asst-gone",
    });
    expect(useResolvedAssistantsStore.getState().selectedAssistantId).toBe(
      "asst-local",
    );
  });

  it("does not re-adopt the active over an in-app switch after hydration", () => {
    // First load hydrates and aligns selection with the active assistant.
    useResolvedAssistantsStore.getState().setFromLockfile({
      assistants: [localAssistant, newer],
      activeAssistant: "asst-newer",
    });
    // The user switches to another assistant in-app; a background lockfile
    // refresh still carrying the old active must not clobber that choice.
    useResolvedAssistantsStore.getState().setSelectedAssistant("asst-local");
    useResolvedAssistantsStore.getState().setFromLockfile({
      assistants: [localAssistant, newer],
      activeAssistant: "asst-newer",
    });
    expect(useResolvedAssistantsStore.getState().selectedAssistantId).toBe(
      "asst-local",
    );
  });
});
