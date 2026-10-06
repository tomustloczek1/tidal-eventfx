// eventfx.js - EventFX engine
//
// Per-event Live effects for TidalCycles: CCs sent before each note (toMidi in Tidal) are written
// through LiveAPI into the note's own rack chain. The palette (rack chain 1 + effects after the
// rack) is mapped into the FX library ~/.config/tidal/fx-library.json; see NOTES.md.
//
// Inputs (from the main patch):
//   init / reload     - read this track's palette from the library, find the params in all chains
//   update            - scan rack chain 1 + the effects on the track, add new params to the library
//                       (CC per track, resting values), write fx-library.json + toolz-fx.tidal, reload
//                       then mirrors chain 1 into all other chains (devices + values) - see below
//   rest              - current knob positions (chain 1 / track) become the resting values
//   neutral           - every mapped param in every chain back to its resting value
//   chains <n>        - add chains up to n (filled by the mirror); zones + removing chains: by hand
//   channel <n>       - from the 'channel' numbox: re-register this track's number
//   cc <value> <num>  - every incoming CC ([ctlin] -> [pack 0 0] -> [prepend cc])
//   note <pitch> <vel> - every note on / off ([notein] -> [pack 0 0] -> [prepend note])
//   browse 0|1        - 1: no rotation, every note plays in rack chain 1 (auditioning presets
//                       there); afterwards click update so the mirror copies the result
//
// Behaviour:
//   CC 119 (value marker)  -> pick the next rack chain, put the params used by that chain's
//                             previous note back to neutral, switch its devices off; the note's
//                             CCs that follow are written there. Tails of other chains are never touched.
//   CC 118 (selector mark) -> move the Chain Selector to the oldest picked chain; sent shortly
//                             before the note (selLead in Tidal), so dense notes don't move it
//                             away before the previous note has arrived
//   CC of a chain effect   -> written at once into the chosen chain (nothing plays there yet),
//                             its device is switched on
//   CC of a track effect   -> written at once if the track is silent, otherwise at note-on;
//                             track devices switch off after TRACK_OFF_MS unused and silent
//   busy <track> <chain> <0|1> (ChainWatch) -> a chain counts as free only when it is silent AND
//                             holds no note (effects can make a held note silent)
//
// Diagnostics (console, keep off while playing - printing slows down LOM writes):
//   DEBUG_MARKS - every marker / selector move
//   DEBUG_LOAD  - once per second: JS time, LOM writes, messages, routing check
//                 (routing: "missed" / "expected N, started N-1" = selector late -> raise selLead,
//                  "expected N, started N+1" = selector early -> lower selLead)
//
// The track number (= MIDI channel, as in `toMidi 1`) comes from the [live.numbox] with
// scripting name "channel" in the patch.
//
// Outlet 0: status <text>
// Outlet 1: OSC to EventFXHelper ([udpsend 127.0.0.1 11010]); its replies come back as `helper ...`

autowatch = 1;
inlets = 1;
outlets = 2;

// home folder: from where this device lives (/Users/<name>/Music/...), otherwise the account under
// /Users that has ~/.config/tidal/toolz.tidal - so the repo works for anyone. Found at init.
var HOME = null;
var TIDAL_DIR = "", LIB_FILE = "", RULES_FILE = "", TIDAL_FILE = "";
var devicePath = "";

function findHome() {
    if (HOME) { return HOME; }
    try { devicePath = String(this.patcher.filepath); } catch (err) { devicePath = ""; }
    var m = /^(?:[^\/:]+:)?(\/Users\/[^\/]+)/.exec(devicePath);
    if (m) {
        HOME = m[1];
    } else {
        try {
            var dir = new Folder("/Users");
            dir.typelist = [];
            while (!dir.end && !HOME) {
                var n = dir.filename;
                if (n && n.charAt(0) !== ".") {
                    var probe = new File("/Users/" + n + "/.config/tidal/toolz.tidal", "read");
                    if (probe.isopen) { probe.close(); HOME = "/Users/" + n; }
                }
                dir.next();
            }
            dir.close();
        } catch (err2) { }
    }
    if (HOME) {
        TIDAL_DIR = HOME + "/.config/tidal/";
        LIB_FILE = TIDAL_DIR + "fx-library.json";      // FX library: names, CC + resting values per track
        RULES_FILE = TIDAL_DIR + "fx-rules.json";      // which params a device exposes (optional)
        TIDAL_FILE = TIDAL_DIR + "toolz-fx.tidal";     // written by update
    }
    return HOME;
}

function noHome(what) {
    say(what + ": can't find ~/.config/tidal (device path: \"" + devicePath + "\")");
}
var MARK_CC = 119;          // value marker: picks the chain for the next note, its CCs follow
var SEL_CC = 118;           // selector marker: moves the Chain Selector (sent shortly before the note)
var PICK_MAX_AGE = 500;     // ms: a picked chain waiting longer than this for its selector marker is dropped
var ROUTE_MAX_AGE = 300;    // ms: same for the routing check (selector marker -> note-on)
var LEGACY_MS = 2000;       // no selector marker for this long: CC 119 moves the selector itself
                            // (clips recorded before CC 118 existed)
// CC pool per track: 2-117 without data entry (6, 38), bank LSB (32), sustain (64), NRPN/RPN (98-101)
var CC_POOL = (function () {
    var a = [];
    for (var c = 2; c < 118; c++) { if ([6, 32, 38, 64, 98, 99, 100, 101].indexOf(c) < 0) { a.push(c); } }
    return a;
})();
var SENTINEL = 127;         // CC value sent before every real value (real values are 0..126)
var DEBUG_MARKS = false;    // true: log every marker and the selector value
var DEBUG_LOAD = false;     // true: log JS time, LOM writes and routing once per second
var RESERVE_MS = 600;       // a chain picked for an upcoming note stays reserved this long
var TRACK_OFF_MS = 8000;
var MAX_RETRIES = 10;
var RETRY_MS = 1000;

// ---- scan state ----------------------------------------------------------------
var api = null;            // one LiveAPI moved around with goto() while scanning
var rackPath = null;       // LOM path of the rack
var browseMode = false;    // true: every note goes to chain 1 (auditioning presets there)
var wants = {};            // deviceName -> [{param, occ}]
var layouts = {};          // deviceName -> { "param#occ": index }
var calls = 0;
var retries = 0;

// ---- engine state --------------------------------------------------------------
var ready = false;
var params = {};           // cc -> { min, max, neutral, alwaysOn, track, devTrack, chains[], devChains[] }
var nChains = 0;
var selector = null;       // LiveAPI of the rack's Chain Selector
var nextChain = 0;
var target = 0;            // chain that receives the current note's CCs
var held = 0;              // notes currently held on this track
var chainUsed = [];        // per chain: { cc: true } written by its last note
var chainDevOn = [];       // per chain: { deviceOnId: true } switched on by its last note
var trackUsed = {};        // cc -> true, track params written by the last note
var trackPending = null;   // { cc: value } waiting for note-on, or null
var deferredReset = false; // put trackUsed back to neutral at the next note-on
var trackDevOn = {};       // deviceOnId -> last use (ms)
var cache = {};            // id -> LiveAPI, created on first write
var offTask = null;
var trackId = 0;           // this track's LOM id, to filter ChainWatch messages
var busyArr = [];          // per chain: 1 while ChainWatch reports sound
var busySince = [];        // per chain: when it started sounding (ms)
var reservedUntil = [];    // per chain: picked for an upcoming note until (ms)
var pickQueue = [];        // {k, t}: chains picked by value markers, waiting for their selector marker
var routeQueue = [];       // {k, t}: chains the selector was moved to, waiting for their note-on
var lastSelMark = 0;       // when the last CC 118 arrived
var expectChain = -1;      // chain the last note-on should have started, until ChainWatch confirms
var routeOk = 0;           // DEBUG_LOAD routing counters, reset every second
var routeMiss = 0;
var routeWrong = 0;
var routeLast = "";
var loadMs = 0;            // DEBUG_LOAD counters, reset every second
var loadWrites = 0;
var loadMsgs = 0;
var maxBusy = 0;           // most chains sounding at once since the last reload
var chainHeld = [];        // per chain: notes still held there (note-on seen, note-off not yet)
var pitchChain = {};       // pitch -> chain its held note went to

