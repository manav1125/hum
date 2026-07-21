---
name: desktop-organizer
description: Tidy a cluttered Mac folder (usually the Desktop) by sorting its items into dated, categorized archive folders — WITHOUT ever deleting anything. Every move is recorded and reversible with one command. Use when the user says "organize my desktop", "clean up this folder", "sort my downloads", or drops a folder and asks to tidy it.
compatibility: "Designed for Cue personal assistants"
metadata:
  emoji: "🧹"
  vellum:
    display-name: "Desktop Organizer"
    category: "system"
    feature-flag: "desktop-organizer"
    activation-hints:
      - "User asks to organize, tidy, clean up, or sort a folder on their Mac (Desktop, Downloads, a dropped folder)"
      - "User complains their desktop/folder is a mess and wants it sorted"
      - "User drops a folder into chat and asks Cue to organize its contents"
    avoid-when:
      - "User wants files DELETED or permanently removed — this skill never deletes; say so and stop"
      - "The target isn't a real folder on the connected Mac (no desktop host connected)"
---

Organize a cluttered folder on the user's Mac by sorting its top-level items into
a dated, categorized **archive** — and do it safely. This is a **MOVE-NEVER-DELETE**
skill: nothing is ever deleted, every move is written to a manifest, and one
command puts everything back.

