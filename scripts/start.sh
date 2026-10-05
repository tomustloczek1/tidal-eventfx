#!/bin/bash
# start.sh - start SuperCollider (SuperDirt) in a tmux session
set -e

pkill -f sclang 2>/dev/null || true
pkill -f scsynth 2>/dev/null || true
sleep 1
tmux kill-session -t sc 2>/dev/null || true
tmux new-session -d -s sc 'sclang'

echo "sclang started - wait for '==== SuperDirt ready ====' (tmux attach -t sc)"
echo "then in Tidal: :script ~/.config/tidal/toolz.tidal, :script ~/.config/tidal/toolz-fx.tidal, bpm <tempo>"
