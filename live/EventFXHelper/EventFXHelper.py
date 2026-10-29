# EventFXHelper - loads browser items (Max for Live devices, plug-ins, presets) into rack
# chains for EventFX; the Max for Live API can only insert native devices (insert_device).
#
# Install: ~/Music/Ableton/User Library/Remote Scripts/EventFXHelper/   (restart Live)
# Enable:  Settings -> Link, Tempo & MIDI -> Control Surface: EventFXHelper (input/output: None)
# OSC over UDP: listens on 127.0.0.1:11010, replies to 127.0.0.1:11011. Log: Live's Log.txt.
#
# Indices are 0-based: track = index in the set's track list (-1 = selected track),
# chain = rack chain (-1 = the track's own device chain), after = device the new one goes after.
# <id> is any number chosen by the sender; replies carry it back.
#
#   /ping                                   -> /pong <version>
#   /tracks                                 -> /track <index> <name>   (one per track)
#   /find <id> <name> [scope] [class]       -> /found <id> <1|0> <name or reason>
#   /load <id> <track> <chain> <after> <name> [class] [scope]
#                                           -> /loaded <id> <1|0> <index of new device or -1> <message>
#       inserts the browser item right after device <after>
#   /swap <id> <track> <chain> <index> <name> [class] [scope]
#                                           -> /loaded <id> <1|0> <index> <message>
#       replaces device <index> with the browser item (hot-swap, as in Live's browser)
#   /record <channel> <cycles>              -> /status "recording ..."
#       arms the track whose MIDI input is that channel (or named like it), starts the transport if
#       needed and fires its first empty clip slot: Live starts recording at the next bar (global
#       launch quantization), no count-in; cycles > 0 stops after that many bars (4 beats each)
#   /recstop <channel>                      -> stops that track's recording at the next bar
#   /inst <channel> <name>                  -> loads preset/instrument <name> into rack chain 1 of that
#                                              track (hot-swap), then asks its EventFX to refill chains
#                                              2..N; the result goes to Tidal (UDP 11013): /inst ch ok text
#   /refilled <track index> <ok> <text>     <- from EventFX when that refill is done
#   /instlist                               -> writes every instrument/preset name of the browser to
#                                              ~/.config/tidal/instruments.txt (for Tab in Neovim)
#   /recmany <cycles> <channel> ...         -> /status: records several tracks at once, all in the
#                                              same scene row (the first row empty on all of them)
#   /inchan <id> <track> <channel>          -> /status: sets the track's MIDI input channel ("Ch. N")
#   /want <channel> <name>                  <- from Tidal (toMidi met a name without a CC on that track):
#                                              -> /fxwant <channel> <name> to EventFX, which maps it
#   /wanted <channel> <ok> <text>           <- from EventFX -> Tidal (UDP 11015): /fx <ok> <text>
#   /fxscan [new|all|auto|stop]                  -> ~/.config/tidal/fx-catalog.json: the parameters of every
#                                              audio effect in the browser (native, Max for Live, racks;
#                                              presets get their device's params without loading). Each
#                                              device is loaded for a moment on a temporary audio track at
#                                              the end of the set. new: only what the catalog doesn't have
#                                              yet (+ retries); all: everything again; auto (from EventFX
#                                              after update): new ones only, nothing before the first scan;
#                                              stop: finish the current device, write what was read so far.
#                                              Progress to Tidal (UDP 11014): /fxscan <text>, the last
#                                              one /fxscanend <text>; when done,
#                                              /catalog to EventFX, which rewrites toolz-fx.tidal and
#                                              answers /catalogdone <ok> <names>
#   /reccal <channel>                       -> /status + /reccal <ok> <ms> to Tidal (port 11012): records 2 bars on that track, how late
#                                              the first note lands after the bar line, deletes the clip
# scope: "device" (default: Audio Effects, Max for Live, Plug-ins, Instruments, User Library)
#        "preset" (User Library, Sounds, Drums, Instruments - where instrument/rack presets live)
# class: expected class_name of the loaded device; another class is undone and reported
# Loads are queued and done one at a time; each is verified (device count of the chain grew by 1)
# before the next one starts. Track selection and the insert mode are restored afterwards.

import json
import math
import os
import socket
import struct
import time

import Live
from _Framework.ControlSurface import ControlSurface

VERSION = 15
LISTEN = ("127.0.0.1", 11010)
REPLY = ("127.0.0.1", 11011)
TIDAL = ("127.0.0.1", 11012)  # reccal result for Tidal: /reccal <ok 0|1> <ms late (float)>
TIDAL_INST = ("127.0.0.1", 11013)  # instrument changes for Tidal: /inst <ch> <ok> <text>, /instlist <n> <text>
INST_LIST = os.path.expanduser("~/.config/tidal/instruments.txt")
INST_ROOTS = ("instruments", "drums", "sounds", "user_library")   # browser roots listed by /instlist
TIDAL_FX = ("127.0.0.1", 11014)    # fxscan progress for Tidal: /fxscan <text>
TIDAL_FXW = ("127.0.0.1", 11015)   # mapping on demand, answers for Tidal: /fx <ok> <text>
FX_CATALOG = os.path.expanduser("~/.config/tidal/fx-catalog.json")
FX_ROOTS = ("user_library", "audio_effects", "max_for_live")   # walked in this order: your presets first
FX_SKIP = ("ChainWatch", "Audio Effect Rack")   # never loaded for the catalog (an empty rack has no names)
FX_LOADED = ("native", "m4l", "rack")           # kinds that are loaded to read their parameters
SCAN_TRACK = "fxscan (temporary)"
SCAN_TIMEOUT_TICKS = 150   # ~15 s per device
SCAN_SECONDS = {"native": 0.6, "rack": 4.0, "m4l": 4.0}   # measured: 464 devices (mostly racks) in 28 min
SCAN_STABLE_TICKS = {"native": 1, "rack": 3, "m4l": 10}   # ticks the param count must stay the same
                                                          # (a Max device adds its params after Max loads)