// ---- helpers -------------------------------------------------------------------
function say(msg) {
    post("EventFX: " + msg + "\n");
    outlet(0, "status", msg);
}

function trim(s) {
    return String(s).replace(/^\s+|\s+$/g, "");
}

function go(path) {
    if (!api) { api = new LiveAPI(path); } else { api.goto(path); }
    calls++;
    return api;
}

function nameOf(obj) {
    var v = obj.get("name");
    if (v instanceof Array) { v = v.join(" "); }
    return trim(v);
}

function nameAt(path) {
    return nameOf(go(path));
}

function byId(n) {
    calls++;
    return new LiveAPI("id " + n);
}

function idList(v) {
    var out = [];
    if (!(v instanceof Array)) { return out; }
    for (var i = 0; i < v.length; i++) {
        if (v[i] !== "id") { out.push(Number(v[i])); }
    }
    return out;
}

function now() {
    return new Date().getTime();
}

function write(id, value) {
    if (!id) { return; }
    loadWrites++;
    var o = cache[id];
    if (!o) { o = new LiveAPI("id " + id); cache[id] = o; }
    o.set("value", value);
}

function real(p, v) {
    return p.min + v * (p.max - p.min);
}

// ---- scan (ids of the mapped params in every chain) ----------------------------
function layoutFor(dname, ids) {
    if (layouts[dname]) { return layouts[dname]; }
    var need = {}, left = 0;
    var w = wants[dname] || [];
    for (var i = 0; i < w.length; i++) {
        var key = w[i].param + "#" + w[i].occ;
        if (!need[key]) { need[key] = true; left++; }
    }
    var lay = {}, seen = {};
    for (var p = 0; p < ids.length && left > 0; p++) {
        var pn = nameOf(byId(ids[p]));
        var occ = seen[pn] || 0;
        seen[pn] = occ + 1;
        var k = pn + "#" + occ;
        if (need[k]) { lay[k] = p; need[k] = false; left--; }
    }
    layouts[dname] = lay;
    return lay;
}

function paramsOf(dname, path) {
    var ids = idList(go(path).get("parameters"));
    var out = {};
    if (ids.length) { out["Device On"] = [ids[0]]; }   // parameter 0 is always Device On
    var lay = layoutFor(dname, ids);
    var w = wants[dname] || [];
    for (var i = 0; i < w.length; i++) {
        var idx = lay[w[i].param + "#" + w[i].occ];
        if (idx === undefined) { continue; }
        if (!out[w[i].param]) { out[w[i].param] = []; }
        out[w[i].param][w[i].occ] = ids[idx];
    }
    return out;
}

// returns { devices, chains, selectorId } or null when Live is not ready yet
function scanTrack() {
    var devices = {}, chains = [], selectorId = 0, rackName = null;
    var n = go("this_device canonical_parent").getcount("devices");
    if (!n) { return null; }
    trackId = Number(api.id) || 0;
    var names = [];
    for (var d = 0; d < n; d++) {
        var path = "this_device canonical_parent devices " + d;
        var dname = nameAt(path);
        names.push(dname);

        var canChains = api.get("can_have_chains");
        if (canChains instanceof Array) { canChains = canChains[0]; }
        var nch = Number(canChains) ? api.getcount("chains") : 0;

        if (nch > 0 && !rackName) {
            rackName = dname;
            rackPath = path;
            wants[dname] = [{ param: "Chain Selector", occ: 0 }];
            var rp = paramsOf(dname, path);
            selectorId = (rp["Chain Selector"] && rp["Chain Selector"][0]) || 0;
            for (var c = 0; c < nch; c++) {
                var cpath = path + " chains " + c;
                var cd = {};
                var ncd = go(cpath).getcount("devices");
                for (var i = 0; i < ncd; i++) {
                    var cdpath = cpath + " devices " + i;
                    var cdname = nameAt(cdpath);
                    if (wants[cdname]) { cd[cdname] = paramsOf(cdname, cdpath); }
                }
                chains.push(cd);
            }
            continue;
        }
        if (wants[dname]) { devices[dname] = paramsOf(dname, path); }
    }
    post("EventFX: track " + trackId + " has " + n + " devices: " + names.join(", ") + "\n");
    if (rackName) {
        post("EventFX: rack \"" + rackName + "\" with " + chains.length + " chains\n");
    }
    return { devices: devices, chains: chains, selectorId: selectorId, rackName: rackName };
}

// ---- files ---------------------------------------------------------------------
function readText(path) {
    var f = new File(path, "read");
    if (!f.isopen) { return null; }
    var s = "";
    while (f.position < f.eof) { s += f.readstring(4096); }
    f.close();
    return s;
}

function writeText(path, s) {
    var f = new File(path, "write", "TEXT");
    if (!f.isopen) { return false; }
    for (var i = 0; i < s.length; i += 4096) { f.writestring(s.substr(i, 4096)); }
    f.eof = f.position;
    f.close();
    return true;
}

// null = no file, undefined = broken file (already reported)
function readJson(path) {
    var s = readText(path);
    if (s === null) { return null; }
    try { return JSON.parse(s); } catch (err) { say(path + " is not valid JSON: " + err); return undefined; }
}

// ---- rules (which params a device exposes; fx-rules.json overrides these) -------
var DEFAULT_RULES = {
    maxChain: 4,                 // params per device inside the rack chains (main one included)
    maxTrack: 2,                 // params per device on the track after the rack
    skipDevices: ["EQ Eight", "Glue Compressor", "Limiter", "ChainWatch"],
    alwaysOn: [],                // devices kept on all the time (otherwise on only while a note uses them)
    primaryByDevice: {
        "Gate": "Threshold", "Auto Pan-Tremolo": "Amount", "Erosion": "Amount", "Utility": "Output",
        "HPF": "Frequency", "LPF": "Frequency", "BPF": "Frequency", "Auto Filter": "Frequency",
        "Color Limiter": "Loudness", "Vinyl Distortion": "Tracing Drive", "Filter Delay": "2 Volume"
    },
    primaryCandidates: ["Dry/Wet", "Dry / Wet", "Dry Wet", "DryWet", "Mix",
                        "Amount", "Chance", "Threshold", "Decay", "Output"],
    autoOn: { "BPF": "Dry/Wet" },
    preferByDevice: {
        "Re-Enveloper": ["C/E Fact"], "Gate": ["Release", "Hold", "Floor"],
        "Drum Buss": ["Drive", "Transients", "Boom Amt"],
        "HPF": ["Resonance", "Drive", "Filter Morph"], "LPF": ["Resonance", "Drive", "Filter Morph"],
        "BPF": ["Resonance", "Drive"], "Auto Filter": ["Resonance", "Drive"],
        "Saturator": ["Drive", "Color Freq", "Output"], "Dynamic Tube": ["Drive", "Bias", "Tone"],
        "Overdrive": ["Drive", "Tone", "Filter Freq"], "Erosion": ["Frequency", "Noise Blend", "Filter Width"],
        "Redux": ["Bit Depth", "Sample Rate", "Jitter"], "Color Limiter": ["Saturation", "Color", "Ceiling"],
        "Pitch Hack": ["Coarse", "Reverse", "Recycle"], "Shifter": ["Pitch Coarse", "FShift Coarse", "RM Coarse"],
        "Resonators": ["Frequency", "Decay", "Color"], "Utility": ["Balance", "Stereo Width", "Bass Freq"],
        "Roar": ["Drive"], "Vinyl Distortion": ["Crackle Volume"], "Corpus": ["Transpose"],
        "Spectral Resonator": ["Transpose"], "Grain Delay": ["Pitch"], "Chorus-Ensemble": ["Amount"],
        "Phaser-Flanger": ["Center Freq"], "Auto Pan-Tremolo": ["Frequency"], "Filter Delay": ["2 Feedback"],
        "Gated Delay": ["Feedback"], "Echo": ["Feedback"], "Spectral Time": ["Delay Feedback"],
        "Spectral Blur": ["Halo"]
    },
    // resting position (0 = min, 1 = max) of main params with these names; others: knob position
    neutralPrimary: { "Dry/Wet": 0, "Dry / Wet": 0, "Dry Wet": 0, "DryWet": 0, "Mix": 0,
                      "Amount": 0, "Chance": 0, "Threshold": 0, "Decay": 0 },
    always: ["Gain", "Drive", "Frequency", "Resonance"],
    skipParams: ["Device On"],
    skipQuantized: true,
    reserved: ("delay echo amp gain shape crush coarse cutoff resonance room size dry orbit pan " +
        "legato sustain speed accelerate squiz distort triode krush kcutoff ring lpf hpf bpf " +
        "djf vowel octave detune voice note n s sound cps nudge hold release attack comb smear " +
        "scram binshift hbrick lbrick waveloss freeze real imag enhance partials xsdelay " +
        "tsdelay fshift fshiftnote fshiftphase octer octersub octersubsub ringf ringdf leslie " +
        "lrate lsize phaserrate phaserdepth tremolorate tremolodepth delaytime delayfeedback " +
        "lock cut unit begin end loop channel velocity midichan ccn ccv filter map min max " +
        "div mod id length reverse rev every stut chop striate slice splice fast slow hurry " +
        "range degrade sometimes often rarely always never run scan irand rand choose cycle " +
        "sine square tri saw ply off superimpose layer stack cat fastcat euclid swing ghost " +
        "inside outside arp rolled chunk iter palindrome jux bite chew squeeze ur fix unfix " +
        "sew stitch while mask struct segment toScale scale quantise smooth select wchoose " +
        "randcat degradeBy trunc linger brak shuffle bpm m ccT ccEvent toMidi toMidiWith gate " +
        "fxCC fxOn").split(" ")
};

