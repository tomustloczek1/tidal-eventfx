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
#   /find <id> <name>                       -> /found <id> <1|0> <name or reason>
#   /load <id> <track> <chain> <after> <name>
#                                           -> /loaded <id> <1|0> <index of new device or -1> <message>
# Loads are queued and done one at a time; each is verified (device count of the chain grew by 1)
# before the next one starts. Track selection and the insert mode are restored afterwards.

import socket
import struct

import Live
from _Framework.ControlSurface import ControlSurface

VERSION = 1
LISTEN = ("127.0.0.1", 11010)
REPLY = ("127.0.0.1", 11011)
SEARCH_DEPTH = 5            # browser levels searched below each root
LOAD_TIMEOUT_TICKS = 40     # ~4 s (update_display runs about every 100 ms)


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
        self._cache = {}        # browser name -> BrowserItem
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
        if address == "/ping":
            self._reply("/pong", VERSION)
        elif address == "/tracks":
            for i, t in enumerate(self.song().tracks):
                self._reply("/track", i, t.name)
        elif address == "/find":
            job_id, name = args[0], args[1]
            item = self._find(name)
            self._reply("/found", job_id, 1 if item else 0, item.name if item else "not in the browser")
        elif address == "/load":
            job_id, track, chain, after, name = args[:5]
            self._queue.append({"id": job_id, "track": int(track), "chain": int(chain),
                                "after": int(after), "name": name})
        else:
            self._reply("/error", "unknown command " + address)

    # ---- browser ----------------------------------------------------------------------
    def _find(self, name):
        if name in self._cache:
            return self._cache[name]
        b = Live.Application.get_application().browser
        want = name.lower()
        queue = [(r, 0) for r in (b.audio_effects, b.max_for_live, b.plugins, b.instruments, b.user_library)]
        while queue:                                   # breadth first: devices before their presets
            item, depth = queue.pop(0)
            n = item.name.lower()
            base = n.rsplit(".", 1)[0] if "." in n else n
            if item.is_loadable and (n == want or base == want):
                self._cache[name] = item
                return item
            if depth < SEARCH_DEPTH:
                queue.extend((c, depth + 1) for c in item.children)
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
        if not 0 <= job["after"] < len(devices):
            raise LoadError("device %d not there (%d devices)" % (job["after"], len(devices)))
        item = self._find(job["name"])
        if item is None:
            raise LoadError("'%s' not in the browser" % job["name"])

        song = self.song()
        if self._saved_track is None:
            self._saved_track = song.view.selected_track
        song.view.selected_track = track
        modes = Live.Track.DeviceInsertMode
        job["mode_before"] = track.view.device_insert_mode
        track.view.device_insert_mode = modes.selected_right    # default would load at the track's end
        if rack is not None:
            rack.view.selected_chain = container
        song.view.select_device(devices[job["after"]])

        job.update(track_obj=track, container=container, before=len(devices),
                   track_before=len(track.devices), ticks=0)
        Live.Application.get_application().browser.load_item(item)

    def _finish(self, ok, index, message):
        job = self._job
        self._job = None
        try:
            job["track_obj"].view.device_insert_mode = job["mode_before"]
        except Exception:
            pass
        self._reply("/loaded", job["id"], 1 if ok else 0, index, message)

    def _tick(self):
        if self._job is not None:
            job = self._job
            job["ticks"] += 1
            n = len(job["container"].devices)
            if n == job["before"] + 1:
                index = job["after"] + 1
                self._finish(True, index, job["container"].devices[index].name)
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
