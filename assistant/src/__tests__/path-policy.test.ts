import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, mock, test } from "bun:test";

import {
  hostPolicy,
  isProcessPrivatePath,
  isSecurityDirPath,
  sandboxPolicy,
} from "../tools/shared/filesystem/path-policy.js";

// ── Mock setup for skill path classifier ────────────────────────────────────
// The classifier imports getWorkspaceSkillsDir and getBundledSkillsDir, which
// need stable test directories to avoid depending on the real home directory.
// We create and realpath the root eagerly so that macOS's /tmp -> /private/tmp
// symlink doesn't cause prefix mismatches between normalized roots and paths.

const CLASSIFIER_TEST_ROOT = process.env.VELLUM_WORKSPACE_DIR!;
const MOCK_MANAGED_DIR = join(CLASSIFIER_TEST_ROOT, "skills");
const MOCK_BUNDLED_DIR = join(CLASSIFIER_TEST_ROOT, "bundled-skills");

mock.module("../config/skills.js", () => ({
  getBundledSkillsDir: () => MOCK_BUNDLED_DIR,
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

const {
  isSkillSourcePath,
  normalizeDirPath,
  normalizeFilePath,
  getSkillRoots,
  getManagedSkillsRoot,
  getBundledSkillsRoot,
} = await import("../skills/path-classifier.js");

const testDirs: string[] = [];

afterEach(() => {
  for (const dir of testDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "path-policy-test-")));
  testDirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// Sandbox policy
// ---------------------------------------------------------------------------

describe("sandboxPolicy", () => {
  test("rejects traversal escape via ../", () => {
    const boundary = makeTempDir();
    const result = sandboxPolicy("../../etc/passwd", boundary);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("out_of_bounds");
      expect(result.error).toContain("outside the working directory");
    }
  });

  test("rejects deep traversal escape", () => {
    const boundary = makeTempDir();
    mkdirSync(join(boundary, "a", "b"), { recursive: true });
    const result = sandboxPolicy("a/b/../../../../etc/shadow", boundary);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("out_of_bounds");
      expect(result.error).toContain("outside the working directory");
    }
  });

  test("rejects symlink that escapes the boundary", () => {
    const boundary = makeTempDir();
    const outside = makeTempDir();

    // Create a symlink inside the boundary that points outside
    symlinkSync(outside, join(boundary, "escape-link"));

    const result = sandboxPolicy("escape-link", boundary);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("out_of_bounds");
      expect(result.error).toContain("outside the working directory");
    }
  });

  test("rejects parent dir symlink escape in mustExist=false flow", () => {
    const boundary = makeTempDir();
    const outside = makeTempDir();

    // Create a symlink directory inside boundary pointing outside
    symlinkSync(outside, join(boundary, "link-dir"));

    // Writing a new file under link-dir should be caught
    const result = sandboxPolicy("link-dir/new-file.txt", boundary, {
      mustExist: false,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("out_of_bounds");
      expect(result.error).toContain("outside the working directory");
    }
  });

  test("accepts valid relative path within boundary", () => {
    const boundary = makeTempDir();
    mkdirSync(join(boundary, "sub"));

    const result = sandboxPolicy("sub/file.txt", boundary);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved).toBe(join(boundary, "sub", "file.txt"));
    }
  });

  test("accepts absolute path within boundary", () => {
    const boundary = makeTempDir();
    const filePath = join(boundary, "file.txt");

    const result = sandboxPolicy(filePath, boundary);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved).toBe(filePath);
    }
  });

  test("accepts new file path with mustExist=false", () => {
    const boundary = makeTempDir();
    mkdirSync(join(boundary, "subdir"));

    const result = sandboxPolicy("subdir/new-file.txt", boundary, {
      mustExist: false,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved).toBe(join(boundary, "subdir", "new-file.txt"));
    }
  });

  test("remaps /workspace/ paths to boundary dir", () => {
    const boundary = makeTempDir();
    mkdirSync(join(boundary, "scratch"));

    const result = sandboxPolicy("/workspace/scratch/file.png", boundary);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved).toBe(join(boundary, "scratch", "file.png"));
    }
  });

  test("remaps bare /workspace to boundary root", () => {
    const boundary = makeTempDir();

    const result = sandboxPolicy("/workspace", boundary);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved).toBe(boundary);
    }
  });

  test("does not double-nest when boundaryDir is under /workspace", () => {
    const boundary = "/workspace/project";

    const result = sandboxPolicy("/workspace/project/file.ts", boundary, {
      mustExist: false,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved).toBe("/workspace/project/file.ts");
    }
  });

  test("remapped /workspace path still rejects traversal escapes", () => {
    const boundary = makeTempDir();

    const result = sandboxPolicy("/workspace/../../../etc/passwd", boundary);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("out_of_bounds");
    }
  });
});