function readRules() {
    var r = {}, k;
    for (k in DEFAULT_RULES) { r[k] = DEFAULT_RULES[k]; }
    var user = readJson(RULES_FILE);
    if (user) { for (k in user) { if (k.charAt(0) !== "_") { r[k] = user[k]; } } }
    return r;
}

function has(list, x) {
    for (var i = 0; i < list.length; i++) { if (list[i] === x) { return true; } }
    return false;
}

// per-device rule: by the device's own name first, then by the original device name
function rule(table, dev) {
    if (table.hasOwnProperty(dev.name)) { return table[dev.name]; }
    if (table.hasOwnProperty(dev.disp)) { return table[dev.disp]; }
    return undefined;
}

// "Re-Enveloper C/E Fact 1" -> "reEnveloperCEFact1" (same as gen.py)
function camel(s) {
    s = String(s).replace(/[^A-Za-z0-9 ]/g, " ").replace(/[A-Za-z]+/g, function (w) {
        return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    }).replace(/ /g, "");
    s = s.charAt(0).toLowerCase() + s.slice(1);
    return /^[0-9]/.test(s) ? "p" + s : s;
}

function str(v) { return trim((v instanceof Array) ? v.join(" ") : v); }

// ---- palette scan (chain 1 of the rack + effects on the track) -------------------
function chooseParams(dev, rules) {
    var n = go(dev.path).getcount("parameters"), pars = [], counts = {}, i;
    for (i = 0; i < n; i++) {
        go(dev.path + " parameters " + i);
        var pn = nameOf(api);
        pars.push({ index: i, name: pn, occ: counts[pn] || 0, quantized: num(api.get("is_quantized")) === 1 });
        counts[pn] = (counts[pn] || 0) + 1;
    }
    for (i = 0; i < n; i++) {
        pars[i].label = counts[pars[i].name] === 1 ? pars[i].name : pars[i].name + " " + (pars[i].occ + 1);
    }
    function find(name) { for (var j = 0; j < n; j++) { if (pars[j].name === name) { return j; } } return -1; }

    var primary = rule(rules.primaryByDevice, dev), ip = primary ? find(primary) : -1;
    for (i = 0; ip < 0 && i < rules.primaryCandidates.length; i++) { ip = find(rules.primaryCandidates[i]); }
    var auto = rule(rules.autoOn, dev), ia = auto ? find(auto) : -1;
    var prefer = rule(rules.preferByDevice, dev) || [];

    var cand = [];
    for (i = 0; i < n; i++) {
        var q = pars[i];
        if (i === ip || i === ia || has(rules.skipParams, q.name)) { continue; }
        if (rules.skipQuantized && q.quantized) { continue; }
        var pi = -1;
        for (var j = 0; j < prefer.length; j++) { if (prefer[j] === q.name) { pi = j; break; } }
        var group = pi >= 0 ? 0 : (has(rules.always, q.name) ? 1 : 2);
        cand.push({ par: q, key: group * 100000 + (pi >= 0 ? pi : 0) * 1000 + i });
    }
    cand.sort(function (a, b) { return a.key - b.key; });

    var chosen = [];
    if (ip >= 0) { chosen.push({ par: pars[ip], role: "primary" }); }
    if (ia >= 0) { chosen.push({ par: pars[ia], role: "auto" }); }
    var limit = dev.tier === "chain" ? rules.maxChain : rules.maxTrack;
    for (i = 0; i < cand.length && chosen.length < limit; i++) {      // the auto-on param counts too
        chosen.push({ par: cand[i].par, role: "param" });
    }
    chosen.sort(function (a, b) { return a.par.index - b.par.index; });
    return { chosen: chosen, noPrimary: ip < 0 };
}

// -> { entries: [...] } or { error: "..." }
function scanPalette(rules) {
    var tpath = "this_device canonical_parent";
    var nd = go(tpath).getcount("devices"), rack = null, devs = [], d, path;
    for (d = 0; d < nd; d++) {
        path = tpath + " devices " + d;
        go(path);
        var dev = { name: nameOf(api), disp: str(api.get("class_display_name")), path: path, tier: "track" };
        if (num(api.get("can_have_chains")) === 1 && !rack) { rack = path; continue; }
        if (num(api.get("type")) !== 2 || has(rules.skipDevices, dev.name)) { continue; }
        devs.push(dev);
    }
    if (!rack) { return { error: "no rack on this track" }; }
    var cpath = rack + " chains 0", chainDevs = [];
    var nc = go(cpath).getcount("devices");
    for (d = 0; d < nc; d++) {
        path = cpath + " devices " + d;
        go(path);
        var cdev = { name: nameOf(api), disp: str(api.get("class_display_name")), path: path, tier: "chain" };
        if (num(api.get("type")) !== 2 || has(rules.skipDevices, cdev.name)) { continue; }
        chainDevs.push(cdev);
    }
    devs = chainDevs.concat(devs);

    var seenDev = {};
    for (d = 0; d < devs.length; d++) {
        if (seenDev[devs[d].name]) {
            return { error: "two devices named \"" + devs[d].name + "\" - rename one (Cmd+R)" };
        }
        seenDev[devs[d].name] = true;
    }

    var entries = [], names = {}, noPrimary = [];
    for (d = 0; d < devs.length; d++) {
        var dv = devs[d], ch = chooseParams(dv, rules), primaryName = null, pending = [];
        if (ch.noPrimary) { noPrimary.push(dv.name); }
        for (var i = 0; i < ch.chosen.length; i++) {
            var c = ch.chosen[i], pp = dv.path + " parameters " + c.par.index;
            go(pp);
            var e = { role: c.role, device: dv.name, param: c.par.name, occurrence: c.par.occ,
                      key: dv.name + "/" + c.par.label, tier: dv.tier, order: d,
                      min: num(api.get("min")), max: num(api.get("max")), value: num(api.get("value")),
                      quantized: c.par.quantized, alwaysOn: has(rules.alwaysOn, dv.name), tidal: null };
            if (c.role === "auto") {
                e.rest = e.min;
            } else {
                var t = c.role === "primary" ? camel(dv.name) : camel(dv.name + " " + c.par.label);
                if (has(rules.reserved, t)) { t += "A"; }
                if (names[t]) { return { error: "\"" + t + "\" comes from " + e.key + " and " + names[t] + " - rename a device" }; }
                names[t] = e.key;
                e.tidal = t;
                var np = rules.neutralPrimary[c.par.name];
                e.rest = (c.role === "primary" && np !== undefined) ? e.min + np * (e.max - e.min) : e.value;
                if (c.role === "primary") { primaryName = t; }
            }
            pending.push(e);
        }
        for (var k = 0; k < pending.length; k++) {
            if (pending[k].role === "auto") {
                if (!primaryName) { return { error: dv.name + ": auto-on needs a main parameter" }; }
                pending[k].with = primaryName;
            }
            entries.push(pending[k]);
        }
    }
    return { entries: entries, noPrimary: noPrimary };
}

