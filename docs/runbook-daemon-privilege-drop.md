# Runbook — dropping the daemon out of root

Status: **rehearsed twice. The 2026-08-13 prod enable was rolled back inside 30
minutes; the cause is found, fixed and proven, and a second same-class outage
was found and fixed in the same pass. Both fixes verified on a real
gateway+daemon boot against a fork of the prod volume.**

Code: `78c735a92c` + `e275df39fe` + `9245392c1e` (the drop itself), then
`f6f22e91ae` (the IPC socket) and `HEAD` (the key-seeding identity).

The flag is **still off on prod** (`CUE_DROP_DAEMON_PRIVILEGES=0`). Re-enabling
is a deliberate decision — see "Cutting prod over".

---

## The prod incident, and what actually caused it

Symptom: every tool call failed with *"The safety-check service was briefly
unavailable"* (`assistant/src/permissions/checker.ts:486`, thrown when
`ipcClassifyRisk` returns falsy).

Cause: **the daemon could not reach the gateway at all.** The gateway binds
`/workspace/gateway.sock` as root, and node creates it `0777 & ~umask` —
`srwxr-xr-x` under root's usual 022. `connect(2)` on an AF_UNIX socket requires
**write** permission on the path entry, so the moment the daemon moved to uid
1001 it had `r-x` and every daemon→gateway RPC failed with EACCES. Risk
classification, autonomy policy reads and capability-token verification all ride
that one socket, so the assistant failed closed on *everything*.

Nothing was wrong with the privilege drop. The daemon simply lost its only route
to the gateway, and the first rehearsal could not have seen it because **it ran
the daemon without a gateway beside it.**

Confirmed by controlled experiment inside the container (root-owned listener,
connected to from uid 1001):

```
mode=755 owner=0:0    -> errno 13 Permission denied
mode=660 owner=0:1001 -> connected
```

> **Diagnostic trap:** Bun surfaces this as `ENOENT`, not `EACCES`, on
> `createConnection`. The socket is right there on disk and the error says the
> file is missing. Do not chase a missing-socket theory — stat the mode.

### The fix

The gateway chgrps its socket to `GATEWAY_IPC_SOCKET_GID` and chmods it `0660`;
the entrypoint exports that gid (`= CUE_DAEMON_GID`) when it drops privileges.
`setpriv` already runs the daemon with `--regid=1001 --clear-groups`, so gid
1001 — the image's `assistant` group — is exactly and only the daemon's group.
No new identity, no membership to maintain.

`0660` + a named gid rather than `0666`: today every process in the namespace is
either root or the daemon, so `0666` would work — but the daemon is the process
that runs agent-authored shell commands, and this socket is where trust material
is minted and verified. "Nothing untrusted shares the namespace" is a claim that
has to *keep* being true in an image that already grows helper users. Naming one
gid costs nothing and does not need re-deciding later.

Applied on the initial `listen()` **and** in the watchdog's `onRebind` — a
rebind recreates the path entry with default ownership and would otherwise lock
the daemon out again, later and rarer.

With the env var unset nothing is chowned or chmodded, so every other
deployment is byte-for-byte unchanged.

---

## The second bug, found in the same pass — provider keys went to the wrong store

This one had not fired yet only because the socket bug masked it. It would have
been the next incident.

The secure store path is **HOME-derived**: `vellumRoot()`
(`assistant/src/util/platform.ts`) takes the parent of `VELLUM_WORKSPACE_DIR`,
and for `/workspace` that parent is `/`, so it falls back to `$HOME/.vellum`.

| process | HOME | store |
|---|---|---|
| daemon (setpriv sets `HOME=/home/assistant`) | `/home/assistant` | `/home/assistant/.vellum/protected` |
| the entrypoint's `keys set` seeding (root) | `/root` | `/root/.vellum/protected` |

Pre-flag both were `/root/.vellum/protected`, so this worked. With the flag on
they diverge — and the entrypoint **logs success anyway**, because when the
daemon's IPC is not accepting yet the CLI falls back to writing the store
in-process (`src/cli/lib/daemon-credential-client.ts`, `isDaemonUnreachable`).

Measured on the rehearsal machine, flag on, before the fix:

```
keys visible to root     : anthropic apify openrouter replicate
keys visible to uid 1001 : (nothing)
```

…while the log said `anthropic key seeded from env into secure store` for all
four. That is a total inference outage presenting as "No API key configured for
anthropic" / "credential not found", with a success line in the boot log.