SEARCH_DEPTH = 6            # browser levels searched below each root
# where to look, in this order (each root is searched completely before the next one)
DEVICE_ROOTS = ("max_for_live", "plugins", "user_library", "audio_effects", "instruments")
PRESET_ROOTS = {            # by the class of the device the preset is for
    "DrumGroupDevice": ("user_library", "drums"),
    "InstrumentGroupDevice": ("user_library", "instruments", "sounds"),
    "AudioEffectGroupDevice": ("user_library", "audio_effects"),
    "MidiEffectGroupDevice": ("user_library", "midi_effects"),
}
PRESET_ROOTS_DEFAULT = ("user_library", "sounds", "instruments", "drums")
# remembered browser paths: the second search for a name walks straight to it
PATH_CACHE = os.path.expanduser("~/Library/Application Support/EventFXHelper/paths.json")
LOAD_TIMEOUT_TICKS = 120    # ~12 s (update_display runs about every 100 ms; kits with samples are slow)
REPLIES = ("/pong", "/track", "/found", "/loaded", "/status", "/error", "/refill", "/catalog", "/fxwant")


# ---- minimal OSC ------------------------------------------------------------------
def _osc_string(s):
    b = s.encode("utf-8") + b"\0"
    return b + b"\0" * ((4 - len(b) % 4) % 4)


def osc_encode(address, *args):
    tags, data = ",", b""
    for a in args:
        if isinstance(a, bool):
            a = int(a)
        if isinstance(a, int):
            tags += "i"
            data += struct.pack(">i", a)
        elif isinstance(a, float):
            tags += "f"
            data += struct.pack(">f", a)
        else:
            tags += "s"
            data += _osc_string(str(a))
    return _osc_string(address) + _osc_string(tags) + data


def _read_string(data, i):
    end = data.index(b"\0", i)
    s = data[i:end].decode("utf-8", "replace")
    i = end + 1
    return s, i + (4 - i % 4) % 4


def osc_decode(data):
    address, i = _read_string(data, 0)
    if i >= len(data):
        return address, []
    tags, i = _read_string(data, i)
    args = []
    for t in tags[1:]:
        if t == "i":
            args.append(struct.unpack(">i", data[i:i + 4])[0])
            i += 4
        elif t == "f":
            args.append(struct.unpack(">f", data[i:i + 4])[0])
            i += 4
        elif t == "s":
            s, i = _read_string(data, i)
            args.append(s)
    return address, args


class LoadError(Exception):
    pass