// ---- library -------------------------------------------------------------------
function trackChannel() {
    var box = this.patcher.getnamed("channel");
    var v = box ? Number(box.getvalueof()) : 0;
    return v >= 1 && v <= 16 ? Math.floor(v) : 0;
}

// ---- registry of all EventFX instances (shared by every js in Live) --------------
// Each EventFX writes its track and channel here at load and when the 'channel' box changes;
// update refuses when another track uses the same channel (e.g. a duplicated track).
var REG = new Global("eventfx_registry");
if (!REG.entries) { REG.entries = {}; }
var instanceKey = "efx" + Math.floor(Math.random() * 1e9) + "_" + now();

function register() {
    var t = go("this_device canonical_parent");
    REG.entries[instanceKey] = { track: Number(t.id), channel: trackChannel(), name: nameOf(t) };
}

// js object deleted (device removed, set closed)
function notifydeleted() {
    delete REG.entries[instanceKey];
}

// from the 'channel' numbox: [live.numbox] -> [prepend channel] -> js
function channel(n) {
    if (!ready && !trackId) { return; }       // value restored at load, before the Live API exists
    register();                               // (init registers once Live is ready)
}

// another track's EventFX with this channel -> its track name, or null
function channelClash(ch) {
    register();
    var me = REG.entries[instanceKey].track;
    for (var k in REG.entries) {
        if (k === instanceKey) { continue; }
        var e = REG.entries[k];
        if (e.channel !== ch || e.track === me) { continue; }
        var probe = new LiveAPI("id " + e.track);
        if (!Number(probe.id)) { delete REG.entries[k]; continue; }    // that track is gone
        return nameOf(probe);
    }
    return null;
}

// resting value of a library entry (older entries store a 0..1 position)
function restOf(f) {
    if (f.rest !== undefined) { return f.rest; }
    var pos = f.neutral || 0;
    if (f.log && f.min > 0) { return f.min * Math.pow(f.max / f.min, pos); }
    return f.min + pos * (f.max - f.min);
}

function position(rest, lo, hi) {
    if (hi === lo) { return 0; }
    return Math.min(Math.max((rest - lo) / (hi - lo), 0), 1);
}

// merge a palette scan into the library entry of this track -> report, or { error }
function mergeTrack(lib, ch, entries) {
    var key = String(ch);
    var tr = lib.tracks[key] || (lib.tracks[key] = { fx: {}, on: [] });
    var used = {}, seen = {}, oldOn = {}, added = [], reclaimed = [], warn = [], name, i, t = now();
    for (name in tr.fx) { used[tr.fx[name].cc] = true; tr.fx[name].inPalette = false; }
    for (i = 0; i < entries.length; i++) { if (entries[i].tidal) { seen[entries[i].tidal] = true; } }   // never reclaimed
    for (i = 0; i < tr.on.length; i++) { used[tr.on[i].cc] = true; oldOn[tr.on[i].key || (tr.on[i].device + "/" + tr.on[i].param)] = tr.on[i]; }

    function alloc() {
        for (var j = 0; j < CC_POOL.length; j++) { if (!used[CC_POOL[j]]) { used[CC_POOL[j]] = true; return CC_POOL[j]; } }
        var best = null;                  // pool full: take the CC of the param unused longest
        for (var n in tr.fx) {
            var f = tr.fx[n];
            if (f.inPalette === false && !seen[n] && (best === null || (f.lastSeen || 0) < (tr.fx[best].lastSeen || 0))) { best = n; }
        }
        if (best === null) { return 0; }
        var cc = tr.fx[best].cc;
        reclaimed.push(best + " (CC " + cc + ")");
        delete tr.fx[best];
        return cc;
    }

    var on = [];
    for (i = 0; i < entries.length; i++) {
        var e = entries[i];
        if (e.role === "auto") {
            var o = oldOn[e.key], occ = o ? o.cc : alloc();
            if (!occ) { return { error: "CC pool of track " + ch + " is full" }; }
            on.push({ "with": e["with"], key: e.key, cc: occ, value: 1, device: e.device, param: e.param,
                      occurrence: e.occurrence, order: e.order, min: e.min, max: e.max, alwaysOn: e.alwaysOn });
            continue;
        }
        var f = tr.fx[e.tidal];
        if (!f) {
            var cc = alloc();
            if (!cc) { return { error: "CC pool of track " + ch + " is full" }; }
            f = tr.fx[e.tidal] = { cc: cc, rest: e.rest };
            added.push(e.tidal + " (CC " + cc + ")");
        } else {
            f.rest = restOf(f);
            delete f.neutral; delete f.log; delete f.always_on;
        }
        f.device = e.device; f.param = e.param; f.occurrence = e.occurrence; f.tier = e.tier;
        f.order = e.order; f.primary = e.role === "primary"; f.min = e.min; f.max = e.max;
        f.quantized = e.quantized; f.alwaysOn = e.alwaysOn; f.inPalette = true; f.lastSeen = t;

        var lp = lib.params[e.tidal];
        if (!lp) {
            lib.params[e.tidal] = { device: e.device, param: e.param, occurrence: e.occurrence };
        } else if (lp.device !== e.device || lp.param !== e.param) {
            warn.push(e.tidal + " is " + lp.device + "/" + lp.param + " elsewhere");
        }
    }
    tr.on = on;
    var dormant = [];
    for (name in tr.fx) { if (tr.fx[name].inPalette === false) { dormant.push(name); } }
    return { added: added, reclaimed: reclaimed, dormant: dormant, warn: warn };
}

// map entries for the engine, from the library entry of this track (null = none)
function libraryEntries(lib, ch, rules) {
    var tr = lib && lib.tracks && lib.tracks[String(ch)];
    if (!tr) { return null; }
    var out = [], name, i;
    for (name in tr.fx) {
        var f = tr.fx[name];
        if (f.inPalette === false) { continue; }
        var lp = lib.params[name] || {};
        var dev = f.device || lp.device, par = f.param || lp.param;
        var occ = f.occurrence !== undefined ? f.occurrence : (lp.occurrence || 0);
        var aOn = f.alwaysOn !== undefined ? f.alwaysOn : (f.always_on !== undefined ? f.always_on : has(rules.alwaysOn, dev));
        out.push({ cc: f.cc, device: dev, param: par, occurrence: occ, min: f.min, max: f.max,
                   neutral: position(restOf(f), f.min, f.max), always_on: aOn, key: dev + "/" + par, tidal: name });
    }
    for (i = 0; i < tr.on.length; i++) {
        var o = tr.on[i];
        out.push({ cc: o.cc, device: o.device, param: o.param, occurrence: o.occurrence || 0,
                   min: o.min, max: o.max, neutral: 0,
                   always_on: o.alwaysOn !== undefined ? o.alwaysOn : has(rules.alwaysOn, o.device),
                   key: o.device + "/" + o.param, tidal: null });
    }
    return out;
}

// ---- toolz-fx.tidal ------------------------------------------------------------
function pad(s, w) { s = String(s); while (s.length < w) { s += " "; } return s; }

