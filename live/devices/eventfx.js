// eventfx.js - EventFX engine
//
// Per-event Live effects for TidalCycles: CCs sent before each note (toMidi in Tidal) are written
// through LiveAPI into the note's own rack chain. The palette (rack chain 1 + effects after the
// rack) gets CC numbers per track; they are stored IN THE LIVE SET ([pattr efxstate] of this
// device), so every set has its own CCs and a new set starts with what its template has.
// toolz-fx.tidal is generated from the set that is open.
//
// Inputs (from the main patch):
//   init / reload     - read this track's palette from the set, find the params in all chains,
//                       rewrite toolz-fx.tidal from every EventFX of the open set
//   update            - scan rack chain 1 + the effects on the track: every param gets a name
//                       (after the rack: "~name", static (...) in Tidal), params with a CC keep it,
//                       removed ones keep theirs (old clips) until the pool is full - then the
//                       one unused longest gives its CC away; stores the palette in the set,
//                       writes toolz-fx.tidal, reloads, then mirrors chain 1 into all other chains
//   helper /fxwant <ch> <name>  - mapping on demand: a pattern used a name that has no CC on
//                       this track: map it (+ the amount of its device), store, rewrite
//                       toolz-fx.tidal, rebuild; answer /wanted <ch> <ok> <text> (to Tidal)
//   importold         - once per set made before v2: this track's CCs from fx-library.json
//   rest              - current knob positions (chain 1 / track) become the resting values
//   neutral           - every mapped param in every chain back to its resting value
//   chains <n>        - add chains up to n (filled by the mirror); zones + removing chains: by hand
//   channel <n>       - from the 'channel' numbox: re-register this track's number
//   refill            - like update, but loads the preset instruments/racks again in chains 2..N
//                       (instruments loaded from a preset come from the browser, not as copies)
//   inspect <device>  - list a device's parameters (names for fx-rules.json) in the Max console
//   cc <value> <num>  - every incoming CC ([ctlin] -> [pack 0 0] -> [prepend cc])
//   note <pitch> <vel> - every note on / off ([notein] -> [pack 0 0] -> [prepend note])
//   browse 0|1        - 1: no rotation, every note plays in rack chain 1 (auditioning presets
//                       there); afterwards click update so the mirror copies the result
//   helper /catalog   - EventFXHelper finished fxscan: the EventFX that gets it rewrites
//                       toolz-fx.tidal with the catalog names and answers /catalogdone
// toolz-fx.tidal also lists every effect of fx-catalog.json (fxscan in Tidal) as names without
// a CC; after each successful update / refill EventFX asks the helper for "/fxscan auto" (only
// what is new in Live's browser). Names that Tidal or your own files already have
// (tidal-names.txt from gen_words.py) get an "A": an effect never hides a Tidal function.
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
        CAT_FILE = TIDAL_DIR + "fx-catalog.json";      // every audio effect's params (EventFXHelper: fxscan)
        CAT_TIDAL_FILE = TIDAL_DIR + "toolz-fx-catalog.tidal";   // their names (loaded by load-functions)
        NAMES_FILE = TIDAL_DIR + "tidal-names.txt";    // names Tidal already has (gen_words.py): FX names avoid them
    }
    return HOME;
}
var CAT_FILE = "", NAMES_FILE = "", CAT_TIDAL_FILE = "";

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

