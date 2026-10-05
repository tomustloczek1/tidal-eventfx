#!/bin/bash
# install.sh - connect this repo to the places Live, Tidal and SuperCollider read from
#
#   scripts/install.sh            dry run: show what would happen (changes nothing)
#   scripts/install.sh --apply    do it
#   scripts/install.sh --check    only check that every link is in place
#
# The files live in the repo; the usual locations become symbolic links to them, so
# Live / Tidal / SuperCollider keep using their normal paths and every change lands in the repo.
#   - a location that exists but is not a link yet is MOVED into the repo first (adopt)
#   - if both exist (fresh clone on a machine with its own files), the newer file is kept in the
#     repo and the other one is backed up as <name>.backup-<date>; folders on the Mac are backed up
# Templates and rack presets are COPIED into Live's User Library (Live re-saves them in place);
# after saving them again in Live, run scripts/collect.sh to bring them back into the repo.
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd)"
ULIB="$HOME/Music/Ableton/User Library"
STAMP="$(date +%Y%m%d-%H%M%S)"
MODE="${1:-dry}"

# <location on this Mac>|<path in the repo>
LINKS=(
  "$HOME/.config/tidal|tidal"
  "$ULIB/Remote Scripts/EventFXHelper|live/EventFXHelper"
  "$ULIB/Presets/MIDI Effects/Max MIDI Effect/EventFX.amxd|live/devices/EventFX.amxd"
  "$ULIB/Presets/MIDI Effects/Max MIDI Effect/eventfx.js|live/devices/eventfx.js"
  "$ULIB/Presets/Audio Effects/Max Audio Effect/ChainWatch.amxd|live/devices/ChainWatch.amxd"
  "$ULIB/Presets/Audio Effects/Max Audio Effect/chainwatch.js|live/devices/chainwatch.js"
  "$HOME/Library/Application Support/SuperCollider/startup.scd|supercollider/startup.scd"
)

problems=0
say()   { printf '%-8s %s\n' "$1" "$2"; }
run()   { if [ "$MODE" = "--apply" ]; then "$@"; fi; }
mtime() { stat -f %m "$1" 2>/dev/null || echo 0; }

for entry in "${LINKS[@]}"; do
  loc="${entry%%|*}"
  rel="${entry#*|}"
  src="$REPO/$rel"
  short="${loc/#$HOME/~}"
  src_empty=0

  if [ -L "$loc" ]; then
    if [ "$(readlink "$loc")" = "$src" ]; then say "ok" "$short"; continue; fi
    say "RELINK" "$short -> repo/$rel (pointed to $(readlink "$loc"))"
    [ "$MODE" = "--check" ] && { problems=1; continue; }
    run rm "$loc"; run ln -s "$src" "$loc"; continue
  fi

  # an empty folder in the repo counts as missing (git does not keep empty folders anyway)
  if [ -d "$src" ] && [ -z "$(ls -A "$src")" ]; then run rmdir "$src"; [ "$MODE" = "--apply" ] || src_empty=1; fi

  if [ "$MODE" = "--check" ]; then
    if [ -e "$loc" ]; then say "NOLINK" "$short is a real file/folder (a program may have saved over the link) - run install.sh --apply"
    else say "MISSING" "$short"; fi
    problems=1; continue
  fi

  if [ -e "$loc" ] && { [ ! -e "$src" ] || [ "${src_empty:-0}" = 1 ]; }; then
    say "ADOPT" "$short -> moved into repo/$rel, then linked"
    run mkdir -p "$(dirname "$src")"; run mv "$loc" "$src"; run ln -s "$src" "$loc"
  elif [ -e "$loc" ] && [ -e "$src" ]; then
    if [ ! -d "$loc" ] && [ "$(mtime "$loc")" -gt "$(mtime "$src")" ]; then
      say "NEWER" "$short is newer: repo copy -> $rel.backup-$STAMP, $short moved in, linked"
      run mv "$src" "$src.backup-$STAMP"; run mv "$loc" "$src"; run ln -s "$src" "$loc"
    else
      say "BACKUP" "$short -> $short.backup-$STAMP, linked to repo/$rel"
      run mv "$loc" "$loc.backup-$STAMP"; run ln -s "$src" "$loc"
    fi
  elif [ -e "$src" ]; then
    say "LINK" "$short -> repo/$rel"
    run mkdir -p "$(dirname "$loc")"; run ln -s "$src" "$loc"
  else
    say "MISSING" "neither $short nor repo/$rel exists"; problems=1
  fi
done

# templates and rack presets: copied into the User Library
for f in "$REPO"/live/templates/*.als "$REPO"/live/presets/*.adg; do
  [ -e "$f" ] || continue
  case "$f" in *.als) dest="$ULIB/Templates";; *) dest="$ULIB/Presets/Instruments/Instrument Rack";; esac
  name="$(basename "$f")"
  if [ -e "$dest/$name" ] && cmp -s "$f" "$dest/$name"; then say "ok" "${dest/#$HOME/~}/$name (copy)"; continue; fi
  if [ "$MODE" = "--check" ]; then say "DIFFERS" "${dest/#$HOME/~}/$name - run scripts/collect.sh (or install.sh --apply)"; continue; fi
  say "COPY" "repo/${f#$REPO/} -> ${dest/#$HOME/~}/"
  run mkdir -p "$dest"; run cp "$f" "$dest/"
done

echo
case "$MODE" in
  --apply) echo "done. Restart Live if it is running (Remote Scripts load at start).";;
  --check) [ $problems = 0 ] && echo "all links in place" || echo "some links need attention";;
  *)       echo "dry run - nothing changed. Run with --apply to do it.";;
esac
exit $problems