function writeTidal(lib) {
    var tracks = [], t, name, i, j;
    for (t in lib.tracks) { tracks.push(Number(t)); }
    tracks.sort(function (a, b) { return a - b; });

    var order = {}, w = 10, names = [];
    for (i = 0; i < tracks.length; i++) {
        var fx = lib.tracks[tracks[i]].fx;
        for (name in fx) {
            if (fx[name].inPalette !== false && order[name] === undefined) {
                order[name] = tracks[i] * 1000 + (fx[name].order || 0) * 2 + (fx[name].primary ? 0 : 1);
            }
        }
    }
    for (name in lib.params) { names.push(name); if (name.length + 1 > w) { w = name.length + 1; } }
    names.sort(function (a, b) {
        var oa = order[a] !== undefined ? order[a] : 1e9, ob = order[b] !== undefined ? order[b] : 1e9;
        if (oa !== ob) { return oa - ob; }
        var da = lib.params[a].device, db = lib.params[b].device;
        return da < db ? -1 : da > db ? 1 : (a < b ? -1 : a > b ? 1 : 0);
    });

    var counts = [];
    for (i = 0; i < tracks.length; i++) {
        var nIn = 0, fxs = lib.tracks[tracks[i]].fx;
        for (name in fxs) { if (fxs[name].inPalette !== false) { nIn++; } }
        counts.push("t" + tracks[i] + ": " + nIn);
    }
    var out = ["-- toolz-fx.tidal - GENERATED by EventFX (update), do not edit",
               "-- " + names.length + " FX params in the library; in the palettes: " + counts.join(", "),
               "-- usage: d1 $ toMidi 1 $ n \"0 3\" # redux \"0 1\" # lpfA 0.4   (1 = track / MIDI channel)",
               "-- a param that is not in the track's palette is ignored on that track", ""];
    var last = null;
    for (i = 0; i < names.length; i++) {
        name = names[i];
        var lp = lib.params[name], where = [];
        for (j = 0; j < tracks.length; j++) {
            var f = lib.tracks[tracks[j]].fx[name];
            if (f && f.inPalette !== false) { where.push("t" + tracks[j] + " CC " + f.cc); }
        }
        if (lp.device !== last) { out.push(""); out.push("-- " + lp.device); last = lp.device; }
        out.push(pad(name, w) + "= pF \"" + name + "\"   -- " + lp.param +
                 (where.length ? "  [" + where.join(", ") + "]" : "  [not in a palette]"));
    }

    out.push("", ":{", "-- per track (MIDI channel): FX param -> CC",
             "fxCC :: Map.Map Int (Map.Map String Double)", "fxCC = Map.fromList");
    for (i = 0; i < tracks.length; i++) {
        var pairs = [], fx2 = lib.tracks[tracks[i]].fx;
        for (name in fx2) { if (fx2[name].inPalette !== false) { pairs.push([name, fx2[name].cc]); } }
        pairs.sort(function (a, b) { return a[1] - b[1]; });
        out.push("  " + (i ? "," : "[") + " (" + tracks[i] + ", Map.fromList");
        for (j = 0; j < pairs.length; j++) {
            out.push("      " + (j ? "," : "[") + " (\"" + pairs[j][0] + "\", " + pairs[j][1] + ")");
        }
        out.push(pairs.length ? "      ])" : "      [])");
    }
    out.push(tracks.length ? "  ]" : "  []");

    out.push("", "-- per track: FX param -> CCs switched on with it (cc, value 0..1)",
             "fxOn :: Map.Map Int (Map.Map String [(Double, Double)])", "fxOn = Map.fromList");
    for (i = 0; i < tracks.length; i++) {
        var groups = {}, keys = [], on = lib.tracks[tracks[i]].on;
        for (j = 0; j < on.length; j++) {
            var wn = on[j]["with"];
            if (!groups[wn]) { groups[wn] = []; keys.push(wn); }
            groups[wn].push("(" + on[j].cc + ", " + on[j].value + ")");
        }
        keys.sort();
        out.push("  " + (i ? "," : "[") + " (" + tracks[i] + ", Map.fromList");
        for (j = 0; j < keys.length; j++) {
            out.push("      " + (j ? "," : "[") + " (\"" + keys[j] + "\", [" + groups[keys[j]].join(", ") + "])");
        }
        out.push(keys.length ? "      ])" : "      [])");
    }
    out.push(tracks.length ? "  ]" : "  []");
    out.push("", "toMidi :: Pattern Double -> ControlPattern -> ControlPattern",
             "toMidi = toMidiWith fxCC fxOn", ":}", "");
    return writeText(TIDAL_FILE, out.join("\n"));
}

// ---- mirror: chains 2..N follow chain 1 (structure + values) ----------------------
// Native devices are inserted through the LOM, Max devices / plug-ins (and ChainWatch) through
// EventFXHelper (Remote Script, OSC over [udpsend] / [udpreceive] -> [prepend helper]).
var HELPER_TIMEOUT_MS = 8000;
var mirror = null;          // state while mirroring
var helperSeq = 0;

function isNative(d) { return d.cls.indexOf("Mx") !== 0 && d.cls.indexOf("Plugin") < 0; }
function sameDev(a, b) { return a.name === b.name && a.cls === b.cls; }

function findRack() {
    var tpath = "this_device canonical_parent", n = go(tpath).getcount("devices");
    for (var d = 0; d < n; d++) {
        var p = tpath + " devices " + d;
        if (num(go(p).get("can_have_chains")) === 1) { return p; }
    }
    return null;
}

function trackIndex() {
    var m = /tracks (\d+)/.exec(String(go("this_device canonical_parent").path));
    return m ? Number(m[1]) : -1;
}

function chainDevices(k) {
    var cpath = mirror.rack + " chains " + k, n = go(cpath).getcount("devices"), out = [];
    for (var i = 0; i < n; i++) {
        go(cpath + " devices " + i);
        out.push({ name: nameOf(api), cls: str(api.get("class_name")), disp: str(api.get("class_display_name")) });
    }
    return out;
}

function laterIn(x, list, from) {
    for (var q = from; q < list.length; q++) { if (sameDev(x, list[q])) { return true; } }
    return false;
}

// first change that brings `cur` closer to template `tpl`, or null when they match
function nextOp(tpl, cur) {
    var i = 0, j = 0;
    while (i < tpl.length && j < cur.length && sameDev(tpl[i], cur[j])) { i++; j++; }
    if (i === tpl.length && j === cur.length) { return null; }
    if (j < cur.length && i < tpl.length) {
        // missing device in this chain: the current one comes later in the template
        if (laterIn(cur[j], tpl, i + 1) && !laterIn(tpl[i], cur, j + 1)) { return { type: "insert", t: i, index: j }; }
        return { type: "delete", index: j };
    }
    if (j < cur.length) { return { type: "delete", index: j }; }    // extra devices at the end
    return { type: "insert", t: i, index: j };                      // template longer: append
}

// values for every device of the template: mapped params -> resting value, others -> chain 1
function templateValues(tpl, rest) {
    var vals = [];
    for (var d = 0; d < tpl.length; d++) {
        var base = mirror.rack + " chains 0 devices " + d, n = go(base).getcount("parameters"), v = [], counts = {};
        for (var p = 0; p < n; p++) {
            go(base + " parameters " + p);
            var pn = nameOf(api), occ = counts[pn] || 0;
            counts[pn] = occ + 1;
            var key = tpl[d].name + "/" + pn + "#" + occ;
            v.push(rest.hasOwnProperty(key) ? rest[key] : num(api.get("value")));
        }
        vals.push(v);
    }
    return vals;
}

// equal within 0.2% of the parameter's range (Live snaps stepped params, e.g. Redux Bit Depth)
function differs(a, b, span) { return Math.abs(a - b) > Math.max(0.002 * span, 1e-6); }

function syncValues(k) {
    var M = mirror;
    for (var d = 0; d < M.tpl.length; d++) {
        var base = M.rack + " chains " + k + " devices " + d, v = M.vals[d];
        for (var p = 1; p < v.length; p++) {                  // parameter 0 = Device On: EventFX's job
            go(base + " parameters " + p);
            var cur = num(api.get("value"));
            if (Math.abs(cur - v[p]) <= 1e-6) { continue; }
            var span = Math.abs(num(api.get("max")) - num(api.get("min")));
            if (!differs(cur, v[p], span)) { continue; }
            try { api.set("value", v[p]); } catch (err) { }
            if (differs(num(api.get("value")), v[p], span)) {  // Live kept its own value
                M.refused++;
                if (M.refusedNames.length < 8) { M.refusedNames.push("chain " + (k + 1) + " " + M.tpl[d].name + "/" + nameOf(api)); }
            } else {
                M.writes++;
            }
        }
    }
}

