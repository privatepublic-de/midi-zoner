#!/usr/bin/env python3
"""Generates the factory device presets in res/device-presets/ (one JSON file per preset).

Values come from the KORG MIDI implementation charts, corrected where measurements on
the hardware differed. Edit the presets here and rerun:

    python3 scripts/gen-device-presets.py [output dir]
"""
import json, os, sys

OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "res", "device-presets")

def base(label, typ, group, **kw):
    c = {"type": typ, "label": label, "number": 1, "val": 0, "min": 0, "max": 127,
         "note_cc": None, "velocity_cc": None}
    if group: c["group"] = group
    c.update(kw)
    return c

# minilogue xd: 10 bit, low 3 bits on CC63 first
def xd10(label, cc, group=0, bipolar=False, val=None):
    return base(label, 6 if bipolar else 5, group, number=cc, number_lsb=63, lsb_bits=3,
                val=val if val is not None else (8192 if bipolar else 0))

# NTS-1 mkII: MSB/LSB pair, MSB first
def pair(label, msb, lsb, group=0, val=None, bipolar=False):
    return base(label, 6 if bipolar else 5, group, number=msb, number_lsb=lsb, lsb_bits=7, msb_first=True,
                val=val if val is not None else (8192 if bipolar else 0))

def cc7(label, cc, group=0, val=0, discrete=None, names=None):
    c = base(label, 0, group, number=cc, val=val)
    if discrete: c["discreteValues"] = discrete
    if names:
        assert not discrete or len(names) == len(discrete), label
        c["valueNames"] = names
    return c

def selector(label, cc, items, group=0, val=None):
    """A list of named values, each sent as is: [(name, value), ...]"""
    return base(label, 9, group, number=cc, val=items[0][1] if val is None else val,
                discreteValues=[v for _, v in items], valueNames=[n for n, _ in items])

def buttons(label, cc, items, group=0, val=None):
    c = base(label, 3, group, number=cc, val=items[0][1] if val is None else val)
    for i, (l, v) in enumerate(items):
        c[f"buttonlabel{i}"] = l
        c[f"buttonvalue{i}"] = v
    return c

def nrpn(label, msb, lsb, mn, mx, group=0, data_lsb=None, bits=0, val=0, bipolar=False, names=None):
    c = base(label, 7, group, nrpn_msb=msb, nrpn_lsb=lsb, min=mn, max=mx,
             nrpn_data_lsb_cc=data_lsb, nrpn_data_lsb_bits=bits, val=val)
    if bipolar: c["bipolar"] = True
    if names:
        assert len(names) == mx - mn + 1, label
        c["valueNames"] = names
    return c

def with_sections(controllers, sections):
    """A section entry wherever the colour group changes; its controllers take its colour.
    sections: group -> name, or (name, new_row) to continue the row instead."""
    out, current = [], None
    for c in controllers:
        group = c.pop("group", 0)
        if group != current:
            current = group
            name, new_row = sections[group] if isinstance(sections[group], tuple) else (sections[group], True)
            section = {"type": 8, "label": name, "number": 0, "val": 0, "min": 0, "max": 127,
                       "note_cc": None, "velocity_cc": None}
            if group: section["group"] = group
            if not new_row: section["new_row"] = False
            out.append(section)
        out.append(c)
    return out

def write(file, name, device, port, notes, controllers, sections):
    p = {"format": "midi-zoner-device-preset", "version": 1, "name": name, "device": device,
         "portMatch": port, "notes": notes, "controllers": with_sections(controllers, sections)}
    with open(os.path.join(OUT, file + ".json"), "w") as f:
        json.dump(p, f, indent=2, ensure_ascii=False)
        f.write("\n")

XD, XDP = "KORG minilogue xd", "minilogue xd"
XD_NOTE = "Needs GLOBAL > MIDI Rx CC = On. 10-bit knobs send the low 3 bits on CC63, then the upper 7 bits."
WAVE = [("SQR", 0), ("TRI", 64), ("SAW", 127)]
OCT = [("16'", 0), ("8'", 42), ("4'", 84), ("2'", 127)]
ONOFF = [("Off", 0), ("On", 127)]
THREE = [("0%", 0), ("50%", 64), ("100%", 127)]

