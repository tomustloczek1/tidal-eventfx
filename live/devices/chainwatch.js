// chainwatch.js - tells EventFX whether this rack chain is sounding
//
// Lives in ChainWatch (a Max Audio Effect placed LAST in every chain of the rack).
// At load it finds its own track id and chain index through the Live Object Model,
// then turns "state 0|1" (from the level detector in the patch) into
// "<trackId> <chain> <state>" for [s efx_busy].
//
// Messages:
//   init       - identify track and chain (send after live.thisdevice)
//   state 0|1  - silent / sounding

autowatch = 1;
inlets = 1;
outlets = 1;

var trackId = 0;
var chain = -1;
var last = -1;
var tries = 0;

function init() {
    tries = 0;
    identify();
}

function idOf(api) {
    return Number(api.id) || 0;
}

function identify() {
    var chainApi = new LiveAPI("this_device canonical_parent");
    var rackApi  = new LiveAPI("this_device canonical_parent canonical_parent");
    var trackApi = new LiveAPI("this_device canonical_parent canonical_parent canonical_parent");

    var chainId = idOf(chainApi), rackId = idOf(rackApi), tid = idOf(trackApi);
    if (!chainId || !rackId || !tid) {
        if (tries++ < 10) {
            var t = new Task(identify, this);
            t.schedule(1000);
        } else {
            post("ChainWatch: could not find my chain - is this device inside a rack chain?\n");
        }
        return;
    }

    var list = rackApi.get("chains");
    var index = -1, k = 0;
    if (list instanceof Array) {
        for (var i = 0; i < list.length; i++) {
            if (list[i] === "id") { continue; }
            if (Number(list[i]) === chainId) { index = k; break; }
            k++;
        }
    }
    if (index < 0) {
        post("ChainWatch: my chain is not in the rack chain list\n");
        return;
    }

    trackId = tid;
    chain = index;
    last = -1;
    post("ChainWatch: track " + trackId + ", chain " + chain + "\n");
}

function state(s) {
    if (chain < 0) { return; }
    s = s ? 1 : 0;
    if (s === last) { return; }
    last = s;
    outlet(0, trackId, chain, s);
}
