# Tuning and limits

## Timing values

| value | where | current | meaning |
|---|---|---|---|
| `ccLead` | `tidal/toolz.tidal` | 0.15 s | how early the effect values are sent before their note. They go into the note's own (silent) chain, so more is safe |
| `selLead` | `tidal/toolz.tidal` | 0.026 s | how early the Chain Selector is moved. Live applies the move 0-30 ms later; best 0.02-0.03 |
| `midiLatency` | `tidal/toolz.tidal` | 0.038 s | MIDI vs. SuperDirt audio (BlackHole) |
| `maxChain` / `maxTrack` | `tidal/fx-rules.json` | 4 / 2 | parameters per device exposed to Tidal |

After changing a lead: reload `toolz.tidal`, then run `bpm <tempo>` (the shifts are computed there).
Live, without reloading: `setF "selShift" (0.03 * 140 / 240)`.

## Diagnostics

Set `DEBUG_LOAD = true` in `live/devices/eventfx.js` and click `reload`. While playing, once per second:

```
EventFX: load 30 ms/s in JS, 57 LOM writes/s, 85 msgs/s | routing ok 9, missed 0, wrong 0
```

- `missed` or `expected N, started N-1`: the selector moved too late → raise `selLead`
- `expected N, started N+1`: too early → lower `selLead`

`DEBUG_MARKS` logs every marker. Keep both off while playing: printing to the Max console slows
down Live's parameter writes.

## Measured (140 BPM, one track)

- `update` without changes: 1-5 s (20 chains); `chains 20` from 10: ~32 s
- `reload` with 20 chains: ~0.3-1.3 s
- one track, dense pattern, all effects: ~10 % CPU; at most 7 of 8 chains sounding with `echoWith 4`

## Known limits

- Notes closer than ~30-50 ms can land in the wrong chain (`echoWith 4 (1/64)` at 140 BPM fails,
  `1/32` works). What counts is milliseconds, not cycles.
- The same pitch never overlaps: SuperDirt sends a note-off before repeating a pitch, so
  `legato > 1` on a repeated pitch behaves like `legato 1`.
- Notes at the same moment (chords) share one chain and mix their effect values - untested.
- Effects on the track after the rack exist once: a new value also affects the tails of earlier notes.
- When every chain is sounding, EventFX takes the chain with the oldest tail.
- About 108 CCs per track; when they run out, the parameter unused for longest loses its CC
  (the console says which).