// ---------------------------------------------------------------------------
// Host policy
// ---------------------------------------------------------------------------

describe("hostPolicy", () => {
  test("rejects relative path", () => {
    const result = hostPolicy("relative/path.txt");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("not_absolute");
      expect(result.error).toContain("must be absolute");
      expect(result.error).toContain("relative/path.txt");
    }
  });

  test("rejects bare filename", () => {
    const result = hostPolicy("file.txt");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("not_absolute");
      expect(result.error).toContain("must be absolute");
    }
  });

  test("accepts absolute path", () => {
    const result = hostPolicy("/usr/local/bin/something");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved).toBe("/usr/local/bin/something");
    }
  });

  test("accepts root path", () => {
    const result = hostPolicy("/");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved).toBe("/");
    }
  });

  // The host policy applies no boundary at all, so before this denial existed
  // `host_file_read("/proc/self/environ")` handed back the daemon's entire
  // environment: the actor-token signing key, the CES service token, the
  // guardian bootstrap secret, and every provider API key forwarded in at
  // launch. The bash tool already strips those via SAFE_ENV_VARS, so the file
  // tools were the looser path to the same secrets.
  test.each([
    "/proc/self/environ",
    "/proc/thread-self/environ",
    "/proc/1/environ",
    "/proc/48231/environ",
    // The per-thread republication of the same environment. Reachable in two
    // reads with no privileges: /proc/self/status names the pid, and the main
    // thread's tid equals it. An environ-only denial misses this entirely.
    "/proc/self/task/1/environ",
    "/proc/48231/task/48231/environ",
    // Siblings that leak the same material by other means.
    "/proc/self/cmdline",
    "/proc/self/mem",
    "/proc/self/fd/3",
    // Symlinks out of the per-process dir that resolve anywhere on the host.
    "/proc/self/root/etc/shadow",
    "/proc/self/cwd",
  ])("denies the process-private /proc entry %s", (path) => {
    const result = hostPolicy(path);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("denied");
      expect(result.error).toContain("process-private");
    }
  });

  test("still allows system-wide /proc entries", () => {
    // The denial covers per-process directories, not /proc as a whole.
    expect(hostPolicy("/proc/cpuinfo").ok).toBe(true);
    expect(hostPolicy("/proc/meminfo").ok).toBe(true);
    expect(hostPolicy("/proc/loadavg").ok).toBe(true);
  });
});

describe("isProcessPrivatePath", () => {
  test("matches every per-process form", () => {
    expect(isProcessPrivatePath("/proc/self/environ")).toBe(true);
    expect(isProcessPrivatePath("/proc/thread-self/environ")).toBe(true);
    expect(isProcessPrivatePath("/proc/9/environ")).toBe(true);
    expect(isProcessPrivatePath("/proc/9/task/9/environ")).toBe(true);
    expect(isProcessPrivatePath("/proc/self/anything/at/all")).toBe(true);
    // The directory itself, with no trailing component.
    expect(isProcessPrivatePath("/proc/self")).toBe(true);
  });

  test("does not match system-wide entries or lookalikes", () => {
    expect(isProcessPrivatePath("/proc/cpuinfo")).toBe(false);
    expect(isProcessPrivatePath("/proc/selfish/environ")).toBe(false);
    expect(isProcessPrivatePath("/home/me/proc/self/environ")).toBe(false);
    expect(isProcessPrivatePath("/proc/notapid/environ")).toBe(false);
    expect(isProcessPrivatePath("/environ")).toBe(false);
  });
});

