# Effects of the template palette

Chain: **Drift → HPF → Saturator → Redux → BPF → LPF → Utility → ChainWatch**, on the track: **Echo**.

General:
- Values are 0..1, stretched linearly over the parameter's range in Live.
- A note without a parameter gets its resting value; the main parameter (Dry/Wet etc.) rests at 0 = effect off.
- Using any parameter of a device switches that device on for the note; unused devices are off.
- Order matters: HPF before the distortion keeps it clean in the lows; LPF after it tames the harsh
  harmonics; Utility last for level and pan.
- Every library name (also effects not in the palette) is listed in `tidal/toolz-fx.tidal`.

## HPF (Auto Filter, high pass)

`hpfA` cutoff - 0 = open, higher = thinner, "radio". `hpfResonance` peak at the cutoff.
`hpfDrive` distortion inside the filter. `hpfFilterMorph` only works with the Morph filter type.

```haskell
# hpfA "0 0 0.6 0"                     -- single thin clicks
# hpfA (slow 8 $ range 0 0.5 saw)      -- build-up
```

## Saturator

`saturator` dry/wet - brings the saturation in. `saturatorDrive` how hard. `saturatorColorFreq`
only with Color switched on in the device. `saturatorOutput` level after it.

```haskell
# saturator "<0 1>" # saturatorDrive (range 0.4 0.9 rand)
```

## Redux (bitcrusher / downsampler)

`redux` dry/wet. `reduxBitDepth` fewer bits = grainier; at 1-3 bits quiet tails round down to
silence (normal). `reduxSampleRate` lower = aliasing, metallic. `reduxJitter` randomizes the
downsampling clock (only with a lowered sample rate).

```haskell
# redux 1 # reduxBitDepth "0.2 1 0.4 1"
```

## BPF (Auto Filter, band pass)

`bpfA` centre frequency - also switches the BPF's Dry/Wet on, so a note without `bpfA` is unfiltered.
`bpfResonance` narrower and more ringing. `bpfDrive` distortion before the band.

```haskell
$ sometimes (# bpfA 0.6 # bpfResonance 0.5) $ n "..."
```

## LPF (Auto Filter, low pass)

`lpfA` cutoff - 1 = open, lower = darker; the most useful knob for per-note movement.
`lpfResonance` peak (acid). `lpfDrive` filter distortion. `lpfFilterMorph` Morph type only.

```haskell
# lpfA (range 0.25 0.95 sine) # lpfResonance 0.4
```

## Utility

`utility` gain of the note (accents, ghost notes; high values are loud). `utilityBalance`
0 = left, 0.5 = centre, 1 = right. `utilityStereoWidth` 0 = mono. `utilityBassFreq` only with Bass Mono on.

```haskell
# utility "0.85 0.6 0.75 0.6" # utilityBalance (choose [0.2, 0.5, 0.8])
```

## Echo (on the track - one instance)

`echoA` dry/wet, `echoFeedback` number of repeats. A new value also changes the tails of earlier
notes, so change it per cycle rather than per note.

```haskell
# echoA "<0 0.3>"
```
