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
# scope: "device" (default: Audio Effects, Max for Live, Plug-ins, Instruments, User Library)
#        "preset" (User Library, Sounds, Drums, Instruments - where instrument/rack presets live)
# class: expected class_name of the loaded device; another class is undone and reported
# Loads are queued and done one at a time; each is verified (device count of the chain grew by 1)
# before the next one starts. Track selection and the insert mode are restored afterwards.

import json
import os
import socket
import struct
import time

import Live
from _Framework.ControlSurface import ControlSurface

VERSION = 2
LISTEN = ("127.0.0.1", 11010)
REPLY = ("127.0.0.1", 11011)
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
REPLIES = ("/pong", "/track", "/found", "/loaded", "/status", "/error")


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
        else:
            self._reply("/error", "unknown command " + address)

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
        load_ms = int((time.time() - job.get("t_load", time.time())) * 1000)
        self._reply("/loaded", job["id"], 1 if ok else 0, index,
                    "%s (search %d ms, load %d ms)" % (message, job.get("search_ms", 0), load_ms))

    def _class_ok(self, job, dev):
        return not job["cls"] or dev.class_name == job["cls"]

    def _tick(self):
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
                self._reply("/loaded", job["id"], 0, -1, str(e))
        elif self._saved_track is not None:
            self.song().view.selected_track = self._saved_track     # batch done: put the selection back
            self._saved_track = None