// The gateway security directory holds the actor-token signing key (the root
// of the auth system), the backup key, and gateway.sqlite (trust rules and
// tokens). hostPolicy applies no boundary, so before this denial existed
// `host_file_read("$GATEWAY_SECURITY_DIR/actor-token-signing-key")` was gated
// only by a risk prompt — and by nothing at all under a temporary approval
// grant. The layout mirrored here is the real one from prod.
describe("security directory denial", () => {
  const savedGateway = process.env.GATEWAY_SECURITY_DIR;
  const savedCredential = process.env.CREDENTIAL_SECURITY_DIR;

  afterEach(() => {
    if (savedGateway === undefined) delete process.env.GATEWAY_SECURITY_DIR;
    else process.env.GATEWAY_SECURITY_DIR = savedGateway;
    if (savedCredential === undefined)
      delete process.env.CREDENTIAL_SECURITY_DIR;
    else process.env.CREDENTIAL_SECURITY_DIR = savedCredential;
  });

  test("host reads of gateway security material are denied", () => {
    const secDir = makeTempDir();
    process.env.GATEWAY_SECURITY_DIR = secDir;
    for (const name of [
      "actor-token-signing-key",
      "gateway.sqlite",
      "feature-flags.json",
      "logs/gateway.log",
    ]) {
      const result = hostPolicy(join(secDir, name));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("denied");
      }
    }
  });

  test("the credential store is denied too", () => {
    const credDir = makeTempDir();
    process.env.CREDENTIAL_SECURITY_DIR = credDir;
    const result = hostPolicy(join(credDir, "keys", "master.key"));
    expect(result.ok).toBe(false);
  });

  test("a symlink into the security dir does not get around it", () => {
    const secDir = makeTempDir();
    const workspace = makeTempDir();
    process.env.GATEWAY_SECURITY_DIR = secDir;
    writeFileSync(join(secDir, "actor-token-signing-key"), "secret");
    const link = join(workspace, "notes.txt");
    symlinkSync(join(secDir, "actor-token-signing-key"), link);

    expect(hostPolicy(link).ok).toBe(false);
    const sandboxed = sandboxPolicy(link, workspace);
    expect(sandboxed.ok).toBe(false);
  });

  test("the signing key is denied by basename even with no env var set", () => {
    delete process.env.GATEWAY_SECURITY_DIR;
    delete process.env.CREDENTIAL_SECURITY_DIR;
    const result = hostPolicy("/somewhere/else/actor-token-signing-key");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("denied");
    }
  });

  test("neighbouring paths outside the security dir stay readable", () => {
    const secDir = makeTempDir();
    process.env.GATEWAY_SECURITY_DIR = secDir;
    // A sibling whose path merely shares the prefix string must not be caught.
    expect(hostPolicy(secDir + "-notes/readme.md").ok).toBe(true);
    expect(hostPolicy("/usr/local/bin/something").ok).toBe(true);
  });

  test("an unset or relative env var denies nothing by accident", () => {
    delete process.env.GATEWAY_SECURITY_DIR;
    expect(isSecurityDirPath("/anything/at/all")).toBe(false);
    process.env.GATEWAY_SECURITY_DIR = "relative/not/absolute";
    expect(isSecurityDirPath("/anything/at/all")).toBe(false);
  });
});

describe("sandboxPolicy — process environment blocks", () => {
  test("a symlink inside the workspace pointing at environ is denied", () => {
    // Only meaningful where /proc exists (Linux, i.e. prod). On macOS dev
    // boxes the link dangles, realpathSync cannot resolve it, and there is no
    // environ block to reach in the first place; the hostPolicy cases above
    // cover the logical-path denial on every platform.
    if (!existsSync("/proc/self/environ")) {
      return;
    }
    const dir = makeTempDir();
    const link = join(dir, "harmless.txt");
    symlinkSync("/proc/self/environ", link);
    const result = sandboxPolicy(link, dir);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("denied");
    }
  });
});