# ---- control surface ---------------------------------------------------------------
class EventFXHelper(ControlSurface):

    def __init__(self, c_instance):
        ControlSurface.__init__(self, c_instance)
        self._cache = {}        # (scope, name) -> BrowserItem (this session)
        self._paths = self._load_paths()   # "scope|name" -> [root, child, child, ...] (across sessions)
        self._queue = []        # pending /load jobs
        self._job = None        # load in progress
        self._saved_track = None
        self._recs = []         # recordings to stop by hand (when ClipSlot.fire has no record_length)
        self._cals = []         # /reccal recordings waiting to be measured
        self._arms = []         # tracks armed by /reccal: disarmed when its recording ends
        self._ends = []         # /record, /recmany: stop the new clip (no auto-play) + disarm at the end
        self._insts = {}        # track index -> {"ch", "name", "t0"}: instrument changes in progress
        self._listing = None    # /instlist walk in progress: {"stack", "names", "seen"}
        self._scan = None       # /fxscan in progress (see _fxscan)
        self._cat_wait = None   # fxscan done, waiting for EventFX to rewrite toolz-fx: {"t", "auto", "text"}
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._sock.bind(LISTEN)
        self._sock.setblocking(False)
        self.log_message("EventFXHelper %d: listening on %d" % (VERSION, LISTEN[1]))
        self._reply("/status", "EventFXHelper %d ready" % VERSION)

    def disconnect(self):
        try:
            self._sock.close()
        except Exception:
            pass
        ControlSurface.disconnect(self)

    # Live calls this about every 100 ms: read the socket, then advance the current load
    def update_display(self):
        ControlSurface.update_display(self)
        while True:
            try:
                data, _ = self._sock.recvfrom(65536)
            except OSError:
                break
            try:
                self._handle(*osc_decode(data))
            except Exception as e:
                self._reply("/error", "%s: %s" % (type(e).__name__, e))
        self._tick()

    def _reply(self, address, *args):
        try:
            self._sock.sendto(osc_encode(address, *args), REPLY)
        except Exception as e:
            self.log_message("EventFXHelper: reply failed: %s" % e)

    def _handle(self, address, args):
        if address in REPLIES:
            return                      # our own reply looped back (patch cable to udpsend): ignore
        if address == "/ping":
            self._reply("/pong", VERSION)
        elif address == "/tracks":
            for i, t in enumerate(self.song().tracks):
                self._reply("/track", i, t.name)
        elif address == "/find":
            job_id, name = args[0], args[1]
            item = self._find(name, args[2] if len(args) > 2 else "device", args[3] if len(args) > 3 else "")
            self._reply("/found", job_id, 1 if item else 0, item.name if item else "not in the browser")
        elif address in ("/load", "/swap"):
            job_id, track, chain, at, name = args[:5]
            self._queue.append({"id": job_id, "track": int(track), "chain": int(chain),
                                "at": int(at), "name": name, "swap": address == "/swap",
                                "cls": args[5] if len(args) > 5 else "",
                                "scope": args[6] if len(args) > 6 else ("preset" if address == "/swap" else "device")})
        elif address == "/record":
            self._record(int(args[0]), int(args[1]) if len(args) > 1 else 0)
        elif address == "/recmany":
            self._recmany(int(args[0]), [int(a) for a in args[1:]])
        elif address == "/recstop":
            self._recstop(int(args[0]))
        elif address == "/reccal":
            self._reccal(int(args[0]))
        elif address == "/inst":
            self._inst(int(args[0]), str(args[1]))
        elif address == "/refilled":
            self._refilled(int(args[0]), int(args[1]), " ".join(str(a) for a in args[2:]))
        elif address == "/instlist":
            self._instlist()
        elif address == "/fxscan":
            self._fxscan(str(args[0]) if args else "new")
        elif address == "/want":            # Tidal: a name without a CC on that track
            self._reply("/fxwant", int(args[0]), str(args[1]))
        elif address == "/wanted":          # EventFX: how it went -> Tidal
            try:
                self._sock.sendto(osc_encode("/fx", int(args[1]), " ".join(str(a) for a in args[2:])), TIDAL_FXW)
            except Exception as e:
                self.log_message("EventFXHelper: message to Tidal failed: %s" % e)
        elif address == "/catalogdone":
            self._catalog_done(int(args[0]) if args else 0, int(args[1]) if len(args) > 1 else 0)
        elif address == "/inchan":
            self._inchan(int(args[1]), int(args[2]))
        else:
            self._reply("/error", "unknown command " + address)

    # ---- recording --------------------------------------------------------------------
    def _track_for_channel(self, ch):
        tracks = list(self.song().tracks)
        for t in tracks:
            try:
                if t.has_midi_input and t.input_routing_channel.display_name.strip() == "Ch. %d" % ch:
                    return t
            except Exception:
                pass
        return next((t for t in tracks if t.name.strip() == str(ch)), None)

    def _record(self, ch, cycles):
        if self._link_off("record") or not self._bar_quant_ok("record"):
            return
        song = self.song()
        track = self._track_for_channel(ch)
        if track is None:
            return self._reply("/error", "record: no track takes MIDI channel %d" % ch)
        slots = list(track.clip_slots)
        index = next((i for i, slot in enumerate(slots) if not slot.has_clip), None)
        if index is None:
            return self._reply("/error", "record: no empty clip slot on track '%s'" % track.name)
        slot = slots[index]
        armed_here = track.can_be_armed and not track.arm
        if armed_here:
            track.arm = True
        if song.record_mode:
            song.record_mode = False        # Arrangement Record on would also write into the arrangement
        if not song.is_playing:
            song.start_playing()
        beats = cycles * 4.0
        if cycles > 0:
            try:
                slot.fire(record_length=beats)
            except Exception:
                slot.fire()
        else:
            slot.fire()
        self._watch_end(slot, track, beats)     # also ends it when fire() had no record_length
        self._reply("/status", "recording track '%s' slot %d from the next bar%s, then the clip stops" % (
            track.name, index + 1, (" for %d cycles" % cycles) if cycles > 0 else " until recstop"))

    # several tracks at once (rec in urm.tidal): one scene row, so the parts of a song stay together
    def _recmany(self, cycles, chans):
        if self._link_off("rec") or not self._bar_quant_ok("rec"):
            return
        if not chans:
            return self._reply("/error", "rec: no channels")
        tracks = []
        for ch in chans:
            t = self._track_for_channel(ch)
            if t is None:
                return self._reply("/error", "rec: no track takes MIDI channel %d" % ch)
            if t not in tracks:
                tracks.append(t)
        rows = min(len(list(t.clip_slots)) for t in tracks)
        index = next((i for i in range(rows)
                      if all(not list(t.clip_slots)[i].has_clip for t in tracks)), None)
        if index is None:
            return self._reply("/error", "rec: no scene row is empty on all of: %s - add a scene" %
                               ", ".join("'%s'" % t.name for t in tracks))
        song = self.song()
        if song.record_mode:
            song.record_mode = False
        for t in tracks:
            if t.can_be_armed and not t.arm:
                t.arm = True
        if not song.is_playing:
            song.start_playing()
        beats = cycles * 4.0
        for t in tracks:
            slot = list(t.clip_slots)[index]
            if cycles > 0:
                try:
                    slot.fire(record_length=beats)
                except Exception:
                    slot.fire()             # no fixed length: _tick_ends stops it at the right bar
            else:
                slot.fire()
            self._watch_end(slot, t, beats)
        self._reply("/status", "rec: %d tracks into scene %d from the next bar%s, then the clips stop" % (
            len(tracks), index + 1, (" for %d cycles" % cycles) if cycles > 0 else " until recstop"))

    # recordings start and stop on bar lines only with Launch Quantization = 1 Bar
    def _bar_quant_ok(self, what):
        try:
            if self.song().clip_trigger_quantization != Live.Song.Quantization.q_bar:
                self._reply("/error", "%s: set Launch Quantization (top bar) to 1 Bar first" % what)
                return False
        except Exception:
            pass
        return True

    # ---- end of a recording: the new clip does not start playing, the track is disarmed -----
    def _watch_end(self, slot, track, beats):
        self._ends.append({"slot": slot, "track": track, "beats": beats, "seen": False,
                           "start": 0.0, "stopping": False, "ticks": 0})

    def _stop_track(self, track, quantized):
        try:
            track.stop_all_clips(quantized)
        except TypeError:
            track.stop_all_clips()          # older Live: always quantized

    def _tick_ends(self):
        now = self.song().current_song_time
        for e in list(self._ends):
            e["ticks"] += 1
            try:
                recording = e["slot"].is_recording
            except Exception:
                self._ends.remove(e)        # slot gone (track deleted)
                continue
            if not e["seen"]:
                if recording:
                    e["seen"] = True
                    e["start"] = math.floor(now / 4.0) * 4.0     # the bar it started on
                elif e["ticks"] > 600:                            # never started within ~60 s
                    self._ends.remove(e)
                    self._disarm(e["track"])
                continue
            if recording:
                # inside the last bar: a quantized stop ends the recording at its last bar line,
                # so the clip is complete but does not start playing
                if e["beats"] > 0 and not e["stopping"] and now >= e["start"] + e["beats"] - 2.0:
                    self._stop_track(e["track"], True)
                    e["stopping"] = True
                continue
            self._ends.remove(e)            # recording over
            try:
                if e["slot"].has_clip and e["slot"].clip.is_playing:
                    self._stop_track(e["track"], False)
            except Exception:
                pass
            self._disarm(e["track"])

    def _disarm(self, track):
        try:
            if track.can_be_armed:
                track.arm = False
        except Exception:
            pass

    def _recstop(self, ch):
        track = self._track_for_channel(ch)
        if track is None:
            return self._reply("/error", "recstop: no track takes MIDI channel %d" % ch)
        for slot in track.clip_slots:
            if slot.is_recording:
                self._stop_track(track, True)   # ends the recording at the next bar, the clip stays stopped
                self._recs = [r for r in self._recs if r["slot"] is not slot]
                return self._reply("/status", "recording on track '%s' ends at the next bar" % track.name)
        self._reply("/error", "recstop: track '%s' is not recording" % track.name)

    # without Link, Live and Tidal run on separate clocks and the phase drifts (~12 ms/s seen):
    # recordings land anywhere. Turn it on and refuse this time (the phase needs a moment to lock).
    def _link_off(self, what):
        song = self.song()
        try:
            if song.is_ableton_link_enabled:
                return False
            song.is_ableton_link_enabled = True
        except Exception:
            return False                    # this Live version can't tell - go ahead
        self._reply("/error", "%s: Link was off in Live - turned it on, run %s again in a few seconds" % (what, what))
        return True

    # ---- instrument per track (# i "name" in Tidal) ------------------------------------
    def _to_tidal_inst(self, *args):
        try:
            self._sock.sendto(osc_encode(*args), TIDAL_INST)
        except Exception as e:
            self.log_message("EventFXHelper: message to Tidal failed: %s" % e)

    def _track_index(self, track):
        return next((i for i, t in enumerate(self.song().tracks) if t._live_ptr == track._live_ptr), -1)

    def _inst(self, ch, name):
        track = self._track_for_channel(ch)
        if track is None:
            return self._to_tidal_inst("/inst", ch, 0, "no track takes MIDI channel %d" % ch)
        rack = next((d for d in track.devices if d.can_have_chains), None)
        chains = list(rack.chains) if rack is not None else []
        if not chains:
            return self._to_tidal_inst("/inst", ch, 0, "no tidal rack on track '%s'" % track.name)
        devs = list(chains[0].devices)
        at = next((i for i, d in enumerate(devs) if d.type == Live.Device.DeviceType.instrument), None)
        if at is None:
            return self._to_tidal_inst("/inst", ch, 0, "no instrument in chain 1 of track '%s'" % track.name)
        if devs[at].name.lower() == name.lower():
            return self._to_tidal_inst("/inst", ch, 1, "'%s' is already there" % devs[at].name)
        ti = self._track_index(track)
        if ti in self._insts:
            return self._to_tidal_inst("/inst", ch, 0, "track '%s' is still changing its instrument" % track.name)
        self._insts[ti] = {"ch": ch, "name": name, "t0": time.time()}
        self._queue.append({"id": "inst", "inst": ti, "track": ti, "chain": 0, "at": at, "name": name,
                            "swap": True, "cls": "", "scope": "preset"})

    # chain 1 has the new instrument (or failed): the EventFX of that track copies it everywhere
    def _inst_job_done(self, job, ok, message):
        ti = job["inst"]
        p = self._insts.get(ti)
        if p is None:
            return
        if not ok:
            self._insts.pop(ti, None)
            return self._to_tidal_inst("/inst", p["ch"], 0, message)
        p["t_chain1"] = time.time()
        self._reply("/refill", ti, p["name"])

    def _refilled(self, ti, ok, text):
        p = self._insts.pop(ti, None)
        if p is None:
            return
        self._to_tidal_inst("/inst", p["ch"], ok, "%s (%.1f s)" % (text, time.time() - p["t0"]))

    def _tick_insts(self):
        for ti, p in list(self._insts.items()):         # EventFX never answered
            if time.time() - p["t0"] > 90:
                self._insts.pop(ti, None)
                self._to_tidal_inst("/inst", p["ch"], 0, "no answer from EventFX on that track (90 s)")

    # every loadable instrument / preset name, walked a few hundred items per tick (Live's UI
    # thread runs this, a full walk at once would freeze it)
    def _instlist(self, quiet=False):
        if self._listing is not None:
            return None if quiet else self._to_tidal_inst("/instlist", 0, "already listing")
        b = Live.Application.get_application().browser
        stack = [(getattr(b, r), [r]) for r in reversed(INST_ROOTS) if hasattr(b, r)]
        self._listing = {"stack": stack, "names": set(), "seen": 0, "t0": time.time(), "quiet": quiet}

    def _tick_listing(self):
        job = self._listing
        n = 0
        while job["stack"] and n < 300:
            item, path = job["stack"].pop()
            n += 1
            job["seen"] += 1
            name = item.name
            is_file = item.is_loadable and "." in name[-6:]
            if len(path) > 1 and item.is_loadable:
                in_user = path[0] == "user_library"
                if not in_user or ("Instruments" in path or "Drums" in path):
                    if not in_user or is_file:
                        job["names"].add(name.rsplit(".", 1)[0] if is_file else name)
            if not is_file and len(path) <= SEARCH_DEPTH + 1:
                try:
                    kids = list(item.children)
                except Exception:
                    kids = []
                for c in reversed(kids):
                    job["stack"].append((c, path + [c.name]))
        if job["stack"]:
            return
        self._listing = None
        names = sorted(job["names"], key=lambda x: x.lower())
        try:
            os.makedirs(os.path.dirname(INST_LIST), exist_ok=True)
            with open(INST_LIST, "w") as f:
                f.write("\n".join(names) + "\n")
            if not job["quiet"]:
                self._to_tidal_inst("/instlist", len(names), "%d names in %s (%d browser items, %.0f s)" % (
                    len(names), INST_LIST, job["seen"], time.time() - job["t0"]))
        except Exception as e:
            if not job["quiet"]:
                self._to_tidal_inst("/instlist", 0, "can't write %s: %s" % (INST_LIST, e))

    # ---- recording offset: one bar with one note per cycle (reccal in Tidal) -------------
    # ---- effect catalog: every audio effect's parameter names (/fxscan) -----------------
    def _to_tidal_fx(self, text, end=False):
        """/fxscan <text> while it runs, /fxscanend <text> as the last message"""
        try:
            self._sock.sendto(osc_encode("/fxscanend" if end else "/fxscan", text), TIDAL_FX)
        except Exception as e:
            self.log_message("EventFXHelper: message to Tidal failed: %s" % e)

    def _scan_say(self, text):
        self.log_message("EventFXHelper: fxscan: " + text)
        if self._scan is None or not self._scan["auto"]:
            self._to_tidal_fx("fxscan: " + text)

    @staticmethod
    def _read_catalog():
        try:
            with open(FX_CATALOG) as f:
                cat = json.load(f)
            return cat if isinstance(cat, dict) and isinstance(cat.get("items"), dict) else None
        except Exception:
            return None

    @staticmethod
    def _write_catalog(cat):
        os.makedirs(os.path.dirname(FX_CATALOG), exist_ok=True)
        tmp = FX_CATALOG + ".tmp"
        with open(tmp, "w") as f:
            json.dump(cat, f, indent=0, sort_keys=True)
        os.replace(tmp, FX_CATALOG)          # EventFX never reads a half-written file

    def _fxscan(self, mode):
        if mode == "stop":
            if self._scan is None:
                return self._to_tidal_fx("fxscan: nothing to stop", end=True)
            if self._scan["phase"] != "load":
                self._scan = None                # still walking the browser: nothing to keep
                return self._to_tidal_fx("fxscan: stopped", end=True)
            self._scan["todo"] = []              # the device being loaded finishes, then the
            self._scan["stopped"] = True         # catalog is written with what was read so far
            return
        if mode not in ("new", "all", "auto"):
            mode = "new"
        if self._scan is not None:
            if mode != "auto":
                self._to_tidal_fx("fxscan: already running", end=True)
            return
        old = self._read_catalog()
        if mode == "auto" and old is None:
            return                               # the first scan is started by hand (fxscan in Tidal)
        b = Live.Application.get_application().browser
        stack = [(getattr(b, r), [r]) for r in reversed(FX_ROOTS) if hasattr(b, r)]
        self._scan = {"mode": mode, "auto": mode == "auto", "phase": "walk", "stack": stack,
                      "found": {}, "old": old["items"] if old else {}, "todo": [], "same": {},
                      "results": {}, "done": 0, "failed": 0, "total": 0, "t0": time.time(),
                      "t_say": time.time(), "track": None, "sel": None, "job": None, "seen": 0}
        self._scan_say("walking Live's browser...")

    @staticmethod
    def _fx_descend(path):
        """walk into this folder? (User Library: only Presets/Audio Effects)"""
        if path[0] != "user_library" or len(path) == 1:
            return True
        if path[1] != "Presets":
            return False
        return len(path) == 2 or path[2] == "Audio Effects"

    @staticmethod
    def _fx_kind(path, item, is_file):
        """(kind, class, source) of a browser item for the catalog, or None"""
        name = item.name
        root = path[0]
        if not is_file:
            if root == "audio_effects" and len(path) == 2 and item.is_device:
                return ("native", name, "core")
            return None
        ext = name.rsplit(".", 1)[1].lower()
        if root == "user_library":
            if len(path) < 5:                    # user_library/Presets/Audio Effects/<folder>/<file>
                return None
            source, cls = "user", path[3]
        elif root == "max_for_live":
            # only audio effects: their folder says so ("Max Audio Effect", ".../Audio Effects")
            if ext != "amxd" or not any("audio effect" in p.lower() for p in path[1:-1]):
                return None
            return ("m4l", "", "core")
        else:
            source, cls = "core", path[1]
        if ext == "adv":
            return ("preset", cls, source)
        if ext == "adg":
            return ("rack", "", source)
        if ext == "amxd":
            return ("m4l", "", source)
        return None

    def _tick_scan(self):
        s = self._scan
        if self._job is not None or self._queue:
            return                               # EventFX is loading devices: wait for it
        if s["phase"] == "walk":
            n = 0
            while s["stack"] and n < 300:
                item, path = s["stack"].pop()
                n += 1
                s["seen"] += 1
                is_file = item.is_loadable and "." in item.name[-7:]
                if len(path) > 1:
                    kind = self._fx_kind(path, item, is_file)
                    base = item.name.rsplit(".", 1)[0] if is_file else item.name
                    if kind is not None and base not in FX_SKIP:
                        s["found"]["/".join(path)] = {"item": item, "name": base, "kind": kind[0],
                                                     "class": kind[1], "source": kind[2]}
                if not is_file and len(path) <= SEARCH_DEPTH + 1 and self._fx_descend(path):
                    try:
                        kids = list(item.children)
                    except Exception:
                        kids = []
                    for c in reversed(kids):
                        s["stack"].append((c, path + [c.name]))
            if not s["stack"]:
                self._scan_plan()
            return
        self._tick_scan_load()

    def _scan_plan(self):
        s = self._scan
        found, old = s["found"], s["old"]
        first = {}                               # (kind, name) -> key loaded for all of them
        for key, e in found.items():
            if e["kind"] not in FX_LOADED:
                continue
            o = old.get(key)
            if s["mode"] == "new" and o is not None and o.get("params") is not None:
                continue                         # known
            if s["mode"] == "auto" and o is not None:
                continue                         # known or failed before (a scan by hand retries)
            k = (e["kind"], e["name"])           # the same device listed in two places: load it once
            if k in first:
                s["same"][first[k]].append(key)
            else:
                first[k] = key
                s["same"][key] = [key]
                s["todo"].append(key)
        new = sum(1 for k in found if k not in old)
        gone = sum(1 for k in old if k not in found)
        if s["auto"] and not s["todo"] and not new and not gone:
            self._scan = None                    # the browser has nothing new: nothing to do
            self._instlist(quiet=True)           # instruments.txt for Tab, the same way
            return
        s["total"] = len(s["todo"])
        if s["todo"]:
            secs = sum(SCAN_SECONDS[found[k]["kind"]] for k in s["todo"])
            self._scan_say("%d items in the browser, %d devices to load (about %d min) - a temporary "
                           "track appears at the end of the set, keep working on other tracks"
                           % (len(found), s["total"], max(1, int(secs / 60 + 0.5))))
            s["phase"] = "load"
        else:
            self._scan_finish()

    def _scan_track(self):
        song = self.song()
        s = self._scan
        if s["sel"] is None:
            s["sel"] = song.view.selected_track
        song.create_audio_track(-1)
        tr = list(song.tracks)[-1]
        tr.name = SCAN_TRACK
        try:
            tr.mute = True
        except Exception:
            pass
        s["track"] = tr
        return tr

    def _scan_track_alive(self):
        tr = self._scan["track"]
        if tr is None:
            return False
        try:
            return any(t._live_ptr == tr._live_ptr for t in self.song().tracks)
        except Exception:
            return False

    def _tick_scan_load(self):
        s = self._scan
        song = self.song()
        if s["track"] is not None and not self._scan_track_alive():
            s["track"] = None                    # deleted by hand: a new one for the next device
            if s["job"] is not None:
                self._scan_got(s["job"]["key"], None)
                s["job"] = None
        job = s["job"]
        if job is None:
            if not s["todo"]:
                return self._scan_finish()
            key = s["todo"].pop(0)
            tr = s["track"] or self._scan_track()
            for i in reversed(range(len(tr.devices))):     # leftovers of a device that timed out
                tr.delete_device(i)
            app = Live.Application.get_application()
            song.view.selected_track = tr
            try:
                app.browser.hotswap_target = None
            except Exception:
                pass
            s["job"] = {"key": key, "ticks": 0, "count": -1, "stable": 0}
            try:
                app.browser.load_item(s["found"][key]["item"])
            except Exception as e:
                self.log_message("EventFXHelper: fxscan: can't load %s: %s" % (key, e))
                self._scan_got(key, None)
                s["job"] = None
            return
        job["ticks"] += 1
        tr = s["track"]
        devs = list(tr.devices)
        if devs:
            n = len(devs[0].parameters)
            if n == job["count"]:
                job["stable"] += 1
            else:
                job["count"], job["stable"] = n, 0
            if job["stable"] >= SCAN_STABLE_TICKS[s["found"][job["key"]]["kind"]] or job["ticks"] > SCAN_TIMEOUT_TICKS:
                dev = devs[0]
                params = [[p.name, p.min, p.max, 1 if p.is_quantized else 0] for p in dev.parameters]
                self._scan_got(job["key"], {"device": dev.name, "cls": dev.class_name, "params": params})
                for i in reversed(range(len(devs))):
                    tr.delete_device(i)
                s["job"] = None
            return
        if job["ticks"] > SCAN_TIMEOUT_TICKS:
            self._scan_got(job["key"], None)
            s["job"] = None

    def _scan_got(self, key, result):
        s = self._scan
        for k in s["same"].get(key, [key]):
            s["results"][k] = result if result is not None else {"failed": True}
        s["done"] += 1
        if result is None:
            s["failed"] += 1
        if time.time() - s["t_say"] > 20:
            s["t_say"] = time.time()
            self._scan_say("%d / %d loaded" % (s["done"], s["total"]))

    def _scan_finish(self):
        s = self._scan
        song = self.song()
        if s["track"] is not None and self._scan_track_alive():
            try:
                idx = next(i for i, t in enumerate(song.tracks) if t._live_ptr == s["track"]._live_ptr)
                song.delete_track(idx)
            except Exception as e:
                self.log_message("EventFXHelper: fxscan: can't delete the temporary track: %s" % e)
        if s["sel"] is not None:
            try:
                song.view.selected_track = s["sel"]
            except Exception:
                pass
        items = {}
        for key, e in s["found"].items():
            it = {"name": e["name"], "kind": e["kind"], "class": e["class"], "source": e["source"]}
            if e["kind"] in FX_LOADED:
                r = s["results"].get(key)
                o = s["old"].get(key, {})
                if r is None:                    # not loaded this time: keep what the catalog had
                    r = {k: o[k] for k in ("device", "cls", "params", "failed") if k in o}
                it.update(r)
            items[key] = it
        n_loaded = sum(1 for it in items.values() if it.get("params") is not None)
        n_presets = sum(1 for it in items.values() if it["kind"] == "preset")
        n_failed = sum(1 for it in items.values() if it.get("failed"))
        text = "%d devices and racks, %d presets in the catalog%s%s (%.0f s)" % (
            n_loaded, n_presets, (", %d could not be loaded" % n_failed) if n_failed else "",
            " - stopped early, fxscan loads the rest" if s.get("stopped") else "", time.time() - s["t0"])
        try:
            self._write_catalog({"version": 1, "written": time.strftime("%Y-%m-%d %H:%M:%S"), "items": items})
        except Exception as e:
            if not s["auto"]:
                self._to_tidal_fx("fxscan: can't write %s: %s" % (FX_CATALOG, e), end=True)
            self._scan = None
            return
        auto = s["auto"]
        self._scan = None
        self.log_message("EventFXHelper: fxscan: " + text)
        self._cat_wait = {"t": time.time(), "auto": auto, "text": text}
        self._reply("/catalog", len(items))      # EventFX rewrites toolz-fx.tidal -> /catalogdone
        if auto:
            self._instlist(quiet=True)

    def _catalog_done(self, ok, names):
        w, self._cat_wait = self._cat_wait, None
        if w is None:
            return                               # a second EventFX answering: already reported
        if ok:
            text = "%s; toolz-fx.tidal has %d catalog names - reload: :CheckTidal" % (w["text"], names)
        else:
            text = "%s; EventFX could not write toolz-fx.tidal" % w["text"]
        self._reply("/status", "fxscan: " + text)
        if not w["auto"]:
            self._to_tidal_fx("fxscan: done - " + text, end=True)

    def _reccal(self, ch):
        if self._cals:                      # not to Tidal: its waiting reccal would take this as its result
            return self._reply("/error", "reccal: a calibration is still running - wait for its result")
        if self._link_off("reccal"):
            return self._to_tidal(0, 0.0)
        track = self._track_for_channel(ch)
        if track is None:
            return self._cal_fail("reccal: no track takes MIDI channel %d" % ch)
        slots = list(track.clip_slots)
        index = next((i for i, slot in enumerate(slots) if not slot.has_clip), None)
        if index is None:
            return self._cal_fail("reccal: no empty clip slot on track '%s'" % track.name)
        slot = slots[index]
        armed_here = track.can_be_armed and not track.arm
        if armed_here:
            track.arm = True
        song = self.song()
        if song.record_mode:
            song.record_mode = False
        if not song.is_playing:
            song.start_playing()
        try:
            bar_ok = song.clip_trigger_quantization == Live.Song.Quantization.q_bar
        except Exception:
            bar_ok = True                   # can't tell - measure anyway
        if not bar_ok:
            return self._cal_fail("reccal: set Launch Quantization (top bar) to 1 Bar first")
        try:
            slot.fire(record_length=8.0)
        except Exception:
            return self._cal_fail("reccal: this Live version can't record a fixed length")
        self._cals.append({"slot": slot, "seen": False, "ticks": 0, "track": track.name})
        if armed_here:
            self._arms.append({"slot": slot, "track": track, "seen": False, "ticks": 0})
        self._reply("/status", "reccal: recording 2 bars on track '%s'..." % track.name)

    def _to_tidal(self, ok, ms):
        try:
            self._sock.sendto(osc_encode("/reccal", int(ok), float(ms)), TIDAL)
        except Exception as e:
            self.log_message("EventFXHelper: reccal result to Tidal failed: %s" % e)

    def _cal_fail(self, message):
        self._reply("/error", message)
        self._to_tidal(0, 0.0)

    # start times of the notes with this pitch (reccal plays MIDI note 0, which nothing else uses)
    def _note_starts(self, clip, pitch):
        try:
            notes = [(n.pitch, n.start_time) for n in clip.get_notes_extended(0, 128, 0.0, clip.length)]
        except Exception:
            notes = [(n[0], n[1]) for n in clip.get_notes(0.0, 0, clip.length, 128)]
        # a note already held when the recording starts is written at 0.0 - not a real onset
        return sorted(t for p, t in notes if p == pitch and t > 1e-4), len(notes)

    def _tick_cals(self):
        for c in list(self._cals):
            slot = c["slot"]
            c["ticks"] += 1
            if slot.is_recording:
                c["seen"] = True
                continue
            if not c["seen"]:
                if c["ticks"] > 200:                 # ~20 s and it never started
                    self._cals.remove(c)
                    self._cal_fail("reccal: the recording did not start")
                continue
            self._cals.remove(c)
            if not slot.has_clip:
                return self._cal_fail("reccal: no clip was recorded")
            starts, total = self._note_starts(slot.clip, 0)
            tempo = self.song().tempo
            slot.delete_clip()
            if not starts:
                return self._cal_fail("reccal: no calibration notes (MIDI note 0) arrived (%d other notes) - "
                                   "reload toolz-rec.tidal, is Tidal playing on this channel?" % total)
            # Tidal plays n "0*2": notes belong on every half bar (2 beats); signed offset to the nearest one
            offs = sorted((t - round(t / 2.0) * 2.0) * 60000.0 / tempo for t in starts)
            ms = offs[len(offs) // 2]
            spread = offs[-1] - offs[0]
            if spread > 20.0:
                return self._cal_fail("reccal: calibration notes are %.0f ms apart from each other (%s ms) - "
                                   "timing is unstable, nothing to measure" % (spread, ", ".join("%.0f" % o for o in offs)))
            self._to_tidal(1, ms)
            if abs(ms) < 2.0:
                return self._reply("/status", "reccal: notes land on the beat (%.1f ms, %d notes, spread %.1f ms) - "
                                   "nothing to change" % (ms, len(starts), spread))
            self._reply("/status", "reccal: notes land %.1f ms %s the beat (%d notes, spread %.1f ms, %.1f bpm) - "
                        "Tidal corrects midiShift by %+.4f (see the Tidal window)" % (
                            abs(ms), "after" if ms > 0 else "before", len(starts), spread, tempo, ms / 1000.0))

    def _inchan(self, track_index, ch):
        tracks = list(self.song().tracks)
        if not 0 <= track_index < len(tracks):
            return self._reply("/error", "inchan: no track %d" % track_index)
        track = tracks[track_index]
        want = "Ch. %d" % ch
        for c in track.available_input_routing_channels:
            if c.display_name.strip() == want:
                track.input_routing_channel = c
                return self._reply("/status", "track '%s' now listens to MIDI %s" % (track.name, want))
        self._reply("/error", "inchan: track '%s' has no input channel %s (MIDI From set?)" % (track.name, want))

    def _tick_recordings(self):
        now = self.song().current_song_time
        for r in list(self._recs):
            slot = r["slot"]
            if r["start"] is None:
                if slot.is_recording:
                    r["start"] = now
                continue
            if not slot.is_recording:
                self._recs.remove(r)
            elif now >= r["start"] + r["beats"] - 1.0:    # stop is quantized to the next bar
                slot.fire()
                self._recs.remove(r)

    # ---- browser ----------------------------------------------------------------------
    def _load_paths(self):
        try:
            with open(PATH_CACHE) as f:
                return json.load(f)
        except Exception:
            return {}

    def _save_paths(self):
        try:
            os.makedirs(os.path.dirname(PATH_CACHE), exist_ok=True)
            with open(PATH_CACHE, "w") as f:
                json.dump(self._paths, f, indent=1)
        except Exception as e:
            self.log_message("EventFXHelper: can't save path cache: %s" % e)

    @staticmethod
    def _matches(item, want):
        n = item.name.lower()
        return item.is_loadable and (n == want or (n.rsplit(".", 1)[0] if "." in n else n) == want)

    def _walk(self, path):
        """follow a remembered path; None if the browser changed"""
        b = Live.Application.get_application().browser
        if not hasattr(b, path[0]):
            return None
        item = getattr(b, path[0])
        for name in path[1:]:
            item = next((c for c in item.children if c.name == name), None)
            if item is None:
                return None
        return item

    def _find(self, name, scope="device", cls=""):
        key = (scope, name)
        if key in self._cache:
            return self._cache[key]
        want = name.lower()
        pkey = scope + "|" + name

        path = self._paths.get(pkey)
        if path:
            item = self._walk(path)
            if item is not None and self._matches(item, want):
                self._cache[key] = item
                return item
            del self._paths[pkey]                      # moved or deleted: search again

        b = Live.Application.get_application().browser
        roots = DEVICE_ROOTS if scope == "device" else PRESET_ROOTS.get(cls, PRESET_ROOTS_DEFAULT)
        for root in roots:
            if not hasattr(b, root):
                continue
            queue = [(getattr(b, root), [root])]
            while queue:                               # breadth first within one root
                item, p = queue.pop(0)
                if len(p) > 1 and self._matches(item, want):
                    self._cache[key] = item
                    self._paths[pkey] = p
                    self._save_paths()
                    return item
                # skip: preset files (no children), and a device's presets when looking for a device
                is_file = item.is_loadable and "." in item.name[-6:]
                skip = is_file or (scope == "device" and item.is_loadable and len(p) > 1)
                if len(p) <= SEARCH_DEPTH and not skip:
                    queue.extend((c, p + [c.name]) for c in item.children)
        return None

    # ---- loading ----------------------------------------------------------------------
    def _target(self, job):
        """track, rack (or None), container with .devices for the job"""
        song = self.song()
        tracks = list(song.tracks)
        if job["track"] < 0:
            track = song.view.selected_track
        elif job["track"] < len(tracks):
            track = tracks[job["track"]]
        else:
            raise LoadError("no track %d" % job["track"])
        if job["chain"] < 0:
            return track, None, track
        rack = next((d for d in track.devices if d.can_have_chains), None)
        if rack is None:
            raise LoadError("no rack on track '%s'" % track.name)
        chains = list(rack.chains)
        if job["chain"] >= len(chains):
            raise LoadError("rack has no chain %d" % job["chain"])
        return track, rack, chains[job["chain"]]

    def _start(self, job):
        track, rack, container = self._target(job)
        devices = list(container.devices)
        if not 0 <= job["at"] < len(devices):
            raise LoadError("device %d not there (%d devices)" % (job["at"], len(devices)))
        t0 = time.time()
        item = self._find(job["name"], job["scope"], job["cls"])
        job["search_ms"] = int((time.time() - t0) * 1000)
        if item is None:
            raise LoadError("'%s' not in the browser" % job["name"])

        song = self.song()
        app = Live.Application.get_application()
        if self._saved_track is None:
            self._saved_track = song.view.selected_track
        song.view.selected_track = track
        job["mode_before"] = track.view.device_insert_mode
        if rack is not None:
            rack.view.selected_chain = container
        target = devices[job["at"]]
        song.view.select_device(target)
        if job["swap"]:
            app.browser.hotswap_target = target                 # replace this device
            job["old_ptr"] = target._live_ptr
        else:
            track.view.device_insert_mode = Live.Track.DeviceInsertMode.selected_right   # not at the track's end
        job.update(track_obj=track, container=container, before=len(devices),
                   track_before=len(track.devices), ticks=0, t_load=time.time())
        app.browser.load_item(item)

    def _finish(self, ok, index, message):
        job = self._job
        self._job = None
        try:
            job["track_obj"].view.device_insert_mode = job["mode_before"]
        except Exception:
            pass
        if job["swap"]:
            try:
                Live.Application.get_application().browser.hotswap_target = None
            except Exception:
                pass
        if not ok and not job.get("retried") and ("did not replace" in message or "did not appear" in message):
            # the browser item may be stale (preset file saved again, browser re-indexed):
            # forget it and try once more with a fresh search, before reporting a failure
            self._forget(job["name"], job["scope"])
            job["retried"] = True
            for k in ("ticks", "t_load", "track_obj", "container", "before", "track_before", "old_ptr"):
                job.pop(k, None)
            self._queue.insert(0, job)
            return
        load_ms = int((time.time() - job.get("t_load", time.time())) * 1000)
        if job.get("inst") is not None:
            return self._inst_job_done(job, ok, message)
        self._reply("/loaded", job["id"], 1 if ok else 0, index,
                    "%s (search %d ms, load %d ms)" % (message, job.get("search_ms", 0), load_ms))

    def _forget(self, name, scope):
        self._cache.pop((scope, name), None)
        if self._paths.pop(scope + "|" + name, None) is not None:
            self._save_paths()

    def _class_ok(self, job, dev):
        return not job["cls"] or dev.class_name == job["cls"]

    # a track armed by /record or /reccal is disarmed again once its recording is over
    # (a track that was armed before stays armed)
    def _tick_arms(self):
        for a in list(self._arms):
            a["ticks"] += 1
            try:
                recording = a["slot"].is_recording
            except Exception:
                recording = False           # slot gone (track deleted)
            if recording:
                a["seen"] = True
                continue
            if a["seen"] or a["ticks"] > 600:     # over, or never started within ~60 s
                self._arms.remove(a)
                try:
                    a["track"].arm = False
                except Exception:
                    pass

    def _tick(self):
        if self._recs:
            self._tick_recordings()
        if self._arms:
            self._tick_arms()
        if self._ends:
            self._tick_ends()
        if self._insts:
            self._tick_insts()
        if self._listing is not None:
            self._tick_listing()
        if self._scan is not None:
            self._tick_scan()
        if self._cat_wait is not None and time.time() - self._cat_wait["t"] > 15:
            w, self._cat_wait = self._cat_wait, None
            if not w["auto"]:
                self._to_tidal_fx("fxscan: %s - no EventFX answered, toolz-fx.tidal not rewritten "
                                  "(open a set with EventFX, then click update)" % w["text"], end=True)
        if self._cals:
            self._tick_cals()
        if self._job is not None:
            job = self._job
            job["ticks"] += 1
            devs = list(job["container"].devices)
            if job["swap"]:
                at = job["at"]
                # done when the device at <at> is the preset: Live may keep the same device object
                # and only load the preset into it, so check the name (the preset's) as well
                renamed = at < len(devs) and devs[at].name.lower() == job["name"].lower()
                replaced = at < len(devs) and devs[at]._live_ptr != job["old_ptr"]
                if len(devs) == job["before"] and (renamed or replaced):
                    if self._class_ok(job, devs[at]):
                        self._finish(True, at, devs[at].name)
                    else:
                        self._finish(False, -1, "'%s' is a %s, not a %s" % (job["name"], devs[at].class_name, job["cls"]))
                elif job["ticks"] > LOAD_TIMEOUT_TICKS:
                    self._finish(False, -1, "'%s' did not replace the device" % job["name"])
                return
            if len(devs) == job["before"] + 1:
                index = job["at"] + 1
                dev = devs[index]
                if self._class_ok(job, dev):
                    self._finish(True, index, dev.name)
                else:
                    job["container"].delete_device(index)          # wrong kind of device: undo
                    self._finish(False, -1, "'%s' is a %s, not a %s" % (job["name"], dev.class_name, job["cls"]))
            elif job["container"] is not job["track_obj"] and len(job["track_obj"].devices) > job["track_before"]:
                self._finish(False, -1, "landed on the track, not in the chain - remove it by hand")
            elif job["ticks"] > LOAD_TIMEOUT_TICKS:
                self._finish(False, -1, "'%s' did not appear" % job["name"])
            return
        if self._queue:
            job = self._queue.pop(0)
            try:
                self._start(job)
                self._job = job
            except Exception as e:
                if not job.get("retried") and not isinstance(e, LoadError):
                    self._forget(job["name"], job["scope"])     # stale browser item: search again
                    job["retried"] = True
                    self._queue.insert(0, job)
                elif job.get("inst") is not None:
                    self._inst_job_done(job, False, str(e))
                else:
                    self._reply("/loaded", job["id"], 0, -1, str(e))
        elif self._saved_track is not None:
            self.song().view.selected_track = self._saved_track     # batch done: put the selection back
            self._saved_track = None
            # browser items can go stale between batches (a preset saved again is a new file):
            # keep only the remembered paths, which are walked and checked again next time
            self._cache.clear()