write("korg-minilogue-xd-vcos", "VCOs & mixer", XD, XDP, XD_NOTE + " SYNC/RING: the chart contradicts itself on which value is On; swap the button values if they act inverted.", [
    buttons("VCO1 wave", 50, WAVE, 1, 127), buttons("VCO1 oct", 48, OCT, 1, 42),
    xd10("VCO1 pitch", 34, 1, bipolar=True), xd10("VCO1 shape", 36, 1),
    buttons("VCO2 wave", 51, WAVE, 2, 127), buttons("VCO2 oct", 49, OCT, 2, 42),
    xd10("VCO2 pitch", 35, 2, bipolar=True), xd10("VCO2 shape", 37, 2),
    buttons("Sync", 80, ONOFF, 3), buttons("Ring", 81, ONOFF, 3), xd10("Cross mod", 41, 3),
    xd10("VCO1 level", 39, 0, val=16383), xd10("VCO2 level", 40, 0), xd10("Multi level", 33, 0),
], {1: "VCO 1", 2: "VCO 2", 3: "Sync & ring", 0: "Mixer"})

write("korg-minilogue-xd-multi", "Multi engine", XD, XDP, XD_NOTE + " Type selects, octave, VPM and USER params are NRPN (MSB 0, data on CC63 + CC6). USER PARAM ranges depend on the loaded oscillator: Max 100 fits percent and select params, set Max to 200 for bipolar ones.", [
    buttons("Multi type", 53, [("Noise", 0), ("VPM", 64), ("User", 127)], 1),
    nrpn("Noise type", 0, 0x11, 0, 3, 1, names=["High", "Low", "Peak", "Decim"]),
    nrpn("VPM type", 0, 0x12, 0, 15, 1, names=["Sin1", "Sin2", "Sin3", "Sin4", "Saw1", "Saw2", "Squ1", "Squ2", "Fat1", "Fat2", "Air1", "Air2", "Decay1", "Decay2", "Creep", "Throat"]),
    nrpn("User osc", 0, 0x13, 0, 15, 1, names=[f"User {i + 1}" for i in range(16)]),
    xd10("Shape", 54, 1), xd10("Shift shape", 104, 1), nrpn("Multi oct", 0, 0x3A, 0, 3, 1, val=5461, names=["16'", "8'", "4'", "2'"]),
    nrpn("Feedback", 0, 0x40, 0, 200, 2, 63, 3, 8192, bipolar=True), nrpn("Noise depth", 0, 0x41, 0, 200, 2, 63, 3, 8192, bipolar=True),
    nrpn("Shape mod", 0, 0x42, 0, 200, 2, 63, 3, 8192, bipolar=True), nrpn("Mod attack", 0, 0x43, 0, 200, 2, 63, 3, 8192, bipolar=True),
    nrpn("Mod decay", 0, 0x44, 0, 200, 2, 63, 3, 8192, bipolar=True), nrpn("Mod keytrk", 0, 0x45, 0, 200, 2, 63, 3, 8192, bipolar=True),
] + [nrpn(f"User P{i + 1}", 0, 0x48 + i, 0, 100, 3, 63, 3) for i in range(6)], {1: "Multi engine", 2: "VPM", 3: "User oscillator"})

write("korg-minilogue-xd-filter-eg", "Filter & envelopes", XD, XDP, XD_NOTE, [
    xd10("Cutoff", 43, 1, val=16383), xd10("Resonance", 44, 1),
    buttons("Drive", 84, THREE, 1), buttons("Keytrack", 83, THREE, 1),
    xd10("Amp A", 16, 2), xd10("Amp D", 17, 2, val=8192), xd10("Amp S", 18, 2, val=16383), xd10("Amp R", 19, 2, val=2048),
    xd10("EG A", 20, 3), xd10("EG D", 21, 3, val=8192), xd10("EG int", 22, 3, bipolar=True),
    buttons("EG target", 23, [("Cutoff", 0), ("Pitch 2", 64), ("Pitch", 127)], 3),
], {1: "Filter", 2: "Amp EG", 3: "Mod EG"})

