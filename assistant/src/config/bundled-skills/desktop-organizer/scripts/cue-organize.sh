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
