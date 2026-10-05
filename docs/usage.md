# Usage

## EventFX buttons

| control | what it does | when |
|---|---|---|
| `reload` | reads the track's palette from the library and finds its parameters in all chains | after replacing `eventfx.js`, when something looks out of sync |
| `update` | scans the palette → library → `toolz-fx.tidal` → mirrors chain 1 into all chains → reload | after changing devices in chain 1 or after the rack, after editing `fx-rules.json`, after changing unmapped settings in chain 1 |
| `neutral` | puts every mapped parameter in every chain back to its resting value | before `rest`, before saving the template |
| `rest` | the knob positions in chain 1 become the new resting values (applied to all chains at once) | after `neutral` and turning knobs |
| `chains N` | adds chains up to N and fills them with the mirror | more chains; set their zones by hand afterwards |
| `browse` (toggle) | every note plays in chain 1 | auditioning presets in chain 1; click `update` afterwards |
| `channel` (number) | track number = MIDI channel = first argument of `toMidi` | once per track |

Everything except `reload` only while nothing plays (`update` / `rest` refuse when notes are held).

## Starting a session

1. Open Live (template). EventFX reads the library by itself, every ChainWatch reports in the
   Max console, the helper says `ready`.
2. `scripts/start.sh` (or `:StartSC`), wait for `==== SuperDirt ready ====`.
3. In Tidal: `:script ~/.config/tidal/toolz.tidal`, `:script ~/.config/tidal/toolz-fx.tidal`, `bpm <tempo>`.

## Changing the palette

1. In **chain 1** add, remove or reorder effects (or on the track after the rack).
2. Click `update`. The console lists new parameters (`new: ...`) and the mirror report.
3. If there were new parameters: `:script ~/.config/tidal/toolz-fx.tidal` in Tidal and
   **evaluate the patterns again** (`toMidi` is baked into a pattern when it is evaluated).

Names follow Live: device name (+ parameter) in camelCase, e.g. `saturator` (main parameter),
`saturatorDrive`. A name taken in Tidal/Haskell gets an `A` (`lpfA`, `gateA`).
Which parameters a device exposes is set in `tidal/fx-rules.json` (main parameter, preferred
parameters, how many). A removed effect stays in the library as *dormant* and gets its old CC back
when it returns.

Native devices may be renamed (HPF, LPF), but a rename means new names in Tidal.
**Do not rename Max for Live devices or plug-ins** - the helper finds them in the browser by name.

## Resting values

What a parameter is set to when a note doesn't use it.

1. `neutral` (cleans chain 1 of whatever the last note left there)
2. turn the knobs in chain 1
3. `rest`

Main parameters such as Dry/Wet, Amount, Threshold stay at 0 (effect off); `rest` doesn't touch them.
Settings that are not mapped to Tidal (filter type, saturation curve, the instrument): change them
in chain 1 and click `update`.

## Sounds from presets

`browse` on → hot-swap presets in chain 1 (all notes play there) → `browse` off → `update`.
Only parameters are copied to the other chains: Drum Rack pads, samples, Wavetable tables and the
hidden state of plug-ins are not.

## More chains

`chains 30` → set the **Chain Select zone** of every new chain (chain k → value k-1) **before playing**
→ `reload`. Until then, value 0 would select chain 1 and all new chains at once.
Removing chains: delete them by hand, then `update`.

## A new track

1. Duplicate the track (`Cmd+D`) or load the rack preset on a new MIDI track.
2. **First** set the EventFX `channel` box to the new number (2, 3, ...) and `MIDI From` to that channel.
   (`update` refuses while another track uses the same number.)
3. Change the palette in chain 1 if you like, click `update`.
4. `:script ~/.config/tidal/toolz-fx.tidal` → `d1 $ toMidi 2 $ ...`

Each track has its own palette and its own CC numbers (CCs are per MIDI channel).

## Recording

Automation Arm OFF. A recorded clip holds the notes and the MIDI CC envelopes (the jumps to 127 are
sentinels - they make Live record repeated values). Playing the clip without Tidal sounds the same.

## Saving templates and rack presets

Save them in Live as usual (template: File → Save Live Set As Template; preset: drag the rack to the
User Library, name it `tidal...`), then `scripts/collect.sh` and commit.

## Good to know

- Don't rename Max for Live devices or plug-ins in chain 1: the helper finds them in Live's browser by name.
- After reloading `toolz-fx.tidal`, evaluate the patterns again; after changing a lead, run `bpm`.
- Keep the Max console quiet while playing (`DEBUG_*` off): printing for every note slows Live's parameter writes down.
- Record with Automation Arm OFF.
- `irand 1` is always 0 - random values 0..1 are `rand`.
- `sometimes` goes in front of the pattern: `$ sometimes (# bpfA 0.6) $ n "..."`.
- If you save `EventFX.amxd` or `ChainWatch.amxd` in the Max editor, run `scripts/install.sh --check`
  (and `--apply` if it reports `NOLINK`).
