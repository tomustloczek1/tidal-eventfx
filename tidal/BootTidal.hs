:set -package containers
:set -package hosc
-- tidal / tidal-core exposed for tidal.nvim's playstate.hs (imports Sound.Tidal.Pattern)
:set -package tidal
:set -package tidal-core
:set -fno-warn-orphans -Wno-type-defaults -XMultiParamTypeClasses -XOverloadedStrings
:set prompt ""

import Sound.Tidal.Boot
import System.IO (hSetEncoding, stdout, utf8)
hSetEncoding stdout utf8

default (Rational, Integer, Double, Pattern String)

-- clock target for tidal.nvim event highlighting (thgrund fork): pings on UDP 6013.
-- mkOscMap is exactly what plain mkTidal uses (SuperDirt, latency 0.05), so the MIDI latency
-- calibration (nud, midiShift) stays valid; superdirtShape requires "s", so the clock events
-- never reach SuperDirt.
let clockShape = OSC "/ping" $ Named {requiredArgs = ["clock"]}
let clockTarget = Target {oName = "clock", oAddress = "127.0.0.1", oPort = 6013, oLatency = 0.3, oSchedule = Live, oWindow = Nothing, oHandshake = False, oBusPort = Nothing}

tidalInst <- mkTidalWith (mkOscMap ++ [(clockTarget, [clockShape])]) defaultConfig

instance Tidally where tidal = tidalInst

enableLink

:script ~/.config/tidal/toolz.tidal
:script ~/.config/tidal/toolz-fx.tidal
:script ~/.config/tidal/load-functions.tidal

:set prompt "tidal> "
:set prompt-cont ""
