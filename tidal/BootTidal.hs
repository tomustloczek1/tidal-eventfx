:set -package containers
:set -fno-warn-orphans -Wno-type-defaults -XMultiParamTypeClasses -XOverloadedStrings
:set prompt ""

import Sound.Tidal.Boot
import System.IO (hSetEncoding, stdout, utf8)
hSetEncoding stdout utf8

default (Rational, Integer, Double, Pattern String)

tidalInst <- mkTidal

instance Tidally where tidal = tidalInst

enableLink

:script ~/.config/tidal/toolz.tidal
:script ~/.config/tidal/toolz-fx.tidal

:set prompt "tidal> "
:set prompt-cont ""