// write only when the text is different: Neovim reloads the file in Tidal whenever it changes
function writeIfChanged(path, s) {
    if (readText(path) === s) { return true; }
    return writeText(path, s);
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

// Haskell keywords: never usable as names
var HASKELL_WORDS = ("case class data default deriving do else foreign if import in infix infixl infixr " +
                     "instance let module newtype of then type where forall mdo rec proc").split(" ");

function readRules() {
    var r = {}, k, i;
    for (k in DEFAULT_RULES) { r[k] = DEFAULT_RULES[k]; }
    var user = readJson(RULES_FILE);
    if (user) { for (k in user) { if (k.charAt(0) !== "_") { r[k] = user[k]; } } }
    // FX names that would hide a Tidal function / param or one of your own functions get an "A"
    // (delay -> delayA): rules.reserved + Haskell keywords + every name in tidal-names.txt
    r.reservedSet = {};
    var lists = [r.reserved || [], HASKELL_WORDS];
    for (k = 0; k < lists.length; k++) { for (i = 0; i < lists[k].length; i++) { r.reservedSet[lists[k][i]] = true; } }
    var names = NAMES_FILE ? readText(NAMES_FILE) : null;
    if (names) {
        var ws = names.split(/\s+/);
        for (i = 0; i < ws.length; i++) { if (ws[i]) { r.reservedSet[ws[i]] = true; } }
    }
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
// Every param of every device gets a name; a CC only once a pattern uses that name (mapping on
// demand: toMidi asks EventFX through the helper, see wantParams). Devices after the rack (the
// whole track) have names starting with "~": in Tidal, static (...) puts that "~" in front.
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

    var chosen = [];
    for (i = 0; i < n; i++) {
        var q = pars[i];
        if (i === ip) { chosen.push({ par: q, role: "primary" }); }
        else if (i === ia) { chosen.push({ par: q, role: "auto" }); }
        else if (!has(rules.skipParams, q.name) && !CAT_SKIP_PARAM.test(q.name)) { chosen.push({ par: q, role: "param" }); }
    }
    return { chosen: chosen, noPrimary: ip < 0 };
}

// device of an entry, by where it is: the same device name may be in the chain and after the rack
function devKey(e) { return (e.tier === "track" ? "track|" : "chain|") + e.device; }

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
        var dk = devs[d].tier + "|" + devs[d].name;
        if (seenDev[dk]) {
            return { error: "two devices named \"" + devs[d].name + "\" " + (devs[d].tier === "chain" ? "in chain 1" : "after the rack") +
                            " - rename one (Cmd+R)" };
        }
        seenDev[dk] = true;
    }

    var entries = [], names = {}, noPrimary = [];
    for (d = 0; d < devs.length; d++) {
        var dv = devs[d], ch = chooseParams(dv, rules), primaryName = null, pending = [];
        var mark = dv.tier === "track" ? "~" : "";
        if (ch.noPrimary) { noPrimary.push(dv.name); }
        for (var i = 0; i < ch.chosen.length; i++) {
            var c = ch.chosen[i], pp = dv.path + " parameters " + c.par.index;
            go(pp);
            var e = { role: c.role, device: dv.name, param: c.par.name, occurrence: c.par.occ,
                      key: mark + dv.name + "/" + c.par.label, tier: dv.tier, order: d,
                      min: num(api.get("min")), max: num(api.get("max")), value: num(api.get("value")),
                      quantized: c.par.quantized, alwaysOn: has(rules.alwaysOn, dv.name), tidal: null };
            if (c.role === "auto") {
                e.rest = e.min;
            } else {
                var t = c.role === "primary" ? camel(dv.name) : camel(dv.name + " " + c.par.label);
                if (!/^[a-z][A-Za-z0-9]*$/.test(t)) { continue; }        // nothing to call it
                if (rules.reservedSet.hasOwnProperty(t)) { t += "A"; }
                t = mark + t;
                if (names[t]) { return { error: "\"" + t + "\" comes from " + e.key + " and " + names[t] + " - rename a device" }; }
                names[t] = e.key;
                e.tidal = t;
                var np = rules.neutralPrimary[c.par.name];
                e.rest = (c.role === "primary" && np !== undefined) ? e.min + np * (e.max - e.min) : e.value;
                if (c.role === "primary" && np !== undefined) {
                    // an amount (Dry/Wet...): any other param of this device turns it up to where
                    // the knob stands in chain 1 (all the way if it stands at rest)
                    var pos = e.max > e.min ? (e.value - e.rest) / (e.max - e.min) + np : 1;
                    e.engage = true;
                    e.onValue = Math.abs(e.value - e.rest) > 0.001 * Math.max(e.max - e.min, 1e-6) ? Math.min(Math.max(pos, 0), 1) : (np < 0.5 ? 1 : 0);
                }
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

// MIDI channel a track listens to ("MIDI From ... Ch. N") -> N, or 0 (All Channels / unknown).
// Uses its own LiveAPI, so it never moves the shared one in the middle of a scan.
function inputChannelOf(trackPath) {
    try {
        var t = new LiveAPI(trackPath);
        if (!Number(t.id)) { return 0; }
        var v = t.get("input_routing_channel");
        var m = /Ch\.\s*(\d+)/.exec((v instanceof Array) ? v.join(" ") : String(v));
        return m ? Number(m[1]) : 0;
    } catch (err) { return 0; }
}

// the 'channel' box follows the track's MIDI From channel (the channel Tidal really reaches);
// with MIDI From on All Channels the box is used as it is
function syncChannel() {
    var ich = inputChannelOf("this_device canonical_parent"), box = this.patcher.getnamed("channel");
    if (!ich || !box || ich === trackChannel()) { return; }
    post("EventFX: 'channel' box " + trackChannel() + " -> " + ich + " (MIDI From is Ch. " + ich + ")\n");
    box.message("set", ich);
    register();
}

// channel of a registered EventFX: its track's MIDI From if set, otherwise its box
function channelOfEntry(e) {
    return inputChannelOf("id " + e.track) || e.channel;
}

// ---- palette state, stored in the Live set -----------------------------------------
// This track's palette (FX names -> CC, resting values, auto-on CCs) lives in the [pattr efxstate]
// of this EventFX (Parameter Mode Enable, Type Blob, Stored Only), so it is saved in the .als:
// every set has its own CCs, a duplicated track takes the palette with it, a new EventFX starts
// empty. Stored as JSON, URI-encoded and cut into chunks (each with an "x" in front, so Max never
// reads a chunk as a number).
var STATE_CHUNK = 1000;
var myState = null;         // { fx: { name: {...} }, on: [...] } or null = no palette yet

function stateBox() { return this.patcher.getnamed("efxstate"); }

function loadState() {
    var box = stateBox();
    if (!box) { return null; }
    var v = box.getvalueof(), s = "";
    if (!(v instanceof Array)) { v = [v]; }
    for (var i = 0; i < v.length; i++) {
        var c = String(v[i]);
        if (c.charAt(0) === "x") { s += c.substr(1); }
    }
    if (!s) { return null; }
    try {
        var st = JSON.parse(decodeURIComponent(s));
        return st && st.fx ? st : null;
    } catch (err) {
        post("EventFX: the palette stored in this set is broken (" + err + ") - click update\n");
        return null;
    }
}

function saveState(st) {
    var box = stateBox();
    if (!box) { return false; }
    var s = encodeURIComponent(JSON.stringify(st)), chunks = [];
    for (var i = 0; i < s.length; i += STATE_CHUNK) { chunks.push("x" + s.substr(i, STATE_CHUNK)); }
    box.setvalueof(chunks.length === 1 ? chunks[0] : chunks);
    myState = st;
    register();
    return true;
}

function noStateBox(what) {
    say(what + ": add [pattr efxstate] to the EventFX patch (Parameter Mode Enable, Type Blob, " +
        "Visibility Stored Only) - see docs/usage.md");
}

function clone(o) { return JSON.parse(JSON.stringify(o)); }

// every living EventFX of the open set -> { params, tracks, names } in the old library shape
// (params: FX name -> device/param, tracks: channel -> palette state), for writeTidal & co.
function setLibrary() {
    register();
    var lib = { params: {}, tracks: {}, names: {} };
    for (var k in REG.entries) {
        var e = REG.entries[k];
        if (!e.state) { continue; }
        var ech = e.channel;
        if (k !== instanceKey) {
            var probe = new LiveAPI("id " + e.track);
            if (!Number(probe.id)) { delete REG.entries[k]; continue; }
            ech = channelOfEntry(e);
        }
        if (!ech) { continue; }
        var key = String(ech);
        if (lib.tracks[key] && k !== instanceKey) { continue; }    // a clash: this track's own state wins
        lib.tracks[key] = e.state;
        lib.names[key] = e.name;
    }
    for (var t in lib.tracks) {
        var fx = lib.tracks[t].fx;
        for (var n in fx) {
            if (!lib.params[n] && fx[n].device) {
                lib.params[n] = { device: fx[n].device, param: fx[n].param, occurrence: fx[n].occurrence || 0 };
            }
        }
        var kn = lib.tracks[t].known || [];             // named only (no CC until a pattern uses it)
        for (var q = 0; q < kn.length; q++) {
            if (!lib.params[kn[q].tidal]) {
                lib.params[kn[q].tidal] = { device: kn[q].device, param: kn[q].param, occurrence: kn[q].occurrence || 0 };
            }
        }
    }
    return lib;
}

// ---- registry of all EventFX instances (shared by every js in Live) --------------
// Each EventFX writes its track and channel here at load and when the 'channel' box changes;
// update refuses when another track uses the same channel (e.g. a duplicated track).
var REG = new Global("eventfx_registry");
if (!REG.entries) { REG.entries = {}; }
var instanceKey = "efx" + Math.floor(Math.random() * 1e9) + "_" + now();

var since = now();          // when this EventFX was created: the newer of two clashing ones renumbers

function register() {
    var t = go("this_device canonical_parent");
    REG.entries[instanceKey] = { track: Number(t.id), channel: trackChannel(), name: nameOf(t), since: since,
                                 state: myState };
}

// another living EventFX on another track using channel ch -> { name, older }, or null
function clashWith(ch) {
    register();
    var me = REG.entries[instanceKey];
    for (var k in REG.entries) {
        if (k === instanceKey) { continue; }
        var e = REG.entries[k];
        if (e.track === me.track) { continue; }
        var probe = new LiveAPI("id " + e.track);
        if (!Number(probe.id)) { delete REG.entries[k]; continue; }    // that track is gone
        if (channelOfEntry(e) !== ch) { continue; }
        return { name: nameOf(probe), older: e.since < me.since || (e.since === me.since && k < instanceKey) };
    }
    return null;
}

function freeChannel() {
    var used = {};
    for (var k in REG.entries) {
        if (k === instanceKey) { continue; }
        var probe = new LiveAPI("id " + REG.entries[k].track);
        if (Number(probe.id)) { used[channelOfEntry(REG.entries[k])] = true; }
    }
    for (var c = 1; c <= 16; c++) { if (!used[c]) { return c; } }
    return 0;
}

// a duplicated track keeps the original's channel: give the copy the first free one and set its
// MIDI input to that channel (helper). The palette was copied with the device (it is stored in
// it), so the copy - and the clips duplicated with it - work at once with the same CC numbers.
function renumber(oldCh) {
    var nc = freeChannel(), clash = clashWith(oldCh);
    if (!nc) { say("all 16 channels are taken - set the 'channel' box by hand"); return 0; }
    var box = this.patcher.getnamed("channel");
    if (!box) { return 0; }
    box.message("set", nc);
    register();
    outlet(1, "/inchan", 0, trackIndex(), nc);
    var msg = "channel " + oldCh + " is used by track \"" + (clash ? clash.name : "?") + "\": this track is now " + nc +
              (myState ? " with the same palette - in Tidal: :CheckTidal (or :script toolz-fx.tidal), then toMidi " + nc
                       : " - click update");
    post("EventFX: " + msg + "\n");
    pendingNote = msg;
    return nc;
}
var pendingNote = null;     // shown after the build that follows a renumber

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
    var c = clashWith(ch);
    return c ? c.name : null;
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
// Params that already have a CC keep it; a new CC only for the names in `wanted` (mapping on
// demand); every other param of the track is only named (tr.known: in toolz-fx, no CC yet).
// A CC of a param whose device is gone stays (old clips) until the pool is full.
function mergeTrack(lib, ch, entries, wanted) {
    wanted = wanted || {};
    var key = String(ch);
    var tr = lib.tracks[key] || (lib.tracks[key] = { fx: {}, on: [] });
    var used = {}, present = {}, oldOn = {}, added = [], reclaimed = [], warn = [], name, i, t = now();
    for (name in tr.fx) { used[tr.fx[name].cc] = true; tr.fx[name].inPalette = false; }
    for (i = 0; i < entries.length; i++) { if (entries[i].tidal) { present[entries[i].tidal] = true; } }   // never reclaimed
    for (i = 0; i < tr.on.length; i++) { used[tr.on[i].cc] = true; oldOn[tr.on[i].key || (tr.on[i].device + "/" + tr.on[i].param)] = tr.on[i]; }

    function alloc() {
        for (var j = 0; j < CC_POOL.length; j++) { if (!used[CC_POOL[j]]) { used[CC_POOL[j]] = true; return CC_POOL[j]; } }
        var best = null;                  // pool full: take the CC of the param unused longest
        for (var n in tr.fx) {
            var f = tr.fx[n];
            if (f.inPalette === false && !present[n] && (best === null || (f.lastSeen || 0) < (tr.fx[best].lastSeen || 0))) { best = n; }
        }
        if (best === null) { return 0; }
        var cc = tr.fx[best].cc;
        reclaimed.push(best + " (CC " + cc + ")");
        delete tr.fx[best];
        return cc;
    }

    var mappedDev = {}, known = [], e, f;
    for (i = 0; i < entries.length; i++) {
        e = entries[i];
        if (e.role === "auto") { continue; }
        f = tr.fx[e.tidal];
        if (!f && !wanted[e.tidal]) {
            known.push({ tidal: e.tidal, device: e.device, param: e.param, occurrence: e.occurrence,
                         tier: e.tier, order: e.order, primary: e.role === "primary" });
            continue;
        }
        if (!f) {
            var cc = alloc();
            if (!cc) { return { error: "the CC pool of track " + ch + " is full" }; }
            f = tr.fx[e.tidal] = { cc: cc, rest: e.rest };
            added.push(e.tidal + " (CC " + cc + ")");
        } else {
            f.rest = restOf(f);
            delete f.neutral; delete f.log; delete f.always_on;
        }
        f.device = e.device; f.param = e.param; f.occurrence = e.occurrence; f.tier = e.tier;
        f.order = e.order; f.primary = e.role === "primary"; f.min = e.min; f.max = e.max;
        f.quantized = e.quantized; f.alwaysOn = e.alwaysOn; f.inPalette = true; f.lastSeen = t;
        mappedDev[devKey(e)] = true;

        var lp = lib.params[e.tidal];
        if (!lp) {
            lib.params[e.tidal] = { device: e.device, param: e.param, occurrence: e.occurrence };
        } else if (lp.device !== e.device || lp.param !== e.param) {
            warn.push(e.tidal + " is " + lp.device + "/" + lp.param + " elsewhere");
        }
    }

    var on = [];                          // auto-on params (BPF Dry/Wet...) of devices that have a CC
    for (i = 0; i < entries.length; i++) {
        e = entries[i];
        if (e.role !== "auto" || !mappedDev[devKey(e)]) { continue; }
        var o = oldOn[e.key], occ = o ? o.cc : alloc();
        if (!occ) { return { error: "the CC pool of track " + ch + " is full" }; }
        on.push({ "with": e["with"], key: e.key, cc: occ, value: 1, device: e.device, param: e.param, tier: e.tier,
                  occurrence: e.occurrence, order: e.order, min: e.min, max: e.max, alwaysOn: e.alwaysOn });
    }
    // engage: using any param of a device also sets its amount (primary Dry/Wet...) and its
    // auto-on param, unless the pattern sets that one itself (Tidal skips explicit CCs)
    var byDev = {}, engage = {}, d;
    for (i = 0; i < entries.length; i++) {
        var en = entries[i];
        d = devKey(en);
        if (!byDev[d]) { byDev[d] = []; engage[d] = []; }
        if (en.tidal && tr.fx[en.tidal] && tr.fx[en.tidal].inPalette) { byDev[d].push(en); }
        if (en.role === "primary" && en.engage && tr.fx[en.tidal]) {
            engage[d].push({ name: en.tidal, key: en.key, cc: tr.fx[en.tidal].cc, value: en.onValue, e: en });
        }
    }
    for (i = 0; i < on.length; i++) {
        d = devKey(on[i]);
        engage[d] = engage[d] || [];
        engage[d].push({ name: null, key: on[i].key, cc: on[i].cc, value: on[i].value, e: on[i] });
    }
    var on2 = [];
    for (d in byDev) {
        for (i = 0; i < byDev[d].length; i++) {
            var nm = byDev[d][i].tidal;
            for (var g = 0; g < engage[d].length; g++) {
                var en2 = engage[d][g];
                if (en2.name === nm) { continue; }            // the amount itself: nothing to add
                on2.push({ "with": nm, key: en2.key, cc: en2.cc, value: Math.round(en2.value * 1000) / 1000,
                           device: en2.e.device, param: en2.e.param, occurrence: en2.e.occurrence, tier: en2.e.tier,
                           order: en2.e.order, min: en2.e.min, max: en2.e.max, alwaysOn: en2.e.alwaysOn });
            }
        }
    }
    tr.on = on2;
    tr.known = known;
    var dormant = [];
    for (name in tr.fx) { if (tr.fx[name].inPalette === false) { dormant.push(name); } }
    var mapped = 0;
    for (name in tr.fx) { if (tr.fx[name].inPalette) { mapped++; } }
    return { added: added, reclaimed: reclaimed, dormant: dormant, warn: warn, known: known.length, mapped: mapped };
}

// what to map when a pattern uses these names: the names, plus the amount (Dry/Wet...) of
// their devices - any param of a device turns its amount up (engage), so it needs a CC too
function wantClosure(entries, names, tr) {
    var w = {}, devs = {}, i, e;
    for (i = 0; i < entries.length; i++) {
        e = entries[i];
        if (e.tidal && names[e.tidal]) { w[e.tidal] = true; devs[devKey(e)] = true; }
    }
    for (i = 0; i < entries.length; i++) {
        e = entries[i];
        if (e.role === "primary" && e.engage && devs[devKey(e)] && !tr.fx[e.tidal]) { w[e.tidal] = true; }
    }
    return w;
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
        out.push({ cc: f.cc, device: dev, param: par, occurrence: occ, min: f.min, max: f.max, tier: f.tier,
                   neutral: position(restOf(f), f.min, f.max), always_on: aOn, key: dev + "/" + par, tidal: name });
    }
    var mapped = {};
    for (i = 0; i < out.length; i++) { mapped[out[i].cc] = true; }
    for (i = 0; i < tr.on.length; i++) {
        var o = tr.on[i];
        if (mapped[o.cc]) { continue; }                   // an amount that also has its own name
        mapped[o.cc] = true;
        out.push({ cc: o.cc, device: o.device, param: o.param, occurrence: o.occurrence || 0,
                   min: o.min, max: o.max, neutral: 0, tier: o.tier,
                   always_on: o.alwaysOn !== undefined ? o.alwaysOn : has(rules.alwaysOn, o.device),
                   key: o.device + "/" + o.param, tidal: null });
    }
    return out;
}

// ---- effect catalog (fx-catalog.json, written by EventFXHelper: fxscan) ----------------
// items: browser path -> { name, kind: native|m4l|rack|preset, class, source: core|user,
//                          device, params: [[name, min, max, quantized], ...] (loaded ones) }
// Presets are not loaded: they have the params of their class (the native device they're for).
var CAT_CACHE = new Global("eventfx_catalog");   // parsed file, shared by every EventFX
var lastCatalogCount = 0;                         // names the last writeTidal took from the catalog
var CAT_SKIP_PARAM = /^(Macro \d+|Chain Selector)$/;   // unnamed rack macros: nothing to call them
var CAT_RANK = { native: 0, m4l: 1, rack: 2, preset: 2 };

function readCatalog() {
    if (!CAT_FILE) { return null; }
    var s = readText(CAT_FILE);
    if (s === null) { return null; }
    if (CAT_CACHE.len === s.length && CAT_CACHE.data) { return CAT_CACHE.data; }
    var c;
    try { c = JSON.parse(s); } catch (err) { say("fx-catalog.json is broken - run fxscan in Tidal again"); return null; }
    CAT_CACHE.len = s.length;
    CAT_CACHE.data = c;
    return c;
}

// names for the params of one device, by the same scheme as scanPalette: the main param gets the
// device's name (saturator), every other one device name + param label (saturatorDrive);
// full = false: the main param only (presets / racks from the Core Library)
function nameAll(dev, pars, rules, full) {
    var n = pars.length, counts = {}, occ = [], i, out = [];
    for (i = 0; i < n; i++) { occ.push(counts[pars[i][0]] || 0); counts[pars[i][0]] = (counts[pars[i][0]] || 0) + 1; }
    function find(name) { for (var j = 0; j < n; j++) { if (pars[j][0] === name) { return j; } } return -1; }
    var primary = rule(rules.primaryByDevice, dev), ip = primary ? find(primary) : -1;
    for (i = 0; ip < 0 && i < rules.primaryCandidates.length; i++) { ip = find(rules.primaryCandidates[i]); }
    for (i = 0; i < n; i++) {
        var pn = pars[i][0];
        if (i !== ip && (!full || has(rules.skipParams, pn) || CAT_SKIP_PARAM.test(pn))) { continue; }
        var label = counts[pn] === 1 ? pn : pn + " " + (occ[i] + 1);
        var t = i === ip ? camel(dev.name) : camel(dev.name + " " + label);
        if (!/^[a-z][A-Za-z0-9]*$/.test(t)) { continue; }
        if (rules.reservedSet.hasOwnProperty(t)) { t += "A"; }
        out.push({ tidal: t, label: i === ip ? label + " (main)" : label });
    }
    return out;
}

// lines for every catalog name -> { lines: [...], count }. Order: native devices, Max for Live,
// your presets / racks, then the Core Library's; a name that comes up twice keeps the first one.
// Names that are in a palette too are written in both files (the same pF), so this file only
// changes after an fxscan - reloading it (2000+ names) holds GHCi up for a moment.
function catalogLines(rules) {
    var cat = readCatalog(), out = [], count = 0, key, i, j;
    if (!cat || !cat.items) { return { lines: out, count: 0, byName: {} }; }
    var items = [], classes = {};
    for (key in cat.items) {
        var it = cat.items[key];
        if (it.kind === "native" && it.params) { classes[it.name] = it.params; }
        if (CAT_RANK[it.kind] !== undefined) { items.push(it); }
    }
    function rank(it) { return CAT_RANK[it.kind] + (it.kind !== "native" && it.kind !== "m4l" && it.source !== "user" ? 1 : 0); }
    items.sort(function (a, b) {
        var ra = rank(a), rb = rank(b);
        if (ra !== rb) { return ra - rb; }
        var na = String(a.device || a.name).toLowerCase(), nb = String(b.device || b.name).toLowerCase();
        return na < nb ? -1 : na > nb ? 1 : 0;
    });
    var used = {}, rows = [], w = 10, byName = {};
    for (i = 0; i < items.length; i++) {
        var e = items[i], dname = String(e.device || e.name);
        var disp = e.kind === "preset" ? e["class"] : (e.kind === "rack" ? "Audio Effect Rack" : dname);
        var pars = e.kind === "preset" ? classes[e["class"]] : e.params;
        if (!pars || has(rules.skipDevices, dname) || has(rules.skipDevices, disp)) { continue; }
        var full = e.kind === "native" || e.kind === "m4l" || e.source === "user";
        var named = nameAll({ name: dname, disp: disp }, pars, rules, full), mine = [];
        for (j = 0; j < named.length; j++) {
            var t = named[j].tidal;
            if (used.hasOwnProperty(t)) { continue; }
            used[t] = true;
            byName[t] = dname;
            mine.push(named[j]);
            if (t.length + 1 > w) { w = t.length + 1; }
        }
        if (mine.length) { rows.push({ device: dname, names: mine }); }
    }
    for (i = 0; i < rows.length; i++) {
        out.push("-- " + rows[i].device);
        for (j = 0; j < rows[i].names.length; j++) {
            var r = rows[i].names[j];
            out.push(pad(r.tidal, w) + "= pF \"" + r.tidal + "\"   -- " + r.label + "  [catalog]");
            count++;
        }
    }
    return { lines: out, count: count, byName: byName };
}

// device of a catalog name (catalogLines' rows), or null
function catalogDeviceOf(name) {
    var cat = catalogLines(readRules());
    return cat.byName.hasOwnProperty(name) ? cat.byName[name] : null;
}

// /catalog from EventFXHelper (fxscan finished): the EventFX that gets it rewrites toolz-fx.tidal
// and answers. Which [udpreceive 11011] gets a message is up to Max (maybe only one of them), so
// any EventFX may do it; when several get it, the first one within 3 s does.
function catalogReady() {
    if (!findHome() || !apiReady()) { return; }
    if (CAT_CACHE.wroteAt && now() - CAT_CACHE.wroteAt < 3000) { return; }
    CAT_CACHE.wroteAt = now();
    var ok = writeTidal(setLibrary());
    outlet(1, "/catalogdone", ok ? 1 : 0, lastCatalogCount);
}

// ---- toolz-fx.tidal ------------------------------------------------------------
function pad(s, w) { s = String(s); while (s.length < w) { s += " "; } return s; }

function writeTidal(lib) {
    var tracks = [], t, name, i, j;
    for (t in lib.tracks) { tracks.push(Number(t)); }
    tracks.sort(function (a, b) { return a - b; });

    var order = {}, w = 10, names = [], knownOf = {};
    for (i = 0; i < tracks.length; i++) {
        var fx = lib.tracks[tracks[i]].fx, kn = lib.tracks[tracks[i]].known || [];
        knownOf[tracks[i]] = {};
        for (name in fx) {
            if (fx[name].inPalette !== false && order[name] === undefined) {
                order[name] = tracks[i] * 1000 + (fx[name].order || 0) * 2 + (fx[name].primary ? 0 : 1);
            }
        }
        for (j = 0; j < kn.length; j++) {
            knownOf[tracks[i]][kn[j].tidal] = true;
            if (order[kn[j].tidal] === undefined) {
                order[kn[j].tidal] = tracks[i] * 1000 + (kn[j].order || 0) * 2 + (kn[j].primary ? 0 : 1);
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
        var nIn = 0, fxs = lib.tracks[tracks[i]].fx, nKn = (lib.tracks[tracks[i]].known || []).length;
        for (name in fxs) { if (fxs[name].inPalette !== false) { nIn++; } }
        counts.push("t" + tracks[i] + (lib.names && lib.names[tracks[i]] ? " \"" + lib.names[tracks[i]] + "\"" : "") +
                    ": " + nIn + " with a CC, " + nKn + " more on first use");
    }
    var cat = catalogLines(readRules());
    lastCatalogCount = cat.count;
    var catText = ["-- toolz-fx-catalog.tidal - GENERATED by EventFX from fx-catalog.json (fxscan in Tidal), do not edit",
                   "-- every audio effect in Live's browser: names only - a track ignores a name until the",
                   "-- effect is in its palette (toolz-fx.tidal has the CCs). Loaded by load-functions.tidal.",
                   ":{"].concat(cat.lines, [":}", ""]).join("\n");
    if (cat.count && !writeIfChanged(CAT_TIDAL_FILE, catText)) { return false; }
    var out = ["-- toolz-fx.tidal - GENERATED by EventFX from the open Live set, do not edit",
               "-- (rewritten when a set opens and on update; Neovim reloads it in Tidal by itself)",
               "-- " + names.length + " FX params in this set; in the palettes: " + counts.join(", ") +
               "; " + cat.count + " names in toolz-fx-catalog.tidal",
               "-- usage: d1 $ toMidi 1 $ n \"0 3\" # redux \"0 1\" # lpfA 0.4   (1 = track / MIDI channel)",
               "--        # static (utilityGain 0.3)   the effect after the rack (whole track), not the note's chain",
               "-- a name gets its CC on a track the first time a pattern uses it there (a second or so);",
               "-- a name that is not on the track is ignored there (Tidal says so once)", ""];
    // one pF per name; "~name" (after the rack, static) shares it with "name"
    var bindings = [], byBinding = {};
    for (i = 0; i < names.length; i++) {
        name = names[i];
        var b = name.replace(/^~/, ""), stat = b !== name, where = byBinding[b];
        if (!where) {
            where = byBinding[b] = [];
            bindings.push({ name: b, device: lib.params[name].device, param: lib.params[name].param, where: where });
        }
        for (j = 0; j < tracks.length; j++) {
            var f = lib.tracks[tracks[j]].fx[name], tag = "t" + tracks[j] + (stat ? " static" : "");
            if (f && f.inPalette !== false) { where.push(tag + " CC " + f.cc); }
            else if (knownOf[tracks[j]][name]) { where.push(tag + " on first use"); }
        }
    }
    var last = null;
    for (i = 0; i < bindings.length; i++) {
        var bd = bindings[i];
        if (bd.device !== last) { out.push(""); out.push("-- " + bd.device); last = bd.device; }
        out.push(pad(bd.name, w) + "= pF \"" + bd.name + "\"   -- " + bd.param +
                 (bd.where.length ? "  [" + bd.where.join(", ") + "]" : "  [not on a track]"));
    }

    out.push("", ":{", "-- per track (MIDI channel): FX param -> CC",
             "fxCC :: Map.Map Int (Map.Map String Double)", "fxCC = fxMapOf");
    for (i = 0; i < tracks.length; i++) {
        var pairs = [], fx2 = lib.tracks[tracks[i]].fx;
        for (name in fx2) { if (fx2[name].inPalette !== false) { pairs.push([name, fx2[name].cc]); } }
        pairs.sort(function (a, b) { return a[1] - b[1]; });
        out.push("  " + (i ? "," : "[") + " (" + tracks[i] + ", fxMapOf");
        for (j = 0; j < pairs.length; j++) {
            out.push("      " + (j ? "," : "[") + " (\"" + pairs[j][0] + "\", " + pairs[j][1] + ")");
        }
        out.push(pairs.length ? "      ])" : "      [])");
    }
    out.push(tracks.length ? "  ]" : "  []");

    out.push("", "-- per track: FX param -> CCs switched on with it (cc, value 0..1)",
             "fxOn :: Map.Map Int (Map.Map String [(Double, Double)])", "fxOn = fxMapOf");
    for (i = 0; i < tracks.length; i++) {
        var groups = {}, keys = [], on = lib.tracks[tracks[i]].on;
        for (j = 0; j < on.length; j++) {
            var wn = on[j]["with"];
            if (!groups[wn]) { groups[wn] = []; keys.push(wn); }
            groups[wn].push("(" + on[j].cc + ", " + on[j].value + ")");
        }
        keys.sort();
        out.push("  " + (i ? "," : "[") + " (" + tracks[i] + ", fxMapOf");
        for (j = 0; j < keys.length; j++) {
            out.push("      " + (j ? "," : "[") + " (\"" + keys[j] + "\", [" + groups[keys[j]].join(", ") + "])");
        }
        out.push(keys.length ? "      ])" : "      [])");
    }
    out.push(tracks.length ? "  ]" : "  []");
    out.push(":}", "",
             "-- toMidi (toolz.tidal) reads these on every query: new CCs work at once, also in",
             "-- patterns that are playing and in functions defined earlier (urm, reccal)",
             "fxSetMaps fxCC fxOn", "");
    return writeIfChanged(TIDAL_FILE, out.join("\n"));
}

// ---- mirror: chains 2..N follow chain 1 (structure + values) ----------------------
// Native devices are inserted through the LOM, Max devices / plug-ins (and ChainWatch) through
// EventFXHelper (Remote Script, OSC over [udpsend] / [udpreceive] -> [prepend helper]).
var refillNext = false;     // set by [refill]: the next mirror reloads preset devices in chains 2..N
var HELPER_TIMEOUT_MS = 15000;           // the helper itself gives up after ~12 s (kits with samples load slowly)
var mirror = null;          // state while mirroring
var helperSeq = 0;

function isNative(d) { return d.cls.indexOf("Mx") !== 0 && d.cls.indexOf("Plugin") < 0; }
function sameDev(a, b) { return a.name === b.name && a.cls === b.cls; }

// an instrument or rack whose name is not the device's own name was loaded from a preset
// (Live names a device after the preset): it is loaded from the browser in every chain, so pads,
// samples, inner racks and plug-in state come along - copying parameters can't do that
function isPreset(d) { return (d.type === 1 || d.racks) && d.name !== d.disp; }

function askHelper(cmd, at, d) {
    var M = mirror;
    M.waitId = ++helperSeq;
    outlet(1, cmd, M.waitId, M.track, M.k, at, d.name, d.cls, isPreset(d) ? "preset" : "device");
    var id = M.waitId;
    M.timer = new Task(function () {
        if (mirror && mirror.waitId === id) { endMirror("EventFXHelper did not answer - is it set as Control Surface?"); }
    }, this);
    M.timer.schedule(HELPER_TIMEOUT_MS);
}

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
        out.push({ name: nameOf(api), cls: str(api.get("class_name")), disp: str(api.get("class_display_name")),
                   type: num(api.get("type")), racks: num(api.get("can_have_chains")) === 1 });
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
               inserted: 0, deleted: 0, loaded: 0, writes: 0, failed: [], waitId: 0, timer: null, ops: 0, refused: 0, refusedNames: [], refill: refillNext, refilled: {}, t0: now() };
    refillNext = false;
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
        if (M.refill && M.k > 0 && !M.refilled[M.k]) {     // refill: drop preset devices, the mirror reloads them
            M.refilled[M.k] = true;
            var cur = chainDevices(M.k);
            for (var r = cur.length - 1; r >= 0; r--) {
                for (var q = 0; q < M.tpl.length; q++) {
                    if (isPreset(M.tpl[q]) && sameDev(cur[r], M.tpl[q])) { go(cpath).call("delete_device", r); M.deleted++; break; }
                }
            }
        }
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
        if (isPreset(d)) {
            if (op.index > 0) { askHelper("/load", op.index - 1, d); return; }
            // first in the chain: insert the plain device, then hot-swap the preset onto it
            go(cpath).call("insert_device", d.disp, 0);
            if (go(cpath).getcount("devices") !== before + 1) {
                M.failed.push("chain " + (M.k + 1) + ": Live refused " + d.disp + " at 0");
                M.k++; M.ops = 0;
                continue;
            }
            M.inserted++;
            askHelper("/swap", 0, d);
            return;
        }
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
        askHelper("/load", op.index - 1, d);
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
    if (addr === "/refill") {
        if (Number(a[1]) === trackIndex()) { instRefill(a.slice(2).join(" ")); }
        return;
    }
    if (addr === "/catalog") { catalogReady(); return; }
    if (addr === "/fxwant") {
        if (Number(a[1]) === trackChannel()) { wantName(a.slice(2).join(" ")); }
        return;
    }
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
        var why = a.slice(4).join(" "), d0 = null;
        for (var t = 0; t < mirror.tpl.length; t++) { if (why.indexOf("'" + mirror.tpl[t].name + "'") >= 0) { d0 = mirror.tpl[t]; } }
        if (d0 && isPreset(d0) && why.indexOf("not in the browser") >= 0) {
            why += " - save it from chain 1 as a preset in the User Library (save button on the device), same name";
        }
        mirror.failed.push("chain " + (mirror.k + 1) + ": " + why);
        mirror.k++; mirror.ops = 0;               // skip this chain, go on with the next
    }
    mirrorStep();
}

// inspect <device name>: list every parameter of that device (rack chain 1 or the track) as the
// LOM names it - for writing primaryByDevice / preferByDevice in fx-rules.json
function inspect() {
    if (!apiReady()) { notReady("inspect"); return; }
    var want = arrayfromargs(arguments).join(" ");
    if (!want) { say("inspect: usage 'inspect Shifter'"); return; }
    calls = 0; api = null;
    var paths = [], tpath = "this_device canonical_parent", nd = go(tpath).getcount("devices"), d, p;
    for (d = 0; d < nd; d++) {
        p = tpath + " devices " + d;
        go(p);
        if (num(api.get("can_have_chains")) === 1) {
            var cp = p + " chains 0", nc = go(cp).getcount("devices");
            for (var c = 0; c < nc; c++) { paths.push(cp + " devices " + c); }
        } else {
            paths.push(p);
        }
    }
    for (d = 0; d < paths.length; d++) {
        go(paths[d]);
        if (nameOf(api) !== want) { continue; }
        var n = api.getcount("parameters"), out = [];
        for (p = 0; p < n; p++) {
            go(paths[d] + " parameters " + p);
            out.push(p + " " + nameOf(api) + (num(api.get("is_quantized")) === 1 ? " [stepped]" : ""));
        }
        post("EventFX: params of " + want + ":\n  " + out.join("\n  ") + "\n");
        say("inspect: " + n + " parameters of " + want + " listed in the Max console");
        return;
    }
    say("inspect: no device named \"" + want + "\" in chain 1 or on the track");
}

// ---- commands: update / rest / neutral ------------------------------------------
// end of an update: report it (failures go to the status line), tell whoever asked for it
// (an instrument change from Tidal) and never leave a refill pending
var updateDone = null;      // function (ok, text) or null
function updateEnd(ok, text, quiet) {
    if (!ok && !quiet) { say(text); }
    if (!ok) { refillNext = false; }
    if (updateDone) { var f = updateDone; updateDone = null; f(ok, text); }
    // new effects / presets in Live's browser since the last fxscan get their names (in the
    // background; does nothing before the first fxscan or when the browser has nothing new)
    if (ok) { outlet(1, "/fxscan", "auto"); }
}

// /refill <track index> <name> from EventFXHelper (# i "name" in Tidal): chain 1 has the new
// instrument; wait until no note is held (Tidal hushes first), then refill and report back
function instRefill(name) {
    var tries = 0, idx = trackIndex();
    function attempt() {
        if ((held > 0 || mirror || !apiOk) && tries++ < 50) {        // up to ~5 s
            var t = new Task(attempt, this);
            t.schedule(100);
            return;
        }
        updateDone = function (ok, text) {
            outlet(1, "/refilled", idx, ok ? 1 : 0, ok ? "now plays '" + name + "' (" + text + ")" : text);
        };
        held = 0;                               // notes cut off by the hush: nothing is really held
        say("instrument '" + name + "' - refilling chains...");
        refill();
    }
    attempt();
}
// ---- mapping on demand --------------------------------------------------------
// toMidi in Tidal met a name that has no CC on this track: /want -> helper -> /fxwant here.
// The names that come within 150 ms are mapped together: CC from the pool, stored in the set,
// toolz-fx.tidal rewritten (Neovim reloads it, toMidi uses it at once), then the engine finds the
// new params in the chains (no mirror: the devices are there already). The answer goes back to
// Tidal: /wanted <ch> <ok> <text> -> helper -> Tidal (UDP 11015).
var wantQueue = [], wantTask = null, wantTries = 0;
var wantAnswered = {};      // name -> last answer: the same "not on this track" is said only once

function wantName(name) {
    if (!name) { return; }
    wantQueue.push(name);
    if (!wantTask) {
        wantTries = 0;
        wantTask = new Task(wantParams, this);
        wantTask.schedule(150);
    }
}

function wantReply(ch, ok, name, text) {
    if (!ok && wantAnswered[name] === text) { return; }
    wantAnswered[name] = text;
    outlet(1, "/wanted", ch, ok ? 1 : 0, text);
}

function wantParams() {
    if ((mirror || !apiOk) && wantTries++ < 40) {     // mirroring / Live API not ready: up to ~12 s
        wantTask = new Task(wantParams, this);
        wantTask.schedule(300);
        return;
    }
    wantTask = null;
    var names = wantQueue, i, n;
    wantQueue = [];
    var ch = trackChannel();
    if (!ch || !findHome() || !stateBox()) { return; }
    var uniq = {}, list = [];
    for (i = 0; i < names.length; i++) { if (!uniq[names[i]]) { uniq[names[i]] = true; list.push(names[i]); } }

    calls = 0; api = null;
    var rules = readRules();
    myState = loadState();
    var lib = setLibrary(), key = String(ch);
    lib.tracks[key] = myState ? clone(myState) : { fx: {}, on: [] };
    var tr = lib.tracks[key];
    var scan = scanPalette(rules);
    if (scan.error) {
        for (i = 0; i < list.length; i++) { wantReply(ch, false, list[i], "track " + ch + ": " + scan.error); }
        return;
    }
    var have = {}, want = {}, missing = [];
    for (i = 0; i < scan.entries.length; i++) { if (scan.entries[i].tidal) { have[scan.entries[i].tidal] = scan.entries[i]; } }
    for (i = 0; i < list.length; i++) {
        n = list[i];
        if (have[n]) { if (!tr.fx[n] || tr.fx[n].inPalette === false) { want[n] = true; } }
        else { missing.push(n); }
    }
    for (i = 0; i < missing.length; i++) { wantReply(ch, false, missing[i], whyNot(ch, missing[i], have)); }

    var w = wantClosure(scan.entries, want, tr), any = false;
    for (n in w) { any = true; break; }
    if (!any) { return; }
    var rep = mergeTrack(lib, ch, scan.entries, w);
    if (rep.error) {
        for (n in want) { wantReply(ch, false, n, "track " + ch + ": " + rep.error + " - :fxclean frees CCs of effects you don't use"); }
        return;
    }
    saveState(lib.tracks[key]);
    if (!writeTidal(setLibrary())) { say("cannot write " + TIDAL_FILE); return; }
    post("EventFX: on first use: " + rep.added.join(", ") + "\n");
    for (n in want) {
        var f = lib.tracks[key].fx[n], extra = [];
        for (var m in w) {                           // the amount of the same device, mapped with it
            if (m !== n && !want[m] && have[m] && devKey(have[m]) === devKey(have[n])) { extra.push(m.replace(/^~/, "")); }
        }
        wantReply(ch, true, n, "track " + ch + ": " + (n.charAt(0) === "~" ? "static (" + n.substr(1) + ")" : n) +
                  " -> CC " + f.cc + (extra.length ? " (with " + extra.join(", ") + ")" : ""));
    }
    rebuildSoon(0);
}

// the engine picks up new params with a rebuild (no notes held: up to ~2 s, then anyway)
function rebuildSoon(tries) {
    if ((held > 0 || mirror) && tries < 20) {
        var t = new Task(function () { rebuildSoon(tries + 1); }, this);
        t.schedule(100);
        return;
    }
    build();
}

// a name this track doesn't have: say why (and where it is, when it is somewhere else)
function whyNot(ch, n, have) {
    var plain = n.replace(/^~/, "");
    if (n.charAt(0) === "~" && have[plain]) {
        return "track " + ch + ": " + plain + " is in the rack chain, not after the rack - use it without static";
    }
    if (n.charAt(0) !== "~" && have["~" + n]) {
        return "track " + ch + ": " + n + " is after the rack (whole track) - use static (" + n + " ...)";
    }
    var dev = catalogDeviceOf(plain);
    if (dev) {
        return "track " + ch + ": no " + dev + " " + (n.charAt(0) === "~" ? "after the rack" : "in chain 1") +
               " - add it there and click update (" + plain + " is " + dev + "'s)";
    }
    return "track " + ch + ": no effect has a param called " + plain;
}

// update: chain 1 + track effects -> library (names, CC per track, resting values) -> files -> rebuild
function update(note) {
    if (!apiReady()) { notReady("update"); return updateEnd(false, "Live API not ready", true); }
    if (!findHome()) { noHome("update"); return updateEnd(false, "can't find ~/.config/tidal", true); }
    if (held > 0) { return updateEnd(false, "update: notes are playing - stop first"); }
    if (mirror) { return updateEnd(false, "update: still mirroring - wait"); }
    var t0 = now();
    calls = 0; api = null;
    syncChannel();
    var ch = trackChannel();
    if (!ch) { return updateEnd(false, "update: set the track number (1-16) in the 'channel' box first"); }
    var clash = channelClash(ch);
    if (clash) { return updateEnd(false, "update: track \"" + clash + "\" also uses channel " + ch + " - give this track its own number"); }
    if (!stateBox()) { noStateBox("update"); return updateEnd(false, "no [pattr efxstate] in EventFX", true); }
    var rules = readRules();
    myState = loadState();
    var lib = setLibrary();
    lib.tracks[String(ch)] = myState ? clone(myState) : { fx: {}, on: [] };

    var scan = scanPalette(rules);
    if (scan.error) { return updateEnd(false, "update: " + scan.error); }
    var rep = mergeTrack(lib, ch, scan.entries, {});     // no new CCs: those come on first use
    if (rep.error) { return updateEnd(false, "update: " + rep.error); }

    saveState(lib.tracks[String(ch)]);
    if (!writeTidal(setLibrary())) { return updateEnd(false, "update: cannot write " + TIDAL_FILE); }

    var i;
    if (rep.added.length) { post("EventFX: new: " + rep.added.join(", ") + "\n"); }
    if (rep.dormant.length) { post("EventFX: not in the palette any more (CC kept for old clips until the pool is full): " + rep.dormant.join(", ") + "\n"); }
    if (rep.reclaimed.length) { post("EventFX: CC pool full, CC taken from: " + rep.reclaimed.join(", ") + "\n"); }
    if (rep.warn.length) { post("EventFX: same name, other param: " + rep.warn.join("; ") + "\n"); }
    if (scan.noPrimary.length) { post("EventFX: no main param found in: " + scan.noPrimary.join(", ") + " - add it to primaryByDevice in fx-rules.json\n"); }
    post("EventFX: toolz-fx.tidal rewritten - Neovim reloads it in Tidal (or :CheckTidal)\n");
    var msg = "update: track " + ch + ": " + rep.mapped + " params with a CC, " + rep.known +
              " more get one on first use" + (rep.dormant.length ? ", " + rep.dormant.length + " dormant" : "");

    // resting values of the mapped chain params, for the mirror (the others: as in chain 1)
    var tr = lib.tracks[String(ch)], restMap = {}, onKeys = {};
    for (i = 0; i < tr.on.length; i++) { onKeys[tr.on[i].key] = true; }
    for (i = 0; i < scan.entries.length; i++) {
        var e = scan.entries[i];
        if (e.tier !== "chain") { continue; }
        var f = e.tidal ? tr.fx[e.tidal] : null;
        if (f) { restMap[e.device + "/" + e.param + "#" + e.occurrence] = restOf(f); }
        else if (e.role === "auto" && onKeys[e.key]) { restMap[e.device + "/" + e.param + "#" + e.occurrence] = e.min; }
    }
    ready = false;                               // no CC handling while the chains change
    say(msg + " - mirroring chains...");
    startMirror(restMap, function (error, report, problems) {
        build();
        if (error) { return updateEnd(false, msg + ", mirror stopped: " + error); }
        var done = msg + "; mirror: " + report + (problems ? " - " + problems + " problems, see console" : "") +
                   " (" + (now() - t0) + " ms)";
        say(done);
        if (typeof note === "string" && note) { say(note); }
        updateEnd(!problems, problems ? done : nChains + " chains", true);
    });
}

// chains N: add chains at the end of the rack up to N, then update (the mirror fills them,
// ChainWatch included). Removing chains and setting Chain Select zones stay manual.
function chains(n) {
    if (!apiReady()) { notReady("chains"); return; }
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

// refill: load the preset instruments / racks of chain 1 again in every other chain (after saving
// a changed preset under the same name, e.g. new samples on the pads), then update
function refill() {
    refillNext = true;
    update();
}

// rest: the current knob positions in chain 1 / on the track become the resting values
// (click [neutral] first, then turn the knobs you want to change, then [rest]);
// main params listed in neutralPrimary (Dry/Wet, Amount...) keep their fixed resting value
function rest() {
    if (!apiReady()) { notReady("rest"); return; }
    if (!findHome()) { noHome("rest"); return; }
    if (held > 0) { say("rest: notes are playing - stop first"); return; }
    if (!stateBox()) { noStateBox("rest"); return; }
    var ch = trackChannel(), rules = readRules();
    myState = loadState();
    if (!ch || !myState) { say("rest: no palette for this track - click update"); return; }
    calls = 0; api = null;
    var scan = scanPalette(rules);
    if (scan.error) { say("rest: " + scan.error); return; }
    var tr = clone(myState), changed = 0;
    for (var i = 0; i < scan.entries.length; i++) {
        var e = scan.entries[i], f = e.tidal ? tr.fx[e.tidal] : null;
        if (!f) { continue; }
        if (e.role === "primary" && rules.neutralPrimary[e.param] !== undefined) { continue; }   // Dry/Wet etc. stay 0
        if (restOf(f) !== e.value) { changed++; }
        f.rest = e.value;
        delete f.neutral; delete f.log;
    }
    saveState(tr);
    build();
    neutral();                                   // new resting values into every chain right away
    say("rest: " + changed + " resting values changed, all chains set");
}

// sets from before the palette lived in the set: their CCs are in ~/.config/tidal/fx-library.json
function oldLibraryHas(ch) {
    if (!findHome()) { return false; }
    var lib = readJson(LIB_FILE);
    return !!(lib && lib.tracks && lib.tracks[String(ch)]);
}

// importold: this track's palette from the old fx-library.json into this set (once per old set,
// so clips recorded with those CCs keep working), then update
function importold() {
    if (!apiReady()) { notReady("importold"); return; }
    if (!findHome()) { noHome("importold"); return; }
    if (!stateBox()) { noStateBox("importold"); return; }
    if (held > 0) { say("importold: notes are playing - stop first"); return; }
    var ch = trackChannel();
    if (!ch) { say("importold: set the track number (1-16) in the 'channel' box first"); return; }
    var lib = readJson(LIB_FILE);
    if (!lib || !lib.tracks || !lib.tracks[String(ch)]) { say("importold: fx-library.json has no palette for channel " + ch); return; }
    var tr = clone(lib.tracks[String(ch)]);
    for (var n in tr.fx) {                       // entries older than v2 kept device/param in lib.params
        var lp = lib.params && lib.params[n];
        if (lp && !tr.fx[n].device) { tr.fx[n].device = lp.device; tr.fx[n].param = lp.param; tr.fx[n].occurrence = lp.occurrence || 0; }
    }
    if (!tr.on) { tr.on = []; }
    saveState(tr);
    update("importold: channel " + ch + " palette taken from fx-library.json - save the set to keep it");
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

// true once Live has initialised the API for this device (live.thisdevice has fired)
var apiOk = false;
function apiReady() {
    if (apiOk) { return true; }
    var probe = new LiveAPI("this_device");
    apiOk = Number(probe.id) > 0;
    return apiOk;
}

function notReady(what) {
    say(what + ": EventFX is still loading (Live API not ready) - wait a moment or click reload");
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
    if (!apiReady()) { retryLater("Live API not ready"); return; }
    syncChannel();
    var ch = trackChannel();
    if (!ch) { say("set the track number (1-16) in the 'channel' box, then click update"); return; }
    if (!stateBox()) { noStateBox("init"); return; }
    myState = loadState();
    var cl = clashWith(ch);
    if (cl && cl.older) {                     // this track is the copy: renumber it
        var nc = renumber(ch);
        if (!nc) { return; }
        ch = nc;
    }
    var lib = setLibrary();
    writeTidal(lib);                          // toolz-fx.tidal follows the set that is open
    var entries = libraryEntries(lib, ch, readRules());
    if (!entries) {
        say(pendingNote || ("no palette in this set for track " + ch + " - click update" +
                            (oldLibraryHas(ch) ? " (or importold: CCs from the old fx-library.json)" : "")));
        pendingNote = null;
        return;
    }
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

        // tier: "track" = the device after the rack (static in Tidal), "chain" = the rack chains;
        // older entries have none: the track's device if there is one, else the chains
        var dev = e.tier === "chain" ? null : scan.devices[dname];
        if (dev && dev[pname] && dev[pname][occ]) {
            p.track = dev[pname][occ];
            p.devTrack = (dev["Device On"] && dev["Device On"][0]) || 0;
            onTrack++;
        } else if (e.tier !== "track") {
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

    // a rack is expected but not there: Live may still be loading (retry a few times), or this
    // track simply has no tidal rack (EventFX dropped on an empty track)
    if (!scan.rackName && missing.length) {
        if (retries < 3) { retryLater("rack not found yet"); return; }
        ready = false;
        say("no Instrument Rack on this track - EventFX needs the tidal rack right after it " +
            "(duplicate a tidal track instead), then click reload");
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
    say("track " + ch + ": " + onTrack + " track params, " + inChains + " chain params x " + nChains + " chains, " +
        missing.length + " skipped, " + nAuto + " auto on/off, " + nOn + " always on (" +
        calls + " LOM calls, " + (now() - t0) + " ms)");
    if (pendingNote) { say(pendingNote); pendingNote = null; }
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
