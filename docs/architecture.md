# Architecture

## Signal path

```
Tidal pattern
  └ toMidi <track>                      (tidal/toolz.tidal: toMidiWith)
       notes                            unchanged
       CC 118  selector marker          selLead before the note
       CC 119  value marker             ccLead + 3 ms before the note
       CC 127-sentinels                 so Live records repeated values
       one CC per effect value          ccLead before the note; numbers from fxCC of that track
  └ SuperDirt "m" → IAC Driver Bus 1, MIDI channel = track number

Live, MIDI track (MIDI From: IAC Bus 1, channel = track number)
  EventFX (Max MIDI Effect, eventfx.js)
    CC 119 → pick a free chain, reset it, the following CCs are written there
    CC 118 → move the Chain Selector to that chain
    effect CC → value written into the chain (or into a track effect), device switched on
  Instrument Rack "tidal" (Chain Selector, chain k has zone k-1)
    chain = instrument → palette effects → ChainWatch
  track effects after the rack (one instance each)
```

**Why chains:** an effect in a chain belongs to one note only, so its tail keeps its settings while
the next notes play in other chains - the SuperDirt behaviour (one synth per event).

**Why two markers:** effect values are sent early (~0.15 s) so they are in place in time, while the
selector has to move after the previous note and just before this one - with dense notes those are
two different moments.

**Free chain** = ChainWatch reports silence (level below -60 dB for 150 ms) **and** the chain holds
no note. Chains picked for a note are reserved for 600 ms.

## Files and who writes them

| file | written by | read by |
|---|---|---|
| `tidal/fx-library.json` | EventFX (`update`, `rest`) | EventFX at load |
| `tidal/toolz-fx.tidal` | EventFX (`update`) | Tidal |
| `tidal/fx-rules.json` | you | EventFX (`update`) |
| `tidal/toolz.tidal`, `BootTidal.hs` | you | Tidal |
| `live/devices/*.js`, `*.amxd` | you (Max) | Live |
| `live/EventFXHelper/*.py` | you | Live at start |

## The FX library (`fx-library.json`)

```
params:  { "<tidal name>": { device, param, occurrence } }           shared by all tracks
tracks:  { "<channel>": {
             fx: { "<tidal name>": { cc, rest, min, max, tier, inPalette, lastSeen, ... } },
             on: [ { with: "<tidal name>", cc, value } ]               e.g. BPF Dry/Wet with bpfA
         } }
```

- One entry per track (= MIDI channel). CC numbers are per track, so every track has ~108 of them.
- `inPalette: false` = *dormant*: not in the palette now, keeps its CC for when it comes back.
- `rest` is the resting value (in the parameter's own units).
- `toolz-fx.tidal` is generated from it: a `pF` for every name, `fxCC` (track → name → CC) and
  `fxOn`. A name missing from a track's map is simply not sent for that track.

## `update`

1. Scan chain 1 of the rack and the audio effects after it (`tier`: chain or track). Instruments,
   EQ Eight, Glue Compressor, Limiter and ChainWatch are not mapped (`skipDevices`).
2. Per device pick the parameters (`fx-rules.json`): main parameter, preferred ones, up to `maxChain`/`maxTrack`.
3. Merge into the library: new names get a free CC of this track; known ones keep CC and resting value.
4. Write `fx-library.json` and `toolz-fx.tidal`.
5. Mirror: make every chain equal to chain 1 - insert missing devices (native: LOM `insert_device`;
   Max for Live / plug-ins / ChainWatch: EventFXHelper), delete extra ones, rename, then copy values
   (mapped parameters → resting value, everything else → value in chain 1).
6. Reload the map.

## EventFXHelper

Python Remote Script, OSC over UDP (listens on 11010, answers on 11011):

```
/ping                                    → /pong <version>
/tracks                                  → /track <index> <name>
/find <id> <name>                        → /found <id> <1|0> <name>
/load <id> <track> <chain> <after> <name> → /loaded <id> <1|0> <new index> <message>
```

It searches the browser (Audio Effects, Max for Live, Plug-ins, Instruments, User Library) for the
name, selects the device `<after>` in the chain, switches the insert mode to "right of selected",
loads, waits until the chain has one device more, restores the selection.
