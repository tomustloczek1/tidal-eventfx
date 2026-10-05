#!/bin/bash
# collect.sh - bring templates and rack presets saved in Live back into the repo
#
# Live always saves templates to "User Library/Templates" and rack presets under
# "User Library/Presets"; those are copies, not links. Run this after saving one again.
# Collected: Templates/tidal*.als and rack presets named "tidal*.adg".
set -u
REPO="$(cd "$(dirname "$0")/.." && pwd)"
ULIB="$HOME/Music/Ableton/User Library"
mkdir -p "$REPO/live/templates" "$REPO/live/presets"

n=0
for f in "$ULIB"/Templates/tidal*.als; do
  [ -e "$f" ] || continue
  if ! cmp -s "$f" "$REPO/live/templates/$(basename "$f")"; then
    cp "$f" "$REPO/live/templates/" && { echo "template: $(basename "$f")"; n=$((n+1)); }
  fi
done
while IFS= read -r f; do
  if ! cmp -s "$f" "$REPO/live/presets/$(basename "$f")"; then
    cp "$f" "$REPO/live/presets/" && { echo "preset:   $(basename "$f")"; n=$((n+1)); }
  fi
done < <(find "$ULIB/Presets" -name "tidal*.adg" 2>/dev/null)
echo "$n file(s) updated in the repo - check with: git status"