// rest: { "Device/Param#occ": value } for the mapped params of this track
function startMirror(rest, onDone) {
    var rack = findRack();
    if (!rack) { onDone("no rack"); return; }
    mirror = { rack: rack, track: trackIndex(), k: 0, n: go(rack).getcount("chains"), onDone: onDone,
               inserted: 0, deleted: 0, loaded: 0, writes: 0, failed: [], waitId: 0, timer: null, ops: 0, refused: 0, refusedNames: [], t0: now() };
    mirror.tpl = chainDevices(0);
    var last = mirror.tpl[mirror.tpl.length - 1];
    if (!last || last.name !== "ChainWatch") {
        mirror = null;
        onDone("chain 1 must end with ChainWatch");
        return;
    }
    mirror.vals = templateValues(mirror.tpl, rest);
    mirrorStep();
}

function mirrorStep() {
    var M = mirror;
    while (M && M.k < M.n) {
        var cpath = M.rack + " chains " + M.k;
        var op = nextOp(M.tpl, chainDevices(M.k));
        if (!op) { syncValues(M.k); M.k++; M.ops = 0; continue; }
        if (++M.ops > 3 * M.tpl.length + 20) {        // a device that never ends up matching (renamed?)
            M.failed.push("chain " + (M.k + 1) + ": does not converge, check device names");
            M.k++; M.ops = 0;
            continue;
        }

        if (op.type === "delete") {
            go(cpath).call("delete_device", op.index);
            M.deleted++;
            continue;
        }
        var d = M.tpl[op.t], before = go(cpath).getcount("devices");
        if (isNative(d)) {
            go(cpath).call("insert_device", d.disp, op.index);
            if (go(cpath).getcount("devices") !== before + 1) {
                M.failed.push("chain " + (M.k + 1) + ": Live refused " + d.disp + " at " + op.index);
                M.k++;
                continue;
            }
            if (d.name !== d.disp) { go(cpath + " devices " + op.index).set("name", d.name); }
            M.inserted++;
            continue;
        }
        if (op.index === 0) {
            M.failed.push("chain " + (M.k + 1) + ": " + d.name + " can't be loaded as the first device");
            M.k++;
            continue;
        }
        M.waitId = ++helperSeq;
        outlet(1, "/load", M.waitId, M.track, M.k, op.index - 1, d.name);
        var id = M.waitId;
        M.timer = new Task(function () {
            if (mirror && mirror.waitId === id) { endMirror("EventFXHelper did not answer - is it set as Control Surface?"); }
        }, this);
        M.timer.schedule(HELPER_TIMEOUT_MS);
        return;                                   // continues in helper() when the device is there
    }
    if (M) { endMirror(null); }
}

function endMirror(error) {
    var M = mirror;
    mirror = null;
    if (M.timer) { M.timer.cancel(); }
    var rep = M.inserted + " inserted, " + M.loaded + " loaded by the helper, " + M.deleted + " deleted, " +
              M.writes + " values set" + (M.refused ? ", " + M.refused + " refused" : "") + " in " + (now() - M.t0) + " ms";
    if (M.refused) { post("EventFX: values Live did not take (first ones): " + M.refusedNames.join(", ") + "\n"); }
    if (M.failed.length) { post("EventFX: mirror problems: " + M.failed.join("; ") + "\n"); }
    M.onDone(error, rep, M.failed.length);
}

// replies from EventFXHelper: helper /loaded <id> <ok> <index> <message...>
function helper() {
    var a = arrayfromargs(arguments), addr = a[0];
    if (addr !== "/loaded") {
        if (addr === "/status" || addr === "/error") { post("EventFX: helper " + a.slice(1).join(" ") + "\n"); }
        return;
    }
    if (!mirror || a[1] !== mirror.waitId) { return; }
    mirror.waitId = 0;
    if (mirror.timer) { mirror.timer.cancel(); mirror.timer = null; }
    if (a[2]) {
        mirror.loaded++;
    } else {
        mirror.failed.push("chain " + (mirror.k + 1) + ": " + a.slice(4).join(" "));
        mirror.k++; mirror.ops = 0;               // skip this chain, go on with the next
    }
    mirrorStep();
}

// ---- commands: update / rest / neutral ------------------------------------------
// update: chain 1 + track effects -> library (names, CC per track, resting values) -> files -> rebuild
function update(note) {
    if (!findHome()) { noHome("update"); return; }
    if (held > 0) { say("update: notes are playing - stop first"); return; }
    if (mirror) { say("update: still mirroring - wait"); return; }
    var t0 = now();
    calls = 0; api = null;
    var ch = trackChannel();
    if (!ch) { say("update: set the track number (1-16) in the 'channel' box first"); return; }
    var clash = channelClash(ch);
    if (clash) { say("update: track \"" + clash + "\" also uses channel " + ch + " - give this track its own number"); return; }
    var rules = readRules();
    var lib = readJson(LIB_FILE);
    if (lib === undefined) { return; }
    if (lib === null) { lib = { version: 1, params: {}, tracks: {} }; }

    var scan = scanPalette(rules);
    if (scan.error) { say("update: " + scan.error); return; }
    var rep = mergeTrack(lib, ch, scan.entries);
    if (rep.error) { say("update: " + rep.error); return; }

    if (!writeText(LIB_FILE, JSON.stringify(lib, null, 2) + "\n")) { say("update: cannot write " + LIB_FILE); return; }
    if (!writeTidal(lib)) { say("update: cannot write " + TIDAL_FILE); return; }

    var n = 0;
    for (var i = 0; i < scan.entries.length; i++) { if (scan.entries[i].tidal) { n++; } }
    if (rep.added.length) { post("EventFX: new: " + rep.added.join(", ") + "\n"); }
    if (rep.dormant.length) { post("EventFX: not in the palette any more (kept in the library): " + rep.dormant.join(", ") + "\n"); }
    if (rep.reclaimed.length) { post("EventFX: CC pool full, CC taken from: " + rep.reclaimed.join(", ") + "\n"); }
    if (rep.warn.length) { post("EventFX: same name, other param: " + rep.warn.join("; ") + "\n"); }
    if (scan.noPrimary.length) { post("EventFX: no main param found in: " + scan.noPrimary.join(", ") + " - add it to primaryByDevice in fx-rules.json\n"); }
    post("EventFX: now in Tidal: :script ~/.config/tidal/toolz-fx.tidal\n");
    var msg = "update: track " + ch + ": " + n + " params (" + rep.added.length + " new, " +
              rep.dormant.length + " dormant)";

    // resting values of the mapped chain params, for the mirror
    var tr = lib.tracks[String(ch)], restMap = {};
    for (i = 0; i < scan.entries.length; i++) {
        var e = scan.entries[i];
        if (e.tier !== "chain") { continue; }
        var f = e.tidal ? tr.fx[e.tidal] : null;
        restMap[e.device + "/" + e.param + "#" + e.occurrence] = f ? restOf(f) : e.min;
    }
    ready = false;                               // no CC handling while the chains change
    say(msg + " - mirroring chains...");
    startMirror(restMap, function (error, report, problems) {
        build();
        if (error) { say(msg + ", mirror stopped: " + error); return; }
        say(msg + "; mirror: " + report + (problems ? " - " + problems + " problems, see console" : "") +
            " (" + (now() - t0) + " ms)");
        if (typeof note === "string" && note) { say(note); }
    });
}

// chains N: add chains at the end of the rack up to N, then update (the mirror fills them,
// ChainWatch included). Removing chains and setting Chain Select zones stay manual.
function chains(n) {
    n = Math.floor(Number(n));
    if (held > 0) { say("chains: notes are playing - stop first"); return; }
    if (mirror) { say("chains: still mirroring - wait"); return; }
    if (!(n >= 1 && n <= 64)) { say("chains: usage 'chains 20'"); return; }
    calls = 0; api = null;
    var rack = findRack();
    if (!rack) { say("chains: no rack on this track"); return; }
    var have = go(rack).getcount("chains");
    if (n < have) {
        say("chains: the rack has " + have + " - delete chains " + (n + 1) + "-" + have + " by hand, then click update");
        return;
    }
    for (var k = have; k < n; k++) {
        go(rack).call("insert_chain");
        if (go(rack).getcount("chains") !== k + 1) { say("chains: Live refused to add chain " + (k + 1)); n = k; break; }
        try { go(rack + " chains " + k).set("name", String(k + 1)); } catch (err) { }
    }
    if (n === have) { update(); return; }
    var zones = [];
    for (var z = have; z < n; z++) { zones.push((z + 1) + " -> " + z); }
    update("set the Chain Select zone of the new chains by hand BEFORE playing (chain -> value): " +
           zones.join(", "));
}