**Fix:** all three seeding blocks now run under `$DAEMON_PRIVILEGE_PREFIX`, i.e.
as the same identity as the daemon. Flag off, the prefix is empty and nothing
changes. After the fix, on a cleared store: all four keys visible to uid 1001,
`/root/.vellum/protected` never created.

---

## Rehearsal method — **both processes, or it proves nothing**

The first rehearsal ran the daemon alone. That is precisely why a
daemon→gateway socket bug reached prod. **A rehearsal without the gateway
running beside the daemon is not a rehearsal.**

The other constraint is that a second machine in `cue-manav-prod` must never
take live traffic or run schedules against real data. The recipe below satisfies
both. Prereq: `flyctl auth login`.

1. **Fork the prod volume** so nothing touches real data:
   ```
   flyctl volumes fork vol_40opk6qww21o3yp4 -a cue-manav-prod --name workspace_rehearsal2
   ```

2. **Create the scratch machine with NO SERVICES.** Do *not* `flyctl machine
   clone` and then race to disable it — clone copies prod's `services` block
   (internal port 10000 behind 443/80) and the machine can take traffic in the
   window before you neuter it. `machine run` without any `--port` produces a
   machine with `services: None`, which can never be routed to:
   ```
   flyctl machine run <prod-image-digest> -a cue-manav-prod \
     --name cue-privdrop-rehearsal --region iad \
     --volume <forked-vol-id>:/workspace \
     --vm-cpu-kind shared --vm-cpus 4 --vm-memory 4096 \
     --restart no \
     --entrypoint "/bin/sh -c 'sleep infinity'"
   ```
   The inert entrypoint means nothing starts until you say so. Verify before
   going further: `flyctl machine status <id> --display-config` must show
   `"services": None`.

3. **Run the real combined entrypoint by hand, with both processes.** Put prod's
   env (plus `CUE_DROP_DAEMON_PRIVILEGES=1`) in a file and source it, and
   detach so the SSH session ending does not kill it:
   ```
   nohup setsid sh -c ". /tmp/rehearsal-env.sh; exec /app/assistant/docker-cue-app-entrypoint.sh" \
     >/tmp/entry.log 2>&1 </dev/null &
   ```
   Then confirm **both** are up and at the right uids:
   ```
   ps -eo pid,uid,args | grep "bun --smol run"
   #  <pid> 1001 bun --smol run src/daemon/main.ts   <- daemon, dropped
   #  <pid>    0 bun --smol run src/index.ts         <- gateway, root
   ```

4. **Check prod is unaffected** throughout:
   `curl -s -o /dev/null -w "%{http_code}" https://manav.justcue.app/healthz`
   repeatedly. It must stay 200.

5. **Prove the IPC round trip**, which is the check that would have caught the
   incident. The socket must read `srw-rw---- root assistant`, and the gateway
   must log `IPC socket group-shared with the daemon`. Then drive the daemon's
   *own* checker as uid 1001 — not a hand-rolled client — because that is the
   function that threw:
   ```
   setpriv --reuid=1001 --regid=1001 --clear-groups --inh-caps=-all \
     env HOME=/home/assistant VELLUM_WORKSPACE_DIR=/workspace \
     bun -e 'import {classifyRisk} from "/app/assistant/src/permissions/checker.js";
             console.log(await classifyRisk("bash",{command:"rm -rf /workspace/data"},"/workspace"))'
   ```
   Expect a real classification (`level=high`, "Recursive force delete").
   **Run the negative control too** — `chmod 0755` + `chown root:root` the
   socket and confirm you get the verbatim prod error back. If you cannot
   reproduce the failure, you are not testing what you think you are.

6. **Check the provider keys resolve for the daemon's identity**, not root's:
   ```
   setpriv --reuid=1001 ... env HOME=/home/assistant bun run src/index.ts keys list
   ```
   All configured providers must appear. `/root/.vellum/protected` must **not**
   exist.

7. **Re-run the security checks.** From uid 1001, all of these must be denied:
   `gateway-security/actor-token-signing-key`, `backup.key`, `gateway.sqlite`,
   listing `gateway-security/`, the gateway's `/proc/<pid>/environ` and
   `/proc/<pid>/fd`, and `sudo -n true`. Workspace writes and `git` (as both
   1001 and root) must work.

8. **Sweep for anything else**: `grep -aiE "EACCES|permission denied|EPERM"` over
   the boot log, and `find /workspace -maxdepth 3 -user 0` — the only root-owned
   entry should be `gateway.sock` itself.

9. **Destroy both** when done — never leave a second machine in the prod app:
   ```
   flyctl machine destroy <id> --force
   flyctl volumes destroy <vol> -a cue-manav-prod --yes
   ```

