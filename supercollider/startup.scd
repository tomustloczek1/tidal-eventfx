// ============================================================
// startup.scd  —  Tidal + Ableton (4 orbity audio + 8 kanałów MIDI)
// ============================================================

// --- 1. Lista urządzeń --------------------------------------
~listDevices = {
    "--- OUT ---".postln;
    ServerOptions.outDevices.do { |d, i| ("  " ++ i ++ ": " ++ d).postln };
    "--- IN (opcjonalne) ---".postln;
    ServerOptions.inDevices.do  { |d, i| ("  " ++ i ++ ": " ++ d).postln };
    "";
};

// --- 2. Opcje serwera ---------------------------------------
// inIdx = nil  -> wejście wyłączone (domyślnie), jedno urządzenie in+out
// inIdx = int  -> osobne wejście z listy ServerOptions.inDevices
//
// UWAGA 1: inDevice_(nil) / outDevice_(nil) NIE znaczy "brak" — znaczy
// "urządzenie systemowe". Jeśli słuchawki BT są podłączone przy boocie,
// scsynth otworzy ich mikrofon -> HFP -> 16 kHz.
//
// UWAGA 2: device_ to skrót ustawiający inDevice I outDevice naraz.
// Nie mieszamy go z inDevice_/outDevice_ — ustawiamy oba kierunki jawnie.
//
// BlackHole 16ch ma 16 in i 16 out i nie ma mikrofonu, więc jedno
// urządzenie na oba kierunki jest bezpieczne.
~applyServerOptions = { |inIdx|
    var inName, devName;
    s.options.numBuffers = 1024 * 256;
    s.options.memSize = 8192 * 32;
    s.options.maxNodes = 1024 * 32;
    s.options.numOutputBusChannels = 8;   // 4 orbity stereo -> BlackHole
    s.options.hardwareBufferSize = 1024;
    s.options.blockSize = 128;
    s.options.numWireBufs = 64 * 16;      // FIX na "exceeded interconnect buffers"
    s.options.sampleRate = 44100;         // musi zgadzać się z BlackHole i Live

    // domyślnie: jedno urządzenie na oba kierunki, wejście wyłączone
    s.options.inDevice_(~preferredDevice);
    s.options.outDevice_(~preferredDevice);
    s.options.numInputBusChannels_(0);

    devName = (~preferredDevice ? "").asString;
    if(devName.contains("BlackHole").not and: { devName.contains("Speakers").not }) {
        ("WARNING: " ++ (~preferredDevice ? "system default")
            ++ " is used for input too — Bluetooth headphones may switch to HFP (16 kHz)").postln;
    };

    if(inIdx.notNil) {
        inName = ServerOptions.inDevices[inIdx];
        if(inName.isNil) {
            ("Invalid input index: " ++ inIdx ++ " — input stays disabled").postln;
        } {
            if(inName.asString.contains("Microphone").not) {
                ("WARNING: input " ++ inName
                    ++ " — if these are Bluetooth headphones, they will switch to HFP (mono, 16 kHz)").postln;
            };
            s.options.outDevice_(~preferredDevice);
            s.options.inDevice_(inName);
            s.options.numInputBusChannels_(2);
            ("IN: " ++ inName).postln;
        };
    };
};

// --- 3. MIDI (IAC -> Ableton Live) --------------------------
~bootMidi = {
    var hasIAC;
    MIDIClient.init;
    hasIAC = MIDIClient.destinations.detect { |d|
        d.device.asString.contains("IAC")
    }.notNil;

    if(hasIAC) {
        ~mNote = MIDIOut.newByName("IAC Driver", "Bus 1");
        ~mCtl  = MIDIOut.newByName("IAC Driver", "Bus 2");
        ~mNote.latency = 0;
        ~mCtl.latency  = 0;
        ~dirt.soundLibrary.addMIDI(\m,   ~mNote);   // nuty   -> s "m"
        ~dirt.soundLibrary.addMIDI(\ctl, ~mCtl);    // CC     -> s "ctl"
        "MIDI: IAC Bus 1 (notes) + Bus 2 (cc)".postln;
    } {
        "IAC Driver offline — Audio MIDI Setup > Window > Show MIDI Studio".postln;
    };
};

// --- 4. Diagnostyka -----------------------------------------
~report = {
    "".postln;
    "════════════════════════════════════════".postln;
    ("OUT device  : " ++ (s.options.outDevice ? "SYSTEM DEFAULT")).postln;
    ("IN  device  : " ++ (s.options.inDevice ? "SYSTEM DEFAULT")).postln;
    ("sampleRate  : " ++ s.sampleRate ++ "  (requested: " ++ s.options.sampleRate ++ ")").postln;
    ("in  channels: " ++ s.options.numInputBusChannels).postln;
    ("out channels: " ++ s.options.numOutputBusChannels).postln;
    ("orbits      : " ++ (~dirt.notNil).if({ ~dirt.orbits.size }, { "—" })).postln;
    ("synthdefs   : " ++ SynthDescLib.global.synthDescs.size).postln;
    ("MIDI notes  : " ++ (~mNote.notNil).if({ "ok" }, { "—" })).postln;
    if(s.sampleRate != s.options.sampleRate) {
        "!! SAMPLE RATE MISMATCH — check BlackHole in Audio MIDI Setup".postln;
    };
    if(s.options.outDevice.isNil or: { s.options.inDevice.isNil }) {
        "!! SYSTEM DEFAULT DEVICE IN USE — Bluetooth headphones may be grabbed".postln;
    };
    "════════════════════════════════════════".postln;
};