// ---------------------------------------------------------------------------
// Baseline: Skill directory paths have no special treatment (PR 1)
// ---------------------------------------------------------------------------

describe("baseline: skill directory paths (PR 1)", () => {
  test("sandbox policy accepts skill directory paths within boundary", () => {
    const boundary = makeTempDir();
    mkdirSync(join(boundary, "skills", "my-skill"), { recursive: true });

    const result = sandboxPolicy("skills/my-skill/executor.ts", boundary, {
      mustExist: false,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved).toBe(
        join(boundary, "skills", "my-skill", "executor.ts"),
      );
    }
  });

  test("sandbox policy treats skill TOOLS.json same as any other file", () => {
    const boundary = makeTempDir();
    mkdirSync(join(boundary, "skills", "my-skill"), { recursive: true });

    const result = sandboxPolicy("skills/my-skill/TOOLS.json", boundary, {
      mustExist: false,
    });
    expect(result.ok).toBe(true);
  });

  test("host policy accepts absolute skill directory path", () => {
    const result = hostPolicy(
      "/Users/test/.vellum/workspace/skills/my-skill/executor.ts",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolved).toBe(
        "/Users/test/.vellum/workspace/skills/my-skill/executor.ts",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Skill path classifier (PR 26)
// ---------------------------------------------------------------------------

describe("normalizeDirPath", () => {
  test("appends trailing separator to plain path", () => {
    const result = normalizeDirPath("/foo/bar");
    expect(result.endsWith(sep)).toBe(true);
  });

  test("does not double-add trailing separator", () => {
    const result = normalizeDirPath("/foo/bar/");
    expect(result).toBe(`/foo/bar${sep}`);
    // Should not end with double separators
    expect(result.endsWith(`${sep}${sep}`)).toBe(false);
  });

  test("resolves dot segments", () => {
    const result = normalizeDirPath("/foo/bar/../baz");
    expect(result).toBe(`/foo/baz${sep}`);
  });

  test("resolves symlinks when directory exists on disk", () => {
    const real = makeTempDir();
    const linkParent = makeTempDir();
    const link = join(linkParent, "link-to-real");
    symlinkSync(real, link);

    const result = normalizeDirPath(link);
    expect(result).toBe(real + sep);
  });
});

describe("normalizeFilePath", () => {
  test("resolves dot segments for non-existent path", () => {
    const result = normalizeFilePath("/foo/bar/../baz/file.ts");
    expect(result).toBe("/foo/baz/file.ts");
  });

  test("resolves symlinks for existing files", () => {
    const dir = makeTempDir();
    const realFile = join(dir, "real.txt");
    writeFileSync(realFile, "content");
    const linkFile = join(dir, "link.txt");
    symlinkSync(realFile, linkFile);

    const result = normalizeFilePath(linkFile);
    expect(result).toBe(realFile);
  });
});

describe("getManagedSkillsRoot / getBundledSkillsRoot", () => {
  test("returns managed skills dir with trailing separator", () => {
    const root = getManagedSkillsRoot();
    expect(root.endsWith(sep)).toBe(true);
    expect(root).toContain("skills");
  });

  test("returns bundled skills dir with trailing separator", () => {
    const root = getBundledSkillsRoot();
    expect(root.endsWith(sep)).toBe(true);
    expect(root).toContain("bundled-skills");
  });
});

describe("getSkillRoots", () => {
  test("includes managed and bundled roots by default", () => {
    const roots = getSkillRoots();
    expect(roots.length).toBeGreaterThanOrEqual(2);
    expect(roots.some((r) => r.includes("skills"))).toBe(true);
    expect(roots.some((r) => r.includes("bundled-skills"))).toBe(true);
  });

  test("includes extra roots when provided", () => {
    const extra = "/custom/skill-dir";
    const roots = getSkillRoots([extra]);
    expect(roots.length).toBeGreaterThanOrEqual(3);
    expect(roots.some((r) => r.includes("custom"))).toBe(true);
  });

  test("all roots end with separator", () => {
    const roots = getSkillRoots(["/extra/root"]);
    for (const root of roots) {
      expect(root.endsWith(sep)).toBe(true);
    }
  });
});

describe("isSkillSourcePath", () => {
  test("returns true for path inside managed skills dir", () => {
    mkdirSync(MOCK_MANAGED_DIR, { recursive: true });
    const filePath = join(MOCK_MANAGED_DIR, "my-skill", "executor.ts");
    expect(isSkillSourcePath(filePath)).toBe(true);
  });

  test("returns true for path inside bundled skills dir", () => {
    mkdirSync(MOCK_BUNDLED_DIR, { recursive: true });
    const filePath = join(MOCK_BUNDLED_DIR, "web-search", "SKILL.md");
    expect(isSkillSourcePath(filePath)).toBe(true);
  });

  test("returns true for deeply nested path inside managed skills dir", () => {
    mkdirSync(MOCK_MANAGED_DIR, { recursive: true });
    const filePath = join(
      MOCK_MANAGED_DIR,
      "my-skill",
      "src",
      "lib",
      "helper.ts",
    );
    expect(isSkillSourcePath(filePath)).toBe(true);
  });

  test("returns false for path outside all skill dirs", () => {
    expect(isSkillSourcePath("/usr/local/bin/something")).toBe(false);
  });

  test("returns false for path that shares prefix but is not under skill dir", () => {
    // e.g. if managed dir is /tmp/.../workspace/skills, a path
    // like /tmp/.../workspace/skillsX/foo should not match
    mkdirSync(MOCK_MANAGED_DIR, { recursive: true });
    const sibling = MOCK_MANAGED_DIR + "X";
    expect(isSkillSourcePath(join(sibling, "foo.ts"))).toBe(false);
  });

  test("returns true for path inside extra roots", () => {
    const extraRoot = makeTempDir();
    const filePath = join(extraRoot, "project-skill", "SKILL.md");
    expect(isSkillSourcePath(filePath, [extraRoot])).toBe(true);
  });

  test("returns false for extra root itself (must be inside)", () => {
    const extraRoot = makeTempDir();
    // The root directory itself should not match — only children
    // normalizeDirPath adds trailing separator, so the root dir path
    // without the separator won't start with root + sep
    expect(isSkillSourcePath(extraRoot, [extraRoot])).toBe(false);
  });

  test("resolves symlinks when checking paths", () => {
    mkdirSync(MOCK_MANAGED_DIR, { recursive: true });
    const realDir = makeTempDir();
    const linkPath = join(MOCK_MANAGED_DIR, "linked-skill");
    // Don't create the symlink if the test directory cleanup removed it
    try {
      symlinkSync(realDir, linkPath);
    } catch {
      // Link may already exist from a prior run; ignore
    }
    testDirs.push(linkPath);

    // A file inside the symlinked skill should NOT match because realpath
    // resolves it to realDir which is outside the managed skills dir
    const filePath = join(linkPath, "executor.ts");
    // The symlink target (realDir) is outside MOCK_MANAGED_DIR, so this
    // should be false (symlink-safe detection)
    expect(isSkillSourcePath(filePath)).toBe(false);
  });

  test("handles normalized vs non-normalized paths", () => {
    mkdirSync(MOCK_MANAGED_DIR, { recursive: true });
    // Path with redundant dot segments that should normalize to managed dir
    const messyPath = join(
      MOCK_MANAGED_DIR,
      "my-skill",
      "..",
      "my-skill",
      "file.ts",
    );
    expect(isSkillSourcePath(messyPath)).toBe(true);
  });

  test("handles trailing slashes in paths", () => {
    mkdirSync(MOCK_MANAGED_DIR, { recursive: true });
    // A path with trailing slash (unusual for a file, but should not crash)
    const filePath = join(MOCK_MANAGED_DIR, "my-skill") + "/";
    expect(isSkillSourcePath(filePath)).toBe(true);
  });
});