### Results, 2026-08-13 (second rehearsal, both processes)

Everything in steps 5–8 passed. Zero `EACCES`/permission-denied lines in the
boot log. The only root-owned object under `/workspace` was `gateway.sock`
(`root:assistant 0660`, intended). All four provider keys resolved for uid 1001.
Negative control reproduced the prod error verbatim on all three tool shapes.

The previously-recorded **BLOCKER is resolved**: the workspace git repo no
longer tracks the `gateway-security` files (`git ls-files gateway-security`
returns nothing), and `git status` as both uids reports zero permission errors.

---

## Known consequences, and what is still worth fixing

**By design** (already the accepted trade): agent-initiated `apt-get install`
and writes outside the workspace fail. Adding a package becomes an image change
rather than something a runtime command grants itself.

**Fixed since the rehearsal:**

- ~~`$WORKSPACE/config.json`~~ — **fixed in `c7fc035490`.** The gateway rewrote
  it atomically (`gateway/src/config-file-utils.ts` `writeConfigFileAtomic`:
  root-owned tmp file + rename), which **replaced** the 1001-owned file with a
  root-owned one. The daemon writes the same file in place
  (`assistant/src/config/loader.ts` `saveRawConfig`), so after one gateway-side
  config mutation (a privacy-settings save, or velay) daemon config writes
  started failing. Several callers swallow the error, so it degraded into
  "settings don't stick" rather than a crash. `writeConfigFileAtomic` now stats
  the target and carries its uid/gid — and its mode — onto the tmp file before
  the rename. No-op when the target is absent or already matches (i.e. every
  same-uid deployment), and a failing chown logs at warn and still completes
  the write. Regression cover:
  `gateway/src/__tests__/config-file-atomic-ownership.test.ts`.

**Verified latent, not blocking** — these did not fire because the paths already
exist on prod's volume and are owned by 1001, but they would bite a fresh
workspace or a later gateway write:

- `$WORKSPACE/data/credentials/` and `$WORKSPACE/data/avatar/` — both created by
  the gateway (`credential-watcher.ts`, `avatar-sync-watcher.ts`) and written by
  the daemon. `ensureDataDir()` does not pre-create either, so on a workspace
  where they are absent the gateway wins the race and creates them root-owned.
- Scheduled scripts and a few route-spawned tools run with `cwd=/app/assistant`
  (`scheduler.ts` `workingDir: process.cwd()`), which is root-owned 0755 and
  **confirmed not writable by uid 1001**. Anything writing a relative path from
  a scheduled job now fails. Worth a scheduled-job smoke test on the next
  enable.
- The hatch/StatefulSet topology (`cli/src/lib/statefulset.ts`) does not set
  `GATEWAY_IPC_SOCKET_GID`. Both containers are root there today so it works,
  but if that daemon container is ever given `user: "1001"` it reproduces the
  exact outage this runbook is about, with no fix wired.

---

## Why this can't be done with file permissions instead

At uid 0 the trust material is reachable through `/proc/<gateway-pid>/mem`,
`/proc/<gateway-pid>/fd/*` and the raw volume regardless of file modes. The
boundary is the shell's privilege, not the file's path. The file-level work
(modes, env stripping, command-text denials) narrows the obvious routes and is
documented in-code as a speed bump, not a boundary.

A `setpriv`'d process is non-dumpable, so its `/proc` entries stay root-owned —
verified: uid 1001 cannot read the gateway's environ or fds.

## Cutting prod over

The image prod runs must contain `f6f22e91ae`, `c7fc035490` (the config.json
ownership fix above) and the key-seeding commit. The
rehearsal proved the *code* by patching both files into a scratch container at
the exact committed bytes (sha256-verified); it did not ship an image. So:
build and deploy a release off this branch line first — per the deploy lineage
rule, prod ships from `cue/voice-replatform`, and a wave-c-only image silently
un-ships voice.

Then, and only then:

```
flyctl machine update 48eed1ef1411e8 -a cue-manav-prod --env CUE_DROP_DAEMON_PRIVILEGES=1 --yes
```

Rollback is the same command with `=0`. No image rebuild, no redeploy — that is
the reason the change is env-gated.

**First boot after enabling is slower**: the entrypoint walks the workspace to
fix ownership. Later boots only touch files that are not already owned.

Watch on the first boot: the gateway's `IPC socket group-shared with the daemon`
line, `keys list` under the daemon's identity, and one real tool call.

## Not covered by this change

The agent keeps every power it is supposed to have — sending through connectors,
writing workspace files, spending API credit. This is containment of credential
theft and system-level persistence, not a cage.