// --- 5. Boot SuperDirt (wywoływalny ponownie) ---------------
~bootDirt = {
    var samplesDefault, samplesCustom, drumMachines, drumNameFunc;
    samplesDefault = "~/Library/Application Support/SuperCollider/downloaded-quarks/Dirt-Samples".standardizePath;
    samplesCustom  = "~/Documents/tidal/samples".standardizePath;
    // quark: Quarks.install("https://github.com/geikha/tidal-drum-machines.git");
    drumMachines = Quarks.all.detect({ |q| q.name == "tidal-drum-machines" });
    drumNameFunc = { |path| path.basename.replace("-", "") };

    ~dirt = SuperDirt(2, s);
    ~dirt.loadSoundFiles(samplesDefault ++ "/*");

    if(drumMachines.notNil) {
        ~dirt.loadSoundFiles(
            drumMachines.localPath +/+ "machines" +/+ "*" +/+ "*",
            namingFunction: drumNameFunc
        );
        ("Loaded tidal-drum-machines from: " ++ drumMachines.localPath).postln;
    } {
        "tidal-drum-machines quark not installed — skipping".postln;
    };

    if(File.exists(samplesCustom)) {
        ~dirt.loadSoundFiles(samplesCustom ++ "/*");
        ("Loaded custom samples from: " ++ samplesCustom).postln;
    } {
        ("Custom sample folder not found: " ++ samplesCustom).postln;
    };

    // orbity 0-3 na osobne pary kanałów, 4-11 (MIDI) na kanał 0
    ~dirt.start(57120, [0, 2, 4, 6] ++ (0 ! 8));

    // reverb i delay robi Ableton przez sendy
    ~dirt.orbits.do { |o| o.set(\room, 0, \size, 0) };

    ~bootMidi.();

    "==== SuperDirt ready ====".postln;
    s.sync;
    ~report.();
};

// --- 6. Zmiana urządzenia -----------------------------------
// ~setDevice.(nil)   -> urządzenie systemowe (uwaga na słuchawki BT!)
// ~setDevice.(3)     -> urządzenie 3 na in+out, wejście wyłączone
// ~setDevice.(3, 1)  -> wyjście 3, wejście 1
~setDevice = { |outIdx, inIdx|
    var outName;
    outName = if(outIdx.isNil) { nil } { ServerOptions.outDevices[outIdx] };
    if(outIdx.notNil and: { outName.isNil }) {
        ("Invalid output index: " ++ outIdx).postln;
    } {
        ~preferredDevice = outName;
        ~currentInput = inIdx;
        ("OUT: " ++ (outName ? "system default")).postln;
        Routine {
            if(s.serverRunning) {
                if(~dirt.notNil) { ~dirt.free; ~dirt = nil };
                ~mNote = nil; ~mCtl = nil;
                s.quit;
                1.5.wait;
            };
            ~applyServerOptions.(inIdx);
            s.waitForBoot { ~bootDirt.() };
        }.play(AppClock);
    };
};

// skrót: wybierz urządzenie po nazwie zamiast po indeksie
~setDeviceNamed = { |name, inIdx|
    var idx = ServerOptions.outDevices.detectIndex { |d| d.asString.contains(name) };
    if(idx.isNil) {
        ("Device not found: " ++ name).postln;
        ~listDevices.();
    } {
        ~setDevice.(idx, inIdx);
    };
};

// --- 7. Start ------------------------------------------------
~currentInput = nil;
~preferredDevice = ServerOptions.outDevices.detect { |d|
    d.asString.contains("BlackHole")
} ?? {
    // fallback: wbudowane głośniki (urządzenie bez mikrofonu),
    // nigdy systemowe — to mogą być słuchawki BT
    ServerOptions.outDevices.detect { |d| d.asString.contains("Speakers") }
};

if(~preferredDevice.isNil) {
    "No BlackHole and no built-in speakers found — using system default".postln;
} {
    ("OUT: " ++ ~preferredDevice).postln;
};

~applyServerOptions.(~currentInput);
s.waitForBoot { ~bootDirt.() };

if(\SCLOrkSynths.asClass.notNil, {
    SCLOrkSynths.load;
}, {
    "SCLOrkSynths not installed — skipping".postln;
});