This runs on the connected Mac via the **`host_bash`** tool (commands execute on
the user's machine, not the daemon sandbox). It requires a desktop host — if
`host_bash` isn't available, tell the user to open the Cue desktop app and stop.

## The flow — plan first, always

1. **Inventory (read-only).** Run the bundled script in `plan` mode. It lists
   every movable top-level item, its category, and its size. It mutates NOTHING.
2. **Show the plan.** Summarize for the user: how many items, which categories,
   the total size, and the exact archive path they'll move into. This is the
   review-before-move moment — present it as a plan card, not a fait accompli.
3. **Get consent (the contract).** State plainly, before any move:
   - the exact source folder (e.g. `~/Desktop`),
   - the exact destination (e.g. `~/Desktop/Cue Archive/2026-07-21/`),
   - the total size and item count that will move,
   - that **nothing is deleted** — items are moved and fully reversible.
   Then ask to proceed. The user's directory-scoped trust rule ("Always allow in
   `~/Desktop`") can pre-authorize this so the demo runs unattended — but the
   plan is always shown first.
4. **Apply.** Run the script in `apply` mode. It creates the archive, moves each
   item into `archive/<Category>/`, writes `moves.tsv` (the manifest), and
   writes `cue-undo.sh`.
5. **Report + offer undo.** Tell the user what moved and where, and that
   `bash "<archive>/cue-undo.sh"` restores everything instantly.

## Safety contract (non-negotiable)

- **Never delete.** Only `mv`. If the user asks to delete, refuse and explain
  this skill only archives.
- **Protected paths are refused by the script itself** (belt-and-suspenders — do
  not try to override them): dotfiles/dot-directories, `*.app` bundles,
  symlinks, the archive tree itself, and anything not sitting directly inside the
  approved root. The script never touches `~/Library`, never recurses outside the
  root, and never operates on a path outside the folder the user approved.
- **One approved root per run.** Default `~/Desktop`. Only organize another
  folder (e.g. `~/Downloads` or a dropped folder) when the user names it.
- **Collisions never clobber.** If a name already exists in the destination the
  script suffixes ` (1)`, ` (2)`, … so nothing is overwritten.

## Running it

Write the canonical script to the host once, then call it. Use a heredoc through
`host_bash` (the script text below is the source of truth — reproduce it exactly):

```bash
# 1. stage the script on the host
mkdir -p "$HOME/.cue/desktop-organizer"
cat > "$HOME/.cue/desktop-organizer/cue-organize.sh" <<'CUE_ORGANIZE_SH'
# >>> BEGIN cue-organize.sh (canonical: scripts/cue-organize.sh) >>>
#!/usr/bin/env bash
#
# cue-organize.sh — the desktop-organizer's MOVE-NEVER-DELETE engine.
#
# Two modes:
#   plan   — read-only. Inventory the top level of ROOT, categorize every
#            movable item, and print a TSV plan (category<TAB>name<TAB>bytes)
#            plus a totals summary. Mutates NOTHING.
#   apply  — create ARCHIVE/<category>/ folders and `mv` each planned item
#            there. Records every move in ARCHIVE/moves.tsv and writes
#            ARCHIVE/cue-undo.sh (one command puts everything back).
#
# This script NEVER deletes. It only moves, and every move is reversible from
# the manifest. Protected paths are refused up front (see is_protected).
#
# Usage:
#   cue-organize.sh plan   --root DIR [--archive DIR]
#   cue-organize.sh apply  --root DIR [--archive DIR]
#
# Defaults: --root ~/Desktop, --archive ROOT/Cue Archive/<YYYY-MM-DD>
#
set -euo pipefail

MODE="${1:-}"; shift || true

ROOT="$HOME/Desktop"
ARCHIVE=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --root)    ROOT="$2"; shift 2 ;;
    --archive) ARCHIVE="$2"; shift 2 ;;
    *) echo "cue-organize: unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [ "$MODE" != "plan" ] && [ "$MODE" != "apply" ]; then
  echo "cue-organize: first arg must be 'plan' or 'apply'" >&2
  exit 2
fi

# Resolve ROOT to an absolute, real path.
if [ ! -d "$ROOT" ]; then
  echo "cue-organize: root is not a directory: $ROOT" >&2
  exit 2
fi
ROOT="$(cd "$ROOT" && pwd -P)"

# The archive lives under ROOT by default, dated so repeated runs never collide.
if [ -z "$ARCHIVE" ]; then
  ARCHIVE="$ROOT/Cue Archive/$(date +%Y-%m-%d)"
fi

# --- Protected-path denylist ------------------------------------------------
# Refuse to move anything that is not a plain, user-facing item sitting
# directly inside ROOT. This is the safety core — it runs on every candidate.
is_protected() {
  local name="$1" path="$2"
  # Dotfiles / dot-directories (configs, caches, ~/.ssh-style material).
  case "$name" in .*) return 0 ;; esac
  # Tabs or newlines in the name would corrupt the TSV manifest / undo.
  case "$name" in *$'\t'*|*$'\n'*) return 0 ;; esac
  # App bundles — moving these breaks Launch Services registrations.
  case "$name" in *.app) return 0 ;; esac
  # The archive tree itself (never fold the archive into itself).
  case "$path" in "$ARCHIVE"|"$ARCHIVE"/*) return 0 ;; esac
  case "$name" in "Cue Archive") return 0 ;; esac
  # Symlinks — resolving/moving them is a footgun; leave them in place.
  if [ -L "$path" ]; then return 0; fi
  # Must live DIRECTLY under ROOT and nowhere else.
  case "$path" in
    "$ROOT"/*) : ;;
    *) return 0 ;;
  esac
  local parent; parent="$(cd "$(dirname "$path")" && pwd -P)"
  [ "$parent" = "$ROOT" ] || return 0
  return 1
}

# --- Categorization ---------------------------------------------------------
categorize() {
  local name="$1" path="$2"
  local lower="${name##*/}"; lower="$(printf '%s' "$lower" | tr '[:upper:]' '[:lower:]')"
  # Screenshots first (they are images but deserve their own shelf).
  case "$lower" in
    screenshot*|"screen shot"*|*"cleanshot"*) echo "Screenshots"; return ;;
  esac
  if [ -d "$path" ]; then echo "Folders"; return; fi
  case "$lower" in
    *.jpg|*.jpeg|*.png|*.gif|*.heic|*.webp|*.bmp|*.tiff|*.svg) echo "Images" ;;
    *.pdf|*.doc|*.docx|*.txt|*.md|*.rtf|*.pages|*.key|*.numbers|*.xls|*.xlsx|*.ppt|*.pptx|*.csv) echo "Documents" ;;
    *.zip|*.tar|*.gz|*.tgz|*.rar|*.7z|*.dmg|*.pkg) echo "Archives" ;;
    *.mp4|*.mov|*.avi|*.mkv|*.mp3|*.wav|*.m4a|*.aiff|*.aac) echo "Media" ;;
    *.js|*.ts|*.tsx|*.py|*.rb|*.go|*.rs|*.c|*.cpp|*.h|*.swift|*.json|*.yaml|*.yml|*.sh) echo "Code" ;;
    *) echo "Other" ;;
  esac
}

size_bytes() {
  # Total bytes; works for files and directories. Portable-ish.
  du -sk "$1" 2>/dev/null | awk '{print $1 * 1024}' || echo 0
}

# --- Walk the top level -----------------------------------------------------
# Collect movable candidates (null-safe against spaces).
collect() {
  # `find -maxdepth 1` lists ROOT's direct children only.
  find "$ROOT" -mindepth 1 -maxdepth 1 -print0
}

if [ "$MODE" = "plan" ]; then
  total=0
  count=0
  # Emit a header comment; the rows are machine-parseable TSV.
  echo "# cue-organize plan"
  echo "# root: $ROOT"
  echo "# archive (on apply): $ARCHIVE"
  echo "# category	name	bytes"
  while IFS= read -r -d '' path; do
    name="${path##*/}"
    if is_protected "$name" "$path"; then continue; fi
    cat="$(categorize "$name" "$path")"
    bytes="$(size_bytes "$path")"
    printf '%s\t%s\t%s\n' "$cat" "$name" "$bytes"
    total=$((total + bytes))
    count=$((count + 1))
  done < <(collect)
  echo "# ---"
  echo "# movable items: $count"
  echo "# total bytes: $total"
  exit 0
fi

# --- apply ------------------------------------------------------------------
mkdir -p "$ARCHIVE"
MANIFEST="$ARCHIVE/moves.tsv"
UNDO="$ARCHIVE/cue-undo.sh"

# Fresh manifest header (append-safe if re-run into the same archive).
if [ ! -f "$MANIFEST" ]; then
  printf '# src\tdst\n' > "$MANIFEST"
fi

moved=0
while IFS= read -r -d '' path; do
  name="${path##*/}"
  if is_protected "$name" "$path"; then continue; fi
  cat="$(categorize "$name" "$path")"
  destdir="$ARCHIVE/$cat"
  mkdir -p "$destdir"
  dest="$destdir/$name"
  # Never clobber: if the target exists, suffix until free.
  if [ -e "$dest" ]; then
    base="$name"; ext=""
    case "$name" in *.*) ext=".${name##*.}"; base="${name%.*}" ;; esac
    n=1
    while [ -e "$destdir/$base ($n)$ext" ]; do n=$((n + 1)); done
    dest="$destdir/$base ($n)$ext"
  fi
  # THE move. -n = no-clobber belt to the check above.
  mv -n "$path" "$dest"
  printf '%s\t%s\n' "$path" "$dest" >> "$MANIFEST"
  moved=$((moved + 1))
done < <(collect)

# Generate the one-command undo. It reads the manifest and moves each item back
# to exactly where it came from. It, too, only moves — never deletes.
cat > "$UNDO" <<'UNDO_EOF'
#!/usr/bin/env bash
# cue-undo.sh — put every archived item back where it was. Move-only, no deletes.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd -P)"
manifest="$here/moves.tsv"
[ -f "$manifest" ] || { echo "no manifest at $manifest" >&2; exit 1; }
# Read every move into arrays, then unwind in reverse (nested moves undo cleanly)
# — all in memory, so undo never creates or removes a file of its own.
srcs=(); dsts=()
while IFS=$'\t' read -r src dst; do
  case "$src" in \#*|"") continue ;; esac
  srcs+=("$src"); dsts+=("$dst")
done < "$manifest"
restored=0
for (( i=${#srcs[@]}-1; i>=0; i-- )); do
  src="${srcs[$i]}"; dst="${dsts[$i]}"
  [ -e "$dst" ] || { echo "skip (missing): $dst" >&2; continue; }
  mkdir -p "$(dirname "$src")"
  mv -n "$dst" "$src"
  restored=$((restored + 1))
done
echo "cue-undo: restored $restored item(s)."
UNDO_EOF
chmod +x "$UNDO"

echo "cue-organize: moved $moved item(s) into $ARCHIVE"
echo "manifest: $MANIFEST"
echo "undo: bash \"$UNDO\""
# <<< END cue-organize.sh <<<
CUE_ORGANIZE_SH
chmod +x "$HOME/.cue/desktop-organizer/cue-organize.sh"

# 2. plan (read-only) — show the user the result before moving anything
bash "$HOME/.cue/desktop-organizer/cue-organize.sh" plan --root "$HOME/Desktop"

# 3. apply — only after the user consents
bash "$HOME/.cue/desktop-organizer/cue-organize.sh" apply --root "$HOME/Desktop"

# 4. undo, any time
# bash "$HOME/Desktop/Cue Archive/<date>/cue-undo.sh"
```

For a dropped folder, pass its absolute path as `--root` (the folder-drop
attachment gives you the native path directly).

## Anti-patterns

- Do NOT run raw `mv`/`rm` yourself — always go through the script so the
  denylist, manifest, and undo are guaranteed.
- Do NOT skip the plan step. Plan-first is the whole UX.
- Do NOT organize `~` (the home folder), `~/Library`, or system paths — only a
  user content folder the user named.
- Do NOT claim something was deleted or freed from disk — items are moved, still
  on disk, and reversible.