// rest: the current knob positions in chain 1 / on the track become the resting values
// (click [neutral] first, then turn the knobs you want to change, then [rest]);
// main params listed in neutralPrimary (Dry/Wet, Amount...) keep their fixed resting value
function rest() {
    if (!findHome()) { noHome("rest"); return; }
    if (held > 0) { say("rest: notes are playing - stop first"); return; }
    var ch = trackChannel(), rules = readRules(), lib = readJson(LIB_FILE);
    if (!ch || !lib || !lib.tracks[String(ch)]) { say("rest: no palette for this track - click update"); return; }
    calls = 0; api = null;
    var scan = scanPalette(rules);
    if (scan.error) { say("rest: " + scan.error); return; }
    var tr = lib.tracks[String(ch)], changed = 0;
    for (var i = 0; i < scan.entries.length; i++) {
        var e = scan.entries[i], f = e.tidal ? tr.fx[e.tidal] : null;
        if (!f) { continue; }
        if (e.role === "primary" && rules.neutralPrimary[e.param] !== undefined) { continue; }   // Dry/Wet etc. stay 0
        if (restOf(f) !== e.value) { changed++; }
        f.rest = e.value;
        delete f.neutral; delete f.log;
    }
    if (!writeText(LIB_FILE, JSON.stringify(lib, null, 2) + "\n")) { say("rest: cannot write " + LIB_FILE); return; }
    build();
    neutral();                                   // new resting values into every chain right away
    say("rest: " + changed + " resting values changed, all chains set");
}

// neutral: every mapped param in every chain and on the track back to its resting value
function neutral() {
    if (!ready) { say("neutral: not ready - click reload"); return; }
    var n = 0;
    for (var c in params) {
        var p = params[c], v = real(p, p.neutral);
        if (p.track) { write(p.track, v); n++; }
        for (var k = 0; k < p.chains.length; k++) { if (p.chains[k]) { write(p.chains[k], v); n++; } }
    }
    for (var k2 = 0; k2 < nChains; k2++) { chainUsed[k2] = {}; }
    trackUsed = {};
    say("neutral: " + n + " params back to rest");
}

// ---- build ---------------------------------------------------------------------
function init() { retries = 0; build(); }
function reload() { retries = 0; build(); }

function retryLater(why) {
    if (retries >= MAX_RETRIES) {
        say(why + " - gave up after " + MAX_RETRIES + " tries, click reload");
        return;
    }
    retries++;
    say(why + " - retry " + retries + "/" + MAX_RETRIES + " in " + RETRY_MS + " ms");
    var t = new Task(function () { build(); }, this);
    t.schedule(RETRY_MS);
}

// ---- browse mode -----------------------------------------------------------------
function num(v) {
    if (v instanceof Array) { v = v[0]; }
    return Number(v);
}

function browse(on) {
    browseMode = !!on;
    pickQueue = []; routeQueue = []; expectChain = -1;
    if (browseMode && selector) { selector.set("value", 0); }
    say(browseMode ? "browse ON: all notes play in chain 1 - hot-swap presets there, then update"
                   : "browse OFF: chain rotation back on");
}

function build() {
    var t0 = now();
    ready = false;
    calls = 0;
    layouts = {};
    wants = {};
    api = null;
    cache = {};

    if (!findHome()) { noHome("init"); return; }
    var ch = trackChannel();
    if (!ch) { say("set the track number (1-16) in the 'channel' box, then click update"); return; }
    var lib = readJson(LIB_FILE);
    if (lib === undefined) { return; }
    var entries = libraryEntries(lib, ch, readRules());
    if (!entries) { say("no palette for track " + ch + " in the library - click update"); return; }
    var map = { params: entries };
    for (var m = 0; m < map.params.length; m++) {
        var em = map.params[m];
        var dn = trim(em.device);
        if (!wants[dn]) { wants[dn] = []; }
        wants[dn].push({ param: trim(em.param), occ: em.occurrence || 0 });
    }

    rackPath = null;
    var scan = scanTrack();
    if (scan === null) { retryLater("track not ready"); return; }

    register();
    nChains = scan.chains.length;
    selector = scan.selectorId ? new LiveAPI("id " + scan.selectorId) : null;

    params = {};
    var onTrack = 0, inChains = 0, missing = [], alwaysOnIds = {}, autoIds = {};
    for (var i = 0; i < map.params.length; i++) {
        var e = map.params[i];
        var dname = trim(e.device), pname = trim(e.param), occ = e.occurrence || 0;
        var p = { min: e.min, max: e.max, neutral: e.neutral, alwaysOn: !!e.always_on,
                  track: 0, devTrack: 0, chains: [], devChains: [] };

        var dev = scan.devices[dname];
        if (dev && dev[pname] && dev[pname][occ]) {
            p.track = dev[pname][occ];
            p.devTrack = (dev["Device On"] && dev["Device On"][0]) || 0;
            onTrack++;
        } else {
            for (var c = 0; c < nChains; c++) {
                var cdev = scan.chains[c][dname];
                if (cdev && cdev[pname] && cdev[pname][occ]) {
                    p.chains[c] = cdev[pname][occ];
                    p.devChains[c] = (cdev["Device On"] && cdev["Device On"][0]) || 0;
                }
            }
            if (p.chains.length) { inChains++; }
        }
        if (!p.track && !p.chains.length) { missing.push(e.key); continue; }

        // collect device on/off ids
        var ons = p.track ? [p.devTrack] : p.devChains;
        for (var k = 0; k < ons.length; k++) {
            if (!ons[k]) { continue; }
            if (p.alwaysOn) { alwaysOnIds[ons[k]] = true; } else { autoIds[ons[k]] = true; }
        }
        params[e.cc] = p;
    }

    // a rack is expected but not found yet -> Live is probably still loading
    if (!scan.rackName && missing.length && retries < MAX_RETRIES) {
        retryLater("rack not found yet");
        return;
    }

    // start state: always-on devices on, all others off, first chain selected
    for (var a in alwaysOnIds) { write(Number(a), 1); }
    for (var b in autoIds) { write(Number(b), 0); }
    chainUsed = []; chainDevOn = []; busyArr = []; busySince = []; reservedUntil = [];
    chainHeld = []; pitchChain = {};
    pickQueue = []; routeQueue = []; expectChain = -1;
    for (var c2 = 0; c2 < nChains; c2++) {
        chainUsed.push({}); chainDevOn.push({});
        busyArr.push(0); busySince.push(0); reservedUntil.push(0); chainHeld.push(0);
    }
    maxBusy = 0;
    nextChain = 0; target = 0; held = 0;
    trackUsed = {}; trackPending = null; deferredReset = false; trackDevOn = {};
    if (selector) { selector.set("value", 0); }

    if (!offTask) {
        offTask = new Task(trackOffTick, this);
        offTask.interval = 1000;
        offTask.repeat();
    }

    if (missing.length) {
        post("EventFX: not found (skipped): " + missing.join(", ") + "\n");
    }
    var nAuto = 0, nOn = 0;
    for (var x in autoIds) { nAuto++; }
    for (var y in alwaysOnIds) { nOn++; }
    ready = true;
    say(onTrack + " track params, " + inChains + " chain params x " + nChains + " chains, " +
        missing.length + " skipped, " + nAuto + " auto on/off, " + nOn + " always on (" +
        calls + " LOM calls, " + (now() - t0) + " ms)");
}

// ---- engine --------------------------------------------------------------------
function resetTrackUsed(except) {
    for (var c in trackUsed) {
        if (except && except.hasOwnProperty(c)) { continue; }
        var p = params[c];
        if (p) { write(p.track, real(p, p.neutral)); }
    }
    trackUsed = {};
}