write("korg-minilogue-xd-lfo", "LFO & voice", XD, XDP, XD_NOTE, [
    buttons("LFO wave", 57, WAVE, 1, 64), buttons("LFO mode", 58, [("1-Shot", 0), ("Normal", 64), ("BPM", 127)], 1, 64),
    buttons("LFO target", 56, [("Cutoff", 0), ("Shape", 64), ("Pitch", 127)], 1, 127),
    xd10("LFO rate", 24, 1, val=8192), xd10("LFO int", 26, 1),
    xd10("Voice depth", 27, 2), cc7("Portamento", 5, 2),
], {1: "LFO", 2: ("Voice", False)})

write("korg-minilogue-xd-effects", "Effects", XD, XDP, XD_NOTE + " Sub type knobs step through the presets of the current effect type.", [
    buttons("Mod FX", 92, ONOFF, 1),
    buttons("Mod type", 88, [("Chor", 0), ("Ens", 38), ("Phas", 64), ("Flng", 84), ("User", 127)], 1),
    cc7("Mod sub", 96, 1, discrete=[0, 16, 32, 48, 64, 80, 96, 127]),
    xd10("Mod time", 28, 1, val=8192), xd10("Mod depth", 29, 1, val=8192),
    buttons("Delay", 93, ONOFF, 2),
    selector("Delay type", 89, list(zip(["Stereo", "Mono", "Ping pong", "Hipass", "Tape", "One tap", "Stereo BPM", "Mono BPM", "Ping BPM", "Hipass BPM", "Tape BPM", "Doubling"] + [f"User {i + 1}" for i in range(8)],
                                        [0, 7, 13, 20, 26, 32, 39, 45, 52, 58, 64, 71, 77, 84, 90, 96, 103, 109, 116, 127])), 2),
    xd10("Delay time", 105, 2, val=8192), xd10("Delay depth", 106, 2, val=8192), xd10("Delay mix", 107, 2, val=8192),
    buttons("Reverb", 94, ONOFF, 3),
    selector("Reverb type", 90, list(zip(["Hall", "Smooth", "Arena", "Plate", "Room", "Early ref", "Space", "Riser", "Submarine", "Horror"] + [f"User {i + 1}" for i in range(8)],
                                         [0, 8, 15, 22, 29, 36, 43, 50, 57, 64, 72, 79, 86, 93, 100, 107, 117, 127])), 3),
    xd10("Reverb time", 108, 3, val=8192), xd10("Reverb depth", 109, 3, val=8192), xd10("Reverb mix", 110, 3, val=8192),
], {1: "Mod FX", 2: "Delay", 3: "Reverb"})

NTS, NTSP = "KORG NTS-1 mkII", "NTS-1"

