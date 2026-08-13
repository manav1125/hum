# Runbook — dropping the daemon out of root

Status: **rehearsed 2026-08-13 on a scratch machine against a fork of the prod
volume. Two defects found and fixed (`e275df39fe`). One BLOCKER remains before
the flag can be enabled on prod — see below.** Code: `78c735a92c` + `e275df39fe`.

## Rehearsal outcome

Passed: daemon boots and serves as uid 1001 (healthz 200, socket owned by it);
workspace writes, DB dir, skills read, bun, /tmp all fine; security dir denied
for read *and* list; `sudo` denied; `apt-get install` and writes to `/app`
blocked as intended. A `setpriv`'d process is non-dumpable, so its `/proc`
entries stay root-owned — a same-uid shell cannot read the daemon's own
environment either.

Fixed as a result:
1. **HOME** — `setpriv` changes credentials, not the environment. The daemon
   inherited root's HOME and died on boot (`mkdir /root/.vellum` → EACCES).
   Enabling the flag without this would have been a prod outage.
2. **The lock** — dropping the uid while the key sat at its inherited 0644 left
   it readable. The entrypoint now locks the directory root 0700/0600 before
   the daemon starts.

### BLOCKER — untrack the security files first

Prod's workspace git repo *tracks* `gateway-security/actor-token-signing-key`,
`backup.key` and `feature-flags.json`. `.gitignore` has the rule but does not
untrack already-committed files. Once the directory is locked, every git
operation errors with `Permission denied` on those three paths.

Fix before enabling the flag, run **as the workspace owner** (not root):

```
git rm --cached gateway-security/actor-token-signing-key \
                gateway-security/backup.key \
                gateway-security/feature-flags.json
```

Verified on the fork: after this, `git status` reports zero security-dir errors.

Note this is also a finding in its own right — the auth root and backup key are
committed into a git repo, so they are in its history, not just its index.

### Also noted, not caused by this change

- **Prod's workspace git repo is corrupt**: `refs/heads/main` and HEAD point at
  empty objects (`git fsck` shows several). Consistent with the 2026-07-24
  disk-full P0. Workspace-git-backed features silently return empty because of
  it — that is why `/v1/skills/{id}/history` returns `revisions: []`.
- **After the chown, root cannot run git in the workspace** ("dubious
  ownership"). Any root-run ops tooling or backup script that shells out to git
  needs `git config --global --add safe.directory /workspace` or to run as the
  workspace uid.

## What the flag does

`CUE_DROP_DAEMON_PRIVILEGES=1` makes the combined entrypoint hand the workspace
to uid 1001 and launch the daemon under `setpriv`, so every command the agent
runs — all six shell paths — is unprivileged. The gateway stays root and keeps
sole access to `$GATEWAY_SECURITY_DIR`.

Unset (the default, and what prod runs today) is the previous behaviour exactly.

## Why it can't be skipped in favour of file permissions

At uid 0 the trust material is reachable through `/proc/<gateway-pid>/mem`,
`/proc/<gateway-pid>/fd/*`, and the raw volume, regardless of file modes. The
boundary is the shell's privilege, not the file's path. The file-level work
(modes, env stripping, command-text denials) narrows the obvious routes and is
documented in-code as a speed bump, not a boundary.

## Rehearsal (do this before enabling on prod)

Prereq: `flyctl auth login` — the token expired 2026-08-13.

1. **Clone the volume.** `flyctl volumes list -a cue-manav-prod`, then fork the
   prod volume so the rehearsal cannot touch real data. Never point the scratch
   machine at `vol_40opk6qww21o3yp4` itself.
2. **Build the image** from a detached worktree at the ship commit
   (`cd /Users/manavgupta/cue-ship && flyctl deploy . --config fly-release.toml
   --build-only --push --depot`).
3. **Boot a scratch machine** on the forked volume with the same env as prod
   plus `CUE_DROP_DAEMON_PRIVILEGES=1`.
4. **Confirm the drop actually happened** — this is the step that proves the
   control rather than assuming it:
   - `ps -o uid,cmd -p <daemon-pid>` shows uid 1001, gateway shows 0.
   - From a chat turn: `id -u` returns 1001.
   - From a chat turn: reading `$GATEWAY_SECURITY_DIR/actor-token-signing-key`
     is denied. **This failing to be denied means the rehearsal failed** —
     do not proceed.
   - `sudo -n true` fails (the sudoers entry is gone).
5. **Exercise the skill surface** — the point of the rehearsal is to find what
   breaks, so drive the paths that touch the filesystem and spawn processes:
   - a scheduled job firing end to end
   - a skill that shells out (workspace git, document/media generation)
   - voice (both engines), since it writes audio scratch files
   - a connector call, a memory consolidation run, an attachment upload
   - the desktop app against the scratch machine, if convenient
6. **Watch for the expected failure shapes**: `EACCES`/permission denied in
   daemon logs, a skill that used to `apt-get install`, or anything writing
   outside `/workspace`.

## Cutting prod over

Only after the rehearsal is clean:

```
flyctl machine update 48eed1ef1411e8 -a cue-manav-prod --env CUE_DROP_DAEMON_PRIVILEGES=1 --yes
```

Rollback is the same command without the var (or `=0`). No image rebuild, no
redeploy — that is the reason the change is env-gated.

**First boot after enabling is slower**: the entrypoint walks the workspace to
fix ownership. Later boots only touch files that are not already owned.

## What stays broken on purpose

Agent-initiated `apt-get install` and writes outside the workspace fail once the
flag is on. That is the trade: adding a system package becomes a deliberate
image change instead of something a runtime command grants itself. If a skill
genuinely needs a package, add it to `assistant/Dockerfile`.

## Not covered by this change

The agent keeps every power it is supposed to have — sending through
connectors, writing workspace files, spending API credit. This is containment of
credential theft and system-level persistence, not a cage.
