# tidal-eventfx

Per-note Ableton Live effects for [TidalCycles](https://tidalcycles.org), the way SuperDirt does it:
every note plays in its own chain of an Instrument Rack with its own effect values, effect tails
keep their settings, and everything records into ordinary MIDI clips (notes + CC).

```haskell
d1 $ toMidi 1 $ n "0 3 7 5" # redux "0 1" # lpfA (range 0.2 0.9 sine) # utilityBalance rand
```

## How it works (short)

```
Tidal ── toMidi ──> notes + CC (marker, selector, one CC per effect value) ──> IAC MIDI bus
                                                                                    │
Live track:  EventFX (Max MIDI Effect) ──> Instrument Rack "tidal", 20 chains ──────┘
             writes each note's values       chain = instrument + effects + ChainWatch
             into the chain it will play in  the Chain Selector moves to that chain just before the note
```

- **EventFX** turns the CCs into parameter changes, rotates notes over the chains and knows which
  chains are still sounding (**ChainWatch** at the end of every chain reports silence).
- **Chain 1 is the template**: you edit only chain 1; `update` copies it into all other chains and
  maps its parameters to Tidal names (`saturatorDrive`, `lpfA`, ...).
- **EventFXHelper** (a Python Remote Script) loads what Live's API can't insert: Max for Live
  devices and plug-ins.
- The **FX library** (`tidal/fx-library.json`) remembers every effect parameter ever mapped, with
  its CC per track, so old clips keep working when the palette changes.

Details: [docs/architecture.md](docs/architecture.md).

## Requirements

macOS, Ableton Live 12.3+ Suite (Max for Live), TidalCycles with SuperCollider/SuperDirt,
the IAC Driver (Audio MIDI Setup) with "Bus 1" enabled, tmux (for `scripts/start.sh`).

## Install

```bash
git clone https://github.com/tomustloczek1/tidal-eventfx.git ~/Documents/tidal/tidal-eventfx
cd ~/Documents/tidal/tidal-eventfx
scripts/install.sh            # dry run: shows what it will link / move / back up
scripts/install.sh --apply    # do it
```

The repo becomes the home of all files; the usual locations (`~/.config/tidal`, the User Library
devices, the Remote Script, SuperCollider's `startup.scd`) become links to it.
Existing files are moved in or backed up, never deleted.

Then in Live:

1. Settings → Link, Tempo & MIDI → Control Surface: **EventFXHelper** (input / output: None). Restart Live.
2. File → New Live Set from Template → **tidal-template** (or set it as the default set).
3. In SuperDirt, `\m` must be a MIDI device on the IAC Driver (see `supercollider/startup.scd`).

## Play

```bash
scripts/start.sh               # SuperCollider + SuperDirt in tmux
```
`BootTidal.hs` loads `toolz.tidal`, `toolz-fx.tidal` and every file in `tidal/f/` (through
`load-functions.tidal`, alphabetically), so after boot:

```haskell
bpm 140
d1 $ toMidi 1 $ n "0 [3 ~] 7 5" # saturator "<0 0.8>" # lpfA (range 0.25 0.95 sine)
chk $ toMidi 1 $ n "0 [3 ~"       -- dry run: type check + mini-notation parse, nothing plays
rec 4 d1 $ toMidi 1 $ n "0 3 7"  -- record 4 cycles into Live from the next bar
```

`toMidi <track>` sends to the Live track whose EventFX `channel` box has that number.
`urm` builds a song form from named parts on several tracks (`tidal/f/20-urm.tidal`).

## Documentation

| file | what's in it |
|---|---|
| [docs/usage.md](docs/usage.md) | EventFX buttons, changing the palette, resting values, new tracks, recording |
| [docs/effects.md](docs/effects.md) | the effects of the template palette and how to use them per note |
| [docs/architecture.md](docs/architecture.md) | how it works inside, files, the library |
| [docs/tuning.md](docs/tuning.md) | timing values, density limits, diagnostics |

## Repository layout

| folder | linked to | contents |
|---|---|---|
| `tidal/` | `~/.config/tidal/` | BootTidal, `toolz.tidal` (toMidi, bpm), FX library, rules, generated `toolz-fx.tidal` |
| `tidal/f/` | (inside `tidal/`) | more functions, loaded in name order by `load-functions.tidal`: `chk`, `urm`, `rec` |
| `live/devices/` | User Library presets folders | EventFX and ChainWatch (`.amxd` + `.js`) |
| `live/EventFXHelper/` | `User Library/Remote Scripts/EventFXHelper/` | Remote Script |
| `live/templates/`, `live/presets/` | copied into the User Library | Live template, rack presets (`scripts/collect.sh` brings them back) |
| `supercollider/` | `startup.scd` | SuperDirt setup |
| `scripts/` | | `install.sh`, `collect.sh`, `start.sh` |