# The NTS-1 mkII spreads its type lists in steps of 8 (measured on the device; the chart's values are
# wrong): built-in types first, then the user unit slots up to 127
def nts_types(label, cc, group, builtins):
    names = builtins + [f"User {i + 1}" for i in range((127 - 8 * len(builtins)) // 8 + 1)]
    return selector(label, cc, [(n, 8 * i) for i, n in enumerate(names)], group)
NTS_NOTE = "Needs GLOBAL > MIDI Short Message = On. Knobs send the MSB CC first, then the LSB CC; if they move in coarse steps, switch Format to LSB first."
NTS_NRPN = "Needs GLOBAL > MIDI NRPN Message = On. NRPN with 14-bit data (CC38, then CC6). What each param does depends on the loaded unit."

write("korg-nts-1-mkii-main", "Oscillator, filter & EG", NTS, NTSP, NTS_NOTE + " Osc type uses values measured on the device (CC53: Saw 16, Tri, Sqr, VPM, Noise, then User 1–9 in steps of 8 up to 120; the MIDI chart values are wrong); choosing an empty user slot keeps the last occupied one. LFO depth: negative = pitch, positive = shape modulation. Sweep depth: negative = up, positive = down.", [
    selector("Osc type", 53, [("Saw", 16), ("Tri", 24), ("Sqr", 32), ("VPM", 40), ("Noise", 48)] + [(f"User {i + 1}", 56 + 8 * i) for i in range(9)], 1),
    pair("Osc A", 54, 102, 1), pair("Osc B", 55, 103, 1), pair("LFO rate", 24, 56, 1), pair("LFO depth", 26, 58, 1, bipolar=True),
    buttons("Filter", 42, [("LP2", 0), ("LP4", 18), ("BP2", 36), ("BP4", 54), ("HP2", 72), ("HP4", 90), ("Thru", 127)], 2),
    pair("Cutoff", 43, 107, 2, 16383), pair("Resonance", 44, 108, 2), pair("Sweep depth", 45, 109, 2, bipolar=True), pair("Sweep rate", 46, 110, 2),
    buttons("EG type", 14, [("ADSR", 0), ("AHR", 25), ("AR", 50), ("Loop", 75), ("Open", 127)], 3),
    pair("Attack", 16, 48, 3), pair("Release", 19, 49, 3, 4096), pair("Trem depth", 20, 50, 3), pair("Trem rate", 21, 51, 3),
], {1: "Oscillator", 2: "Filter", 3: "Envelope"})

write("korg-nts-1-mkii-effects", "Effects", NTS, NTSP, NTS_NOTE + " Type knobs step through Off, the built-in effects and the user slots in steps of 8 (measured on the device; the MIDI chart values are wrong). Choosing an empty user slot keeps the last occupied one.", [
    nts_types("Mod type", 88, 1, ["Off", "Chorus", "Ensemble", "Phaser", "Flanger", "Soft clip", "Hard clip", "Sine fold", "Fuzz"]), pair("Mod A", 28, 60, 1), pair("Mod B", 29, 61, 1),
    nts_types("Delay type", 89, 2, ["Off", "Stereo", "Mono", "Ping pong", "Highpass", "Tape", "One", "Stereo BPM", "Mono BPM", "Ping BPM", "High BPM", "Tape BPM", "Doubling"]),
    pair("Delay A", 30, 62, 2), pair("Delay B", 31, 63, 2), pair("Delay mix", 33, 113, 2, 8192),
    nts_types("Reverb type", 90, 3, ["Off", "Hall", "Smooth", "Arena", "Plate", "Room", "Early", "Space", "Riser", "Submarine", "Horror"]),
    pair("Reverb A", 34, 114, 3), pair("Reverb B", 35, 115, 3), pair("Reverb mix", 36, 116, 3, 8192),
], {1: "Mod", 2: "Delay", 3: "Reverb"})

write("korg-nts-1-mkii-arp", "Arp & volume", NTS, NTSP, NTS_NOTE, [
    selector("Arp pattern", 117, list(zip(["Up", "Down", "Up-Down", "Down-Up", "Converge", "Diverge", "Conv-Div", "Div-Conv", "Random", "Stochastic"],
                                          [0, 12, 24, 36, 48, 60, 72, 84, 96, 127])), 1),
    buttons("Intervals", 118, [("Oct", 0), ("Maj", 21), ("Sus", 42), ("Aug", 63), ("Min", 84), ("Dim", 127)], 1),
    cc7("Arp length", 119, 1), pair("Volume", 7, 39, 0, 12800),
], {1: "Arpeggiator", 0: ("Volume", False)})

write("korg-nts-1-mkii-osc-params", "Oscillator unit params", NTS, NTSP, NTS_NRPN,
      [nrpn(f"Osc P{i + 1}", 0, i, 0, 16383, 1, 38, 7) for i in range(8)], {1: "Oscillator unit"})

write("korg-nts-1-mkii-fx-params", "Effect unit params", NTS, NTSP, NTS_NRPN,
      [nrpn(f"{fx} P{i + 1}", m, i, 0, 16383, g, 38, 7) for m, fx, g in ((1, "Mod", 1), (2, "Delay", 2), (3, "Reverb", 3)) for i in range(8)], {1: "Mod unit", 2: "Delay unit", 3: "Reverb unit"})