function touchTrackDevice(p) {
    if (!p.devTrack || p.alwaysOn) { return; }
    if (!trackDevOn.hasOwnProperty(p.devTrack)) { write(p.devTrack, 1); }
    trackDevOn[p.devTrack] = now();
}

// next chain that is free: silent, no held note, not reserved;
// if none, a chain with only a tail left (no held note), the one sounding longest
function pickChain() {
    var t = now(), best = -1, i, k, oldest;
    for (i = 0; i < nChains; i++) {
        k = (nextChain + i) % nChains;
        if (!busyArr[k] && !chainHeld[k] && reservedUntil[k] < t) { best = k; break; }
    }
    if (best < 0) {
        oldest = Infinity;
        for (k = 0; k < nChains; k++) {
            if (reservedUntil[k] < t && !chainHeld[k] && busySince[k] < oldest) { oldest = busySince[k]; best = k; }
        }
    }
    if (best < 0) {   // every chain holds a note: steal the one sounding longest
        oldest = Infinity;
        for (k = 0; k < nChains; k++) {
            if (reservedUntil[k] < t && busySince[k] < oldest) { oldest = busySince[k]; best = k; }
        }
    }
    if (best < 0) { best = nextChain; }
    nextChain = (best + 1) % nChains;
    reservedUntil[best] = t + RESERVE_MS;
    return best;
}

// params written by the chain's last note back to neutral, its devices off
function resetChain(k) {
    for (var c in chainUsed[k]) {
        var p = params[c];
        if (p) { write(p.chains[k], real(p, p.neutral)); }
    }
    chainUsed[k] = {};
    for (var d in chainDevOn[k]) { write(Number(d), 0); }
    chainDevOn[k] = {};
}

function busyBody(track, chain, state) {
    if (!ready || Number(track) !== trackId || chain < 0 || chain >= nChains) { return; }
    var t = now();
    if (state) {
        if (expectChain >= 0) {
            if (chain === expectChain) {
                routeOk++;
                expectChain = -1;
            } else {
                routeWrong++;
                routeLast = "expected chain " + expectChain + ", started " + chain;
            }
        }
        busyArr[chain] = 1;
        busySince[chain] = t;
        reservedUntil[chain] = 0;
        var n = 0;
        for (var i = 0; i < nChains; i++) { n += busyArr[i]; }
        if (n > maxBusy) {
            maxBusy = n;
            post("EventFX: " + maxBusy + " of " + nChains + " chains sounding at once (new max)\n");
        }
    } else {
        busyArr[chain] = 0;
        if (chainHeld[chain]) {
            // quiet but a note is still held (e.g. crushed / gated to silence): keep its FX
            if (DEBUG_MARKS) { post("EventFX: chain " + chain + " silent but holds a note - kept\n"); }
        } else if (reservedUntil[chain] < t) {
            resetChain(chain);                // not waiting for a new note
        }
    }
}

function takeFresh(queue, maxAge) {
    var t = now();
    while (queue.length && t - queue[0].t > maxAge) { queue.shift(); }
    return queue.length ? queue.shift() : null;
}

// CC 118: move the selector to the chain picked for the coming note
function selMark() {
    if (nChains <= 0) { return; }
    lastSelMark = now();
    var e = takeFresh(pickQueue, PICK_MAX_AGE);
    if (!e) { return; }                       // no value marker for it (pattern switch): ignore
    if (selector) { selector.set("value", e.k); }
    routeQueue.push({ k: e.k, t: now() });
    if (routeQueue.length > 32) { routeQueue.shift(); }
    if (DEBUG_MARKS) {
        var got = selector ? selector.get("value") : "-";
        post("EventFX: selector -> chain " + e.k + ", now " + got + "\n");
    }
}

// CC 119: pick a chain for the coming note, its CCs follow
function mark() {
    if (nChains > 0) {
        var k = browseMode ? 0 : pickChain();
        target = k;
        resetChain(k);                        // leftovers of this chain's previous note
        if (now() - lastSelMark > LEGACY_MS) {
            // no selector markers in this stream (old clip): move the selector here, as before
            if (selector) { selector.set("value", k); }
            routeQueue.push({ k: k, t: now() });
            if (routeQueue.length > 32) { routeQueue.shift(); }
        } else {
            pickQueue.push({ k: k, t: now() });
            if (pickQueue.length > 32) { pickQueue.shift(); }
        }
        if (DEBUG_MARKS) { post("EventFX: mark -> chain " + k + "\n"); }
    }
    if (held === 0) {
        resetTrackUsed(null);
        trackPending = null;
        deferredReset = false;
    } else {
        trackPending = {};
        deferredReset = true;
    }
}

function ccBody(value, num) {
    if (!ready) { return; }
    if (num === MARK_CC) { mark(); return; }
    if (num === SEL_CC) { selMark(); return; }
    var p = params[num];
    if (!p) { return; }
    if (value >= SENTINEL) { return; }     // sentinel: only there so the next value differs
    var v = value / (SENTINEL - 1);

    if (p.chains.length && nChains > 0) {
        write(p.chains[target], real(p, v));
        chainUsed[target][num] = true;
        var on = p.devChains[target];
        if (on && !p.alwaysOn && !chainDevOn[target][on]) {
            write(on, 1);
            chainDevOn[target][on] = true;
        }
    } else if (p.track) {
        if (trackPending) {
            trackPending[num] = v;          // a note is still sounding: apply at note-on
        } else {
            write(p.track, real(p, v));
            trackUsed[num] = true;
        }
        touchTrackDevice(p);
    }
}

function noteBody(pitch, vel) {
    if (!ready) { return; }
    var k;
    if (vel > 0) {
        held++;
        if (expectChain >= 0) {           // the previous note never started its own chain
            routeMiss++;
            routeLast = "chain " + expectChain + " never started";
        }
        var r = takeFresh(routeQueue, ROUTE_MAX_AGE);
        expectChain = (r && !browseMode) ? r.k : -1;
        if (nChains > 0) {
            k = pitchChain[pitch];
            if (k !== undefined && chainHeld[k] > 0) { chainHeld[k]--; }   // same pitch again without note-off
            pitchChain[pitch] = target;
            chainHeld[target]++;
        }
        if (trackPending) {
            if (deferredReset) { resetTrackUsed(trackPending); }
            for (var c in trackPending) {
                var p = params[c];
                if (p) { write(p.track, real(p, trackPending[c])); trackUsed[c] = true; }
            }
            trackPending = null;
            deferredReset = false;
        }
    } else {
        held = held > 0 ? held - 1 : 0;
        k = pitchChain[pitch];
        if (k !== undefined) {
            delete pitchChain[pitch];
            if (chainHeld[k] > 0) { chainHeld[k]--; }
            // no reset here: the release tail may still be sounding (or crushed to silence);
            // ChainWatch or the next use of this chain resets it
        }
    }
}

// ---- message entry points (timed for DEBUG_LOAD) --------------------------------
function cc(value, num) {
    var t0 = now(); ccBody(value, num); loadMs += now() - t0; loadMsgs++;
}

function note(pitch, vel) {
    var t0 = now(); noteBody(pitch, vel); loadMs += now() - t0; loadMsgs++;
}

// from ChainWatch via [r efx_busy]: busy <trackId> <chain> <0|1>
function busy(track, chain, state) {
    var t0 = now(); busyBody(track, chain, state); loadMs += now() - t0; loadMsgs++;
}

function loadTick() {
    if (DEBUG_LOAD && ready && loadMsgs > 0) {
        post("EventFX: load " + loadMs + " ms/s in JS, " + loadWrites + " LOM writes/s, " +
             loadMsgs + " msgs/s | routing ok " + routeOk + ", missed " + routeMiss +
             ", wrong " + routeWrong + (routeMiss || routeWrong ? " (" + routeLast + ")" : "") + "\n");
    }
    loadMs = 0; loadWrites = 0; loadMsgs = 0;
    routeOk = 0; routeMiss = 0; routeWrong = 0; routeLast = "";
}

function trackOffTick() {
    loadTick();
    if (!ready || held > 0) { return; }
    var t = now();
    for (var id in trackDevOn) {
        if (t - trackDevOn[id] > TRACK_OFF_MS) {
            write(Number(id), 0);
            delete trackDevOn[id];
        }
    }
}
