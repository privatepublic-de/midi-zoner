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
    sections: group -> name, or (name, new_row) to continue the row instead. Controllers with
    a "sec" key start their own section under that key (two sections sharing a colour)."""
    out, current = [], None
    for c in controllers:
        if c["type"] == 10:
            out.append(c)
            current = None
            continue
        group = c.pop("group", 0)
        key = c.pop("sec", group)
        if key != current:
            current = key
            name, new_row = sections[key] if isinstance(sections[key], tuple) else (sections[key], True)
            section = {"type": 8, "label": name, "number": 0, "val": 0, "min": 0, "max": 127,
                       "note_cc": None, "velocity_cc": None}
            if group: section["group"] = group
            if not new_row: section["new_row"] = False
            out.append(section)
        out.append(c)
    return out

def page(label):
    """Starts a page: the zone shows one page of controllers at a time"""
    return {"type": 10, "label": label, "number": 0, "val": 0, "min": 0, "max": 127,
            "note_cc": None, "velocity_cc": None}

def spread(names):
    """Evenly spread named values: the middle of each of len(names) equal ranges of 0–127"""
    return [(n, (256 * i + 128) // (2 * len(names))) for i, n in enumerate(names)]

def write(file, name, device, port, notes, controllers, sections):
    p = {"format": "midi-zoner-device-preset", "version": 1, "name": name, "device": device}
    if port: p["portMatch"] = port
    p.update(notes=notes, controllers=with_sections(controllers, sections))
    with open(os.path.join(OUT, file + ".json"), "w") as f:
        json.dump(p, f, indent=2, ensure_ascii=False)
        f.write("\n")

XD, XDP = "KORG minilogue xd", "minilogue xd"
XD_NOTE = "Needs GLOBAL > MIDI Rx CC = On. 10-bit knobs send the low 3 bits on CC63, then the upper 7 bits."
WAVE = [("SQR", 0), ("TRI", 64), ("SAW", 127)]
OCT = [("16'", 0), ("8'", 42), ("4'", 84), ("2'", 127)]
ONOFF = [("Off", 0), ("On", 127)]
THREE = [("0%", 0), ("50%", 64), ("100%", 127)]

write("korg-minilogue-xd-vcos", "VCOs", XD, XDP, XD_NOTE + " SYNC/RING: the chart contradicts itself on which value is On; swap the button values if they act inverted.", [
    buttons("VCO1 wave", 50, WAVE, 1, 127), buttons("VCO1 oct", 48, OCT, 1, 42),
    xd10("VCO1 pitch", 34, 1, bipolar=True), xd10("VCO1 shape", 36, 1),
    buttons("VCO2 wave", 51, WAVE, 2, 127), buttons("VCO2 oct", 49, OCT, 2, 42),
    xd10("VCO2 pitch", 35, 2, bipolar=True), xd10("VCO2 shape", 37, 2),
    buttons("Sync", 80, ONOFF, 3), buttons("Ring", 81, ONOFF, 3), xd10("Cross mod", 41, 3),
    xd10("VCO1 level", 39, 0, val=16383), xd10("VCO2 level", 40, 0), xd10("Multi level", 33, 0),
], {1: "VCO 1", 2: "VCO 2", 3: "Sync/Ring", 0: "Mixer"})

write("korg-minilogue-xd-multi", "Multi", XD, XDP, XD_NOTE + " Type selects, octave, VPM and USER params are NRPN (MSB 0, data on CC63 + CC6). USER PARAM ranges depend on the loaded oscillator: Max 100 fits percent and select params, set Max to 200 for bipolar ones.", [
    buttons("Multi type", 53, [("Noise", 0), ("VPM", 64), ("User", 127)], 1),
    nrpn("Noise type", 0, 0x11, 0, 3, 1, names=["High", "Low", "Peak", "Decim"]),
    nrpn("VPM type", 0, 0x12, 0, 15, 1, names=["Sin1", "Sin2", "Sin3", "Sin4", "Saw1", "Saw2", "Squ1", "Squ2", "Fat1", "Fat2", "Air1", "Air2", "Decay1", "Decay2", "Creep", "Throat"]),
    nrpn("User osc", 0, 0x13, 0, 15, 1, names=[f"User {i + 1}" for i in range(16)]),
    xd10("Shape", 54, 1), xd10("Shift shape", 104, 1), nrpn("Multi oct", 0, 0x3A, 0, 3, 1, val=5461, names=["16'", "8'", "4'", "2'"]),
    nrpn("Feedback", 0, 0x40, 0, 200, 2, 63, 3, 8192, bipolar=True), nrpn("Noise depth", 0, 0x41, 0, 200, 2, 63, 3, 8192, bipolar=True),
    nrpn("Shape mod", 0, 0x42, 0, 200, 2, 63, 3, 8192, bipolar=True), nrpn("Mod attack", 0, 0x43, 0, 200, 2, 63, 3, 8192, bipolar=True),
    nrpn("Mod decay", 0, 0x44, 0, 200, 2, 63, 3, 8192, bipolar=True), nrpn("Mod keytrk", 0, 0x45, 0, 200, 2, 63, 3, 8192, bipolar=True),
] + [nrpn(f"User P{i + 1}", 0, 0x48 + i, 0, 100, 3, 63, 3) for i in range(6)], {1: "Multi", 2: "VPM", 3: "User osc"})

write("korg-minilogue-xd-filter-eg", "Filter/EG", XD, XDP, XD_NOTE, [
    xd10("Cutoff", 43, 1, val=16383), xd10("Resonance", 44, 1),
    buttons("Drive", 84, THREE, 1), buttons("Keytrack", 83, THREE, 1),
    xd10("Amp A", 16, 2), xd10("Amp D", 17, 2, val=8192), xd10("Amp S", 18, 2, val=16383), xd10("Amp R", 19, 2, val=2048),
    xd10("EG A", 20, 3), xd10("EG D", 21, 3, val=8192), xd10("EG int", 22, 3, bipolar=True),
    buttons("EG target", 23, [("Cutoff", 0), ("Pitch 2", 64), ("Pitch", 127)], 3),
], {1: "Filter", 2: "Amp EG", 3: "Mod EG"})

write("korg-minilogue-xd-lfo", "LFO", XD, XDP, XD_NOTE, [
    buttons("LFO wave", 57, WAVE, 1, 64), buttons("LFO mode", 58, [("1-Shot", 0), ("Normal", 64), ("BPM", 127)], 1, 64),
    buttons("LFO target", 56, [("Cutoff", 0), ("Shape", 64), ("Pitch", 127)], 1, 127),
    xd10("LFO rate", 24, 1, val=8192), xd10("LFO int", 26, 1),
    xd10("Voice depth", 27, 2), cc7("Portamento", 5, 2),
], {1: "LFO", 2: ("Voice", False)})

write("korg-minilogue-xd-effects", "FX", XD, XDP, XD_NOTE + " Sub type knobs step through the presets of the current effect type.", [
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
], {1: "Mod", 2: "Delay", 3: "Reverb"})

NTS, NTSP = "KORG NTS-1 mkII", "NTS-1"

# The NTS-1 mkII spreads its type lists in steps of 8 (measured on the device; the chart's values are
# wrong): built-in types first, then the user unit slots up to 127
def nts_types(label, cc, group, builtins):
    names = builtins + [f"User {i + 1}" for i in range((127 - 8 * len(builtins)) // 8 + 1)]
    return selector(label, cc, [(n, 8 * i) for i, n in enumerate(names)], group)
NTS_NOTE = "Needs GLOBAL > MIDI Short Message = On. Knobs send the MSB CC first, then the LSB CC; if they move in coarse steps, switch Format to LSB first."
NTS_NRPN = "Needs GLOBAL > MIDI NRPN Message = On. NRPN with 14-bit data (CC38, then CC6). What each param does depends on the loaded unit."

write("korg-nts-1-mkii-main", "Osc/Filter", NTS, NTSP, NTS_NOTE + " Osc type uses values measured on the device (CC53: Saw 16, Tri, Sqr, VPM, Noise, then User 1–9 in steps of 8 up to 120; the MIDI chart values are wrong); choosing an empty user slot keeps the last occupied one. LFO depth: negative = pitch, positive = shape modulation. Sweep depth: negative = up, positive = down.", [
    selector("Osc type", 53, [("Saw", 16), ("Tri", 24), ("Sqr", 32), ("VPM", 40), ("Noise", 48)] + [(f"User {i + 1}", 56 + 8 * i) for i in range(9)], 1),
    pair("Osc A", 54, 102, 1), pair("Osc B", 55, 103, 1), pair("LFO rate", 24, 56, 1), pair("LFO depth", 26, 58, 1, bipolar=True),
    buttons("Filter", 42, [("LP2", 0), ("LP4", 18), ("BP2", 36), ("BP4", 54), ("HP2", 72), ("HP4", 90), ("Thru", 127)], 2),
    pair("Cutoff", 43, 107, 2, 16383), pair("Resonance", 44, 108, 2), pair("Sweep depth", 45, 109, 2, bipolar=True), pair("Sweep rate", 46, 110, 2),
    buttons("EG type", 14, [("ADSR", 0), ("AHR", 25), ("AR", 50), ("Loop", 75), ("Open", 127)], 3),
    pair("Attack", 16, 48, 3), pair("Release", 19, 49, 3, 4096), pair("Trem depth", 20, 50, 3), pair("Trem rate", 21, 51, 3),
], {1: "Osc", 2: "Filter", 3: "EG"})

write("korg-nts-1-mkii-effects", "FX", NTS, NTSP, NTS_NOTE + " Type knobs step through Off, the built-in effects and the user slots in steps of 8 (measured on the device; the MIDI chart values are wrong). Choosing an empty user slot keeps the last occupied one.", [
    nts_types("Mod type", 88, 1, ["Off", "Chorus", "Ensemble", "Phaser", "Flanger", "Soft clip", "Hard clip", "Sine fold", "Fuzz"]), pair("Mod A", 28, 60, 1), pair("Mod B", 29, 61, 1),
    nts_types("Delay type", 89, 2, ["Off", "Stereo", "Mono", "Ping pong", "Highpass", "Tape", "One", "Stereo BPM", "Mono BPM", "Ping BPM", "High BPM", "Tape BPM", "Doubling"]),
    pair("Delay A", 30, 62, 2), pair("Delay B", 31, 63, 2), pair("Delay mix", 33, 113, 2, 8192),
    nts_types("Reverb type", 90, 3, ["Off", "Hall", "Smooth", "Arena", "Plate", "Room", "Early", "Space", "Riser", "Submarine", "Horror"]),
    pair("Reverb A", 34, 114, 3), pair("Reverb B", 35, 115, 3), pair("Reverb mix", 36, 116, 3, 8192),
], {1: "Mod", 2: "Delay", 3: "Reverb"})

write("korg-nts-1-mkii-arp", "Arp", NTS, NTSP, NTS_NOTE, [
    selector("Arp pattern", 117, list(zip(["Up", "Down", "Up-Down", "Down-Up", "Converge", "Diverge", "Conv-Div", "Div-Conv", "Random", "Stochastic"],
                                          [0, 12, 24, 36, 48, 60, 72, 84, 96, 127])), 1),
    buttons("Intervals", 118, [("Oct", 0), ("Maj", 21), ("Sus", 42), ("Aug", 63), ("Min", 84), ("Dim", 127)], 1),
    cc7("Arp length", 119, 1), pair("Volume", 7, 39, 0, 12800),
], {1: "Arp", 0: ("Volume", False)})

write("korg-nts-1-mkii-osc-params", "Osc params", NTS, NTSP, NTS_NRPN,
      [nrpn(f"Osc P{i + 1}", 0, i, 0, 16383, 1, 38, 7) for i in range(8)], {1: "Osc unit"})

write("korg-nts-1-mkii-fx-params", "FX params", NTS, NTSP, NTS_NRPN,
      [nrpn(f"{fx} P{i + 1}", m, i, 0, 16383, g, 38, 7) for m, fx, g in ((1, "Mod", 1), (2, "Delay", 2), (3, "Reverb", 3)) for i in range(8)], {1: "Mod", 2: "Delay", 3: "Reverb"})

SF, SFP = "Waldorf Streichfett", "Streichfett"
SF_NOTE = ("Switch positions are sent as 0, 1, 2 as in the Waldorf MIDI chart (its controller table swaps the ranges of CC70 and CC71; "
           "70 is Registration, 71 Octaves). FX edit only selects which effect the panel's Depth knob edits; all three effects have their own amount. "
           "Vibrato is the mod wheel (CC1), stored with the sound.")

write("waldorf-streichfett", "Panel", SF, SFP, SF_NOTE, [
    cc7("Registration", 70, 1), buttons("Octaves", 71, [("Base", 0), ("Both", 1), ("8va", 2)], 1),
    cc7("Crescendo", 73, 1, 32), cc7("Release", 72, 1, 64),
    buttons("Ensemble", 75, ONOFF, 1, 127), buttons("Ens. type", 74, [("String", 0), ("Str+Ch", 1), ("Chorus", 2)], 1, 1),
    cc7("Tone", 76, 2), cc7("Tremolo", 77, 2),
    buttons("Split", 78, [("Low", 0), ("Layer", 1), ("High", 2)], 2, 1), buttons("Envelope", 79, [("Decay", 0), ("Sustain", 1)], 2, 1),
    cc7("Attack", 80, 2), cc7("Decay", 81, 2, 64),
    buttons("FX edit", 91, [("Reverb", 0), ("Phaser", 1), ("Animate", 2)], 3),
    cc7("Animate", 92, 3), cc7("Phaser", 93, 3), cc7("Reverb", 94, 3),
    base("Balance", 1, 4, number=82, val=64), cc7("Vibrato", 1, 4),
], {1: "Strings", 2: "Solo", 3: "FX", 4: ("Mix", False)})

LP, LPP = "Moog Little Phatty", "Little Phatty"
LP_NOTE = "Values from the Moog CC chart (Stage II, OS 2.2). Switches are On at 64. Pot Mapping on the synth overrides these CCs for that panel section."
LP_ONOFF = [("Off", 0), ("On", 64)]
LP_OCT = [("16'", 0), ("8'", 32), ("4'", 48), ("2'", 64)]
LP_DIV = list(zip(["1/32", "1/32 dot", "1/16", "1/16 dot", "1/8", "1/8 dot", "1/4", "1/4 dot", "1/2", "1/2 dot", "Whole", "W + 1/4", "W + 1/2", "W + 1/2 dot", "2 whole"], range(0, 113, 8)))

write("moog-little-phatty-osc-filter", "Osc/Filter", LP, LPP, LP_NOTE + " Cutoff is 14 bit (CC19 + CC51).", [
    buttons("Osc1 oct", 74, LP_OCT, 1, 32), cc7("Osc1 wave", 9, 1), cc7("Osc1 level", 15, 1, 127),
    buttons("Osc2 oct", 75, LP_OCT, 2, 32), base("Osc2 freq", 1, 2, number=10, val=64), cc7("Osc2 wave", 11, 2), cc7("Osc2 level", 16, 2),
    buttons("Glide", 65, LP_ONOFF, 3), cc7("Glide rate", 5, 3), buttons("1-2 sync", 77, LP_ONOFF, 3),
    pair("Cutoff", 19, 51, 4, 16383), cc7("Resonance", 21, 4), cc7("KB amount", 22, 4), base("EG amount", 1, 4, number=27, val=64),
    cc7("Overload", 18, 4), buttons("Poles", 109, [("1", 0), ("2", 32), ("3", 64), ("4", 96)], 4, 96),
    selector("Vel > cutoff", 110, list(zip([f"{v:+d}" if v else "0" for v in range(-8, 9)], [0, 12, 19, 26, 33, 40, 47, 54, 61, 68, 75, 82, 89, 96, 103, 110, 117])), 4, 61),
], {1: "Osc 1", 2: ("Osc 2", False), 3: "Glide", 4: "Filter"})

write("moog-little-phatty-mod-eg", "Mod/EG", LP, LPP, LP_NOTE + " Mod wheel is 14 bit (CC1 + CC33). LFO clock divider only acts with LFO sync = MIDI.", [
    cc7("LFO rate", 3, 1), cc7("Amount", 6, 1),
    selector("Source", 68, [("LFO tri", 0), ("LFO square", 16), ("LFO saw", 32), ("LFO ramp", 48), ("Filter EG / S&H", 64), ("Osc 2 / noise", 80)], 1),
    buttons("Dest", 69, [("Ptch", 0), ("Filt", 16), ("Wave", 32), ("Osc2", 48)], 1), pair("Mod wheel", 1, 33, 1),
    buttons("Source 5", 104, [("Filter EG", 0), ("S&H", 64)], 2), buttons("Source 6", 105, [("Osc 2", 0), ("Noise", 64)], 2),
    buttons("Dest 2", 106, [("Off", 0), ("Ptch", 25), ("Filt", 50), ("Wave", 75), ("Osc2", 100)], 2),
    buttons("LFO sync", 102, [("Int", 0), ("MIDI", 64)], 2), selector("LFO clock", 103, LP_DIV, 2, 48),
    cc7("Attack", 23, 3), cc7("Decay", 24, 3, 64), cc7("Sustain", 25, 3, 64), cc7("Release", 26, 3, 32),
    cc7("Attack", 28, 4), cc7("Decay", 29, 4, 64), cc7("Sustain", 30, 4, 127), cc7("Release", 31, 4, 32),
    buttons("EG release", 111, LP_ONOFF, 0, 64), buttons("Gate", 112, [("Legato", 0), ("Retrig", 43), ("Reset", 86)], 0),
], {1: "Mod", 2: "Mod 2", 3: "Filter EG", 4: ("Amp EG", False), 0: "EG mode"})

write("moog-little-phatty-arp", "Arp", LP, LPP, LP_NOTE + " Arp rate (CC4) is BPM / 3 (21–320 BPM), Arp fine (CC36) adds 0.1 BPM per step; both only act with Clock = Int. Arp enable arms the arpeggiator, Run starts it. Pitch bend ranges (CC107/108) have no value table in the chart.", [
    buttons("Arp enable", 113, LP_ONOFF, 1), buttons("Run", 90, LP_ONOFF, 1),
    buttons("Latch enable", 119, LP_ONOFF, 1), buttons("Latch", 91, LP_ONOFF, 1),
    cc7("Arp rate", 4, 1, 40), cc7("Arp fine", 36, 1),
    buttons("Clock", 114, [("Int", 0), ("LFO", 43), ("MIDI", 86)], 1), selector("Clock div", 115, LP_DIV, 1, 48),
    buttons("Pattern", 117, [("Up", 0), ("Down", 43), ("Order", 86)], 2), buttons("Mode", 118, [("Loop", 0), ("Back-forth", 43), ("Once", 86)], 2),
    buttons("Octaves", 116, [("-3", 0), ("-2", 19), ("-1", 38), ("0", 57), ("+1", 71), ("+2", 90), ("+3", 109)], 2, 71),
    buttons("Priority", 88, [("Glob", 0), ("Low", 32), ("High", 64), ("Last", 96)], 3),
    cc7("Bend up", 107, 3), cc7("Bend down", 108, 3), cc7("Volume", 7, 3, 100),
], {1: "Arp", 2: "Pattern", 3: ("Voice", False)})

MT, MTP = "Moog Minitaur", "Minitaur"
MT_NOTE = ("Knobs send 14 bit (CC n, then CC n+32). Switches are On at 64 and above. Values from the Moog CC table, "
           "corrected per the v2.1 notes and the MIDI chart (LSB is always MSB + 32).")
MT_SAWSQR = [("Saw", 0), ("Sqr", 127)]
MT_ONOFF = [("Off", 0), ("On", 127)]

# 14 bit knob, low 7 bits on CC + 32
def mt(label, cc, group=0, val=0, bipolar=False, sec=None):
    c = pair(label, cc, cc + 32, group, val, bipolar)
    if sec: c["sec"] = sec
    return c

def mid(lo, hi):
    return (lo + hi) // 2

MT_DIV = [(n, mid(lo, hi)) for n, lo, hi in [
    ("4 whole", 0, 6), ("3 whole", 7, 12), ("2 whole", 13, 18), ("W + 1/2", 19, 24), ("Whole", 25, 30), ("1/2 dot", 31, 36),
    ("Whole T", 37, 42), ("1/2", 43, 48), ("1/4 dot", 49, 54), ("1/2 T", 55, 60), ("1/4", 61, 67), ("1/8 dot", 68, 73),
    ("1/4 T", 74, 79), ("1/8", 80, 85), ("1/16 dot", 86, 91), ("1/8 T", 92, 97), ("1/16", 98, 103), ("1/16 T", 104, 109),
    ("1/32", 110, 115), ("1/32 T", 116, 121), ("1/64 T", 122, 127)]]
MT_BEND = [(n, 8 + 16 * i) for i, n in enumerate(["Off", "2 semi", "3 semi", "4 semi", "5 semi", "7 semi", "12 semi", "24 semi"])]

write("moog-minitaur-panel", "Panel", MT, MTP, MT_NOTE, [
    buttons("VCO1 wave", 70, MT_SAWSQR, 1), buttons("VCO2 wave", 71, MT_SAWSQR, 1), mt("VCO2 freq", 17, 1, bipolar=True),
    mt("VCO1 level", 15, 1, 16383), mt("VCO2 level", 16, 1, 8192),
    buttons("Glide", 65, MT_ONOFF, 0), mt("Glide rate", 5, 0),
    mt("Cutoff", 19, 2, 16383), mt("Resonance", 21, 2), mt("EG amount", 22, 2, bipolar=True),
    mt("LFO rate", 3, 4, 8192), mt("VCO amount", 13, 4), mt("VCF amount", 12, 4),
    mt("Attack", 23, 2, sec="feg"), mt("Decay", 24, 2, 8192, sec="feg"), mt("Sustain", 25, 2, 8192, sec="feg"),
    mt("Attack", 28, 3), mt("Decay", 29, 3, 8192), mt("Sustain", 30, 3, 16383), buttons("Release", 72, MT_ONOFF, 3, 127),
], {1: "Osc", 0: ("Glide", False), 2: "Filter", 4: ("Mod", False), "feg": "Filter EG", 3: ("Amp EG", False)})

write("moog-minitaur-extras", "Extras", MT, MTP, MT_NOTE + " These are the settings without a panel knob. Mod source, Hard sync and VCO2 only need firmware 2.2; "
      "the Mod source values are not documented (evenly spread here). Trigger mode and Key priority follow the corrected v2.1 ranges.", [
    mt("VCO2 beat", 18, 1, bipolar=True), buttons("Note sync", 81, MT_ONOFF, 1), buttons("Hard sync", 80, MT_ONOFF, 1),
    buttons("Glide type", 92, [("LCR", 0), ("LCT", 64), ("Exp", 127)], 1), buttons("Glide on", 83, [("Always", 0), ("Legato", 127)], 1),
    selector("Mod source", 85, [("Triangle", 0), ("Square", 22), ("Ramp", 43), ("Saw", 64), ("S&H", 86), ("Filter EG", 107)], 4),
    buttons("VCO2 only", 112, MT_ONOFF, 4), buttons("LFO sync", 87, [("Int", 0), ("MIDI", 127)], 4, 127),
    selector("LFO clock", 86, MT_DIV, 4, 64), buttons("Key trig", 82, MT_ONOFF, 4), mt("Mod wheel", 1, 4),
    mt("KB track", 20, 2, 4096), cc7("Vel > filter", 89, 2, 64), mt("Ext in", 27, 2, 8192),
    cc7("Vel > amp", 90, 3, 64), mt("Volume", 7, 3, 16383), buttons("Trigger", 73, [("Legato", 0), ("Retrig", 64), ("Reset", 127)], 3),
    buttons("Priority", 91, [("Low", 0), ("High", 64), ("Last", 127)], 0, 127),
    selector("Bend up", 107, MT_BEND, 0, 40), selector("Bend down", 108, MT_BEND, 0, 40),
], {1: "Osc", 4: "Mod", 2: "Filter", 3: ("Amp", False), 0: "Keys"})

MONO, MONOP = "KORG monologue", "monologue"
MONO_NOTE = ("Needs GLOBAL 4 > Enable Rx MIDI = On. Knobs are 7 bit. The MIDI chart lists no switch values; these come from a working setup "
             "(lowest switch position 0, middle 64, top 127). EG int and LFO int are centred: below 64 is the negative range (SHIFT on the panel).")

write("korg-monologue-panel", "Panel", MONO, MONOP, MONO_NOTE, [
    buttons("VCO1 wave", 50, WAVE, 1, 127), cc7("VCO1 shape", 36, 1),
    dict(buttons("VCO2 oct", 49, OCT, 1, 42), sec="vco2"), dict(buttons("VCO2 wave", 51, [("Noise", 0), ("Tri", 64), ("Saw", 127)], 1, 127), sec="vco2"),
    dict(buttons("Sync/Ring", 60, [("Ring", 0), ("Off", 64), ("Sync", 127)], 1, 64), sec="vco2"),
    base("VCO2 pitch", 1, 1, number=35, val=64, sec="vco2"), dict(cc7("VCO2 shape", 37, 1), sec="vco2"),
    cc7("VCO1 level", 39, 0, 127), cc7("VCO2 level", 40, 0),
    cc7("Cutoff", 43, 3, 127), cc7("Resonance", 44, 3), cc7("Drive", 28, 3),
    buttons("EG type", 61, [("Gate", 0), ("A/G/D", 64), ("A/D", 127)], 4, 64), cc7("Attack", 16, 4), cc7("Decay", 17, 4, 64),
    base("EG int", 1, 4, number=25, val=64), buttons("EG target", 62, [("Cutoff", 0), ("Pitch 2", 64), ("Pitch", 127)], 4),
    buttons("LFO wave", 58, WAVE, 2, 64), buttons("LFO mode", 59, [("1-Shot", 0), ("Slow", 64), ("Fast", 127)], 2, 64),
    cc7("LFO rate", 24, 2, 64), base("LFO int", 1, 2, number=26, val=64), buttons("LFO target", 56, [("Cutoff", 0), ("Shape", 64), ("Pitch", 127)], 2, 127),
], {1: "VCO 1", "vco2": ("VCO 2", False), 0: "Mixer", 3: ("Filter", False), 4: "EG", 2: "LFO"})

VOLCA_NOTE = "Needs the global parameter MIDI Rx ShortMessage = On. All knobs are 7 bit. The volcas have no USB MIDI, so connect them through a MIDI interface."
UNTESTED = " The KORG chart has no value tables: the named steps are spread evenly over 0–127 (untested)."

VB = "KORG volca bass"
write("korg-volca-bass", "Panel", VB, None, VOLCA_NOTE + " Slide time, Expression and Gate time are MIDI only. There is no cutoff CC. Octave values guessed like the volca keys (6 even ranges).", [
    cc7("Octave", 40, 1, 53, [v for _, v in spread(range(6))], [str(i + 1) for i in range(6)]),
    base("VCO1 pitch", 1, 1, number=43, val=64), base("VCO2 pitch", 1, 1, number=44, val=64), base("VCO3 pitch", 1, 1, number=45, val=64),
    cc7("LFO rate", 41, 2, 64), cc7("LFO int", 42, 2),
    cc7("Attack", 46, 3), cc7("Decay/rel", 47, 3, 64), cc7("Cutoff EG", 48, 3, 64),
    cc7("Slide time", 5, 4), cc7("Gate time", 49, 4, 100), cc7("Expression", 11, 4, 127),
], {1: "VCO", 2: ("LFO", False), 3: "EG", 4: ("Play", False)})

VK = "KORG volca keys"
write("korg-volca-keys", "Panel", VK, None, VOLCA_NOTE + " Voice and Octave values from midi.guide. Expression is MIDI only.", [
    selector("Voice", 40, [("Poly", 6), ("Unison", 25), ("Octave", 50), ("Fifth", 75), ("Unison ring", 100), ("Poly ring", 120)], 1),
    buttons("Octave", 41, [("32'", 10), ("16'", 32), ("8'", 54), ("4'", 76), ("2'", 98), ("1'", 118)], 1, 54),
    cc7("Detune", 42, 1), cc7("Portamento", 5, 1), cc7("VCO EG int", 43, 1),
    cc7("Cutoff", 44, 2, 127), cc7("VCF EG int", 45, 2),
    cc7("LFO rate", 46, 3, 64), cc7("Pitch int", 47, 3), cc7("Cutoff int", 48, 3),
    cc7("Attack", 49, 4), cc7("Decay/rel", 50, 4, 64), cc7("Sustain", 51, 4, 127),
    cc7("Delay time", 52, 5, 64), cc7("Feedback", 53, 5), cc7("Expression", 11, 5, 127),
], {1: "Voice", 2: ("Filter", False), 3: "LFO", 4: ("EG", False), 5: "Delay"})

FM_ALGO = [v for _, v in spread(range(32))]
FM_ARP = spread(["Off", "Rise 1", "Rise 2", "Rise 3", "Fall 1", "Fall 2", "Fall 3", "Random 1", "Random 2", "Random 3"])
FM_NOTE = (VOLCA_NOTE + " The envelope and LFO knobs change the voice's settings relative to the stored values (centre = as stored). "
           "Transpose is centred." + UNTESTED + " Arp div has no names, its steps are not documented.")

def volca_fm(file, device, port, extra, notes):
    write(file, "Panel", device, port, notes, [
        base("Transpose", 1, 1, number=40, val=64), cc7("Velocity", 41, 1, 127),
        cc7("Algorithm", 48, 1, FM_ALGO[0], FM_ALGO, [str(i + 1) for i in range(32)]),
        base("Mod attack", 1, 2, number=42, val=64), base("Mod decay", 1, 2, number=43, val=64),
        base("Car attack", 1, 2, number=44, val=64), base("Car decay", 1, 2, number=45, val=64),
        base("LFO rate", 1, 3, number=46, val=64), base("LFO depth", 1, 3, number=47, val=64),
        selector("Arp type", 49, FM_ARP, 4), cc7("Arp div", 50, 4, 64),
    ] + extra, {1: "Voice", 2: "Envelopes", 3: "LFO", 4: ("Arp", False), 5: "FX"})

volca_fm("korg-volca-fm", "KORG volca fm", None, [], FM_NOTE)
volca_fm("korg-volca-fm2", "KORG volca fm2", None, [cc7("Chorus", 93, 5), cc7("Reverb", 91, 5)], FM_NOTE)

VD = "KORG volca drum"
# Single channel mode, per part: Select, Level, Mod amount, Mod rate, Pitch, EG attack, EG release (both layers), Send, Pan
VD_CCS = [[14, 15, 16, 17, 18, 19, 20, 103, 109], [23, 24, 25, 26, 27, 28, 29, 104, 110], [46, 47, 48, 49, 50, 51, 52, 105, 111],
          [55, 56, 57, 58, 59, 60, 61, 106, 112], [80, 81, 82, 83, 84, 85, 86, 107, 113], [89, 90, 96, 97, 98, 99, 100, 108, 114]]

def vd_part(i):
    sel, lev, amt, rate, pitch, att, rel, send, pan = VD_CCS[i]
    return [page(f"Part {i + 1}"),
            cc7("Select", sel, 1), cc7("Pitch", pitch, 1, 64), cc7("Level", lev, 1, 127),
            cc7("Mod amt", amt, 2), cc7("Mod rate", rate, 2),
            cc7("Attack", att, 3), cc7("Release", rel, 3, 64),
            cc7("Send", send, 4), base("Pan", 1, 4, number=pan, val=64)]

write("korg-volca-drum", "Single ch", VD, None, VOLCA_NOTE + " For the single channel mode (set a MIDI channel in the global parameters; the default is one channel per part). "
      "Each part's knobs act on both layers. The Mix page repeats every part's level, pan and send; both copies stay in sync.", [
    page("Mix")] + [dict(cc7(f"Level {i + 1}", VD_CCS[i][1], 1, 127), sec="lev") for i in range(6)]
    + [dict(base(f"Pan {i + 1}", 1, 4, number=VD_CCS[i][8], val=64), sec="pan") for i in range(6)]
    + [dict(cc7(f"Send {i + 1}", VD_CCS[i][7], 3), sec="send") for i in range(6)]
    + [cc7("Model", 116, 5), cc7("Decay", 117, 5, 64), cc7("Body", 118, 5, 64), cc7("Tune", 119, 5, 64)]
    + [c for i in range(6) for c in vd_part(i)],
    {"lev": "Level", "pan": "Pan", "send": "Send", 5: "Waveguide", 1: "Osc", 2: ("Mod", False), 3: "EG", 4: ("Out", False)})

VS = "KORG volca sample2"
# Single channel mode, per part: Level, Pan, Speed, Amp attack, Amp decay, Hi cut. The chart lists only five CCs for
# part 1 (7, 10, 43, 63, 42); 63 is taken as the amp attack and part 1 has no decay control here
VS_PARTS = [[7, 10, 43, 63, None, 42]] + [list(range(b, b + 6)) for b in (14, 20, 26, 50, 56, 76, 82, 102, 108)]

def vs_part(i):
    lev, pan, speed, att, dec, cut = VS_PARTS[i]
    sec = f"p{i + 1}"
    return [dict(c, sec=sec) for c in [
        cc7("Level", lev, 1, 127), base("Pan", 1, 1, number=pan, val=64), base("Speed", 1, 1, number=speed, val=64),
        cc7("Attack", att, 1)] + ([cc7("Decay", dec, 1, 127)] if dec else []) + [cc7("Hi cut", cut, 1, 127)]]

write("korg-volca-sample2", "Single ch", VS, None, "For the single channel mode (set a MIDI channel in the global parameters; the default is one channel per part). "
      "CC numbers from the KORG chart, untested. The chart lists only five CCs for part 1 (7, 10, 43, 63, 42): 63 is taken as Attack and part 1 has no Decay. "
      "Speed and Pan are centred.",
    [page("Parts 1–4")] + [c for i in range(4) for c in vs_part(i)]
    + [page("Parts 5–8")] + [c for i in range(4, 8) for c in vs_part(i)]
    + [page("Parts 9–10")] + [c for i in range(8, 10) for c in vs_part(i)] + [cc7("Reverb mix", 91, 2)],
    {**{f"p{i + 1}": f"Part {i + 1}" for i in range(10)}, 2: "Reverb"})

MKXL, MKXLP = "KORG microKORG XL", "microKORG XL"
MKXL_NOTE = ("Needs MIDI FLT > CTRL CHG = ENABLE. CC numbers are the factory CC MAP (GLOBAL > CC MAP can change them). "
             "CCs act on the timbre of their channel: timbre 1 on the global channel, timbre 2 on T2MIDI.CH in MULTI mode. "
             "NRPNs (arp, voice mode, vocoder, virtual patch) go to the global channel and use only the Data Entry MSB. "
             "Values from the German manual's MIDI chapter, untested.")

def ranges(items):
    """128 value names from (name, highest value) pairs, for range-coded NRPNs"""
    names = []
    for n, hi in items:
        names += [n] * (hi + 1 - len(names))
    assert len(names) == 128, items
    return names

def bi(label, cc, group=0):
    return base(label, 1, group, number=cc, val=64)

def xl_nrpn(label, msb, lsb, items, group=0):
    return nrpn(label, msb, lsb, 0, 127, group, names=ranges(items))

# OSC2 semitone −24…+24: highest CC value of each step (manual p. 92)
XL_SEMI_HI = [2, 5, 7, 10, 13, 15, 18, 20, 23, 26, 28, 31, 33, 36, 39, 41, 44, 47, 49, 52, 54, 57, 60, 62, 65,
              67, 70, 73, 75, 78, 80, 83, 86, 88, 91, 94, 96, 99, 101, 104, 107, 109, 112, 114, 117, 120, 122, 125, 127]
XL_SEMI = [mid(([-1] + XL_SEMI_HI)[i] + 1, hi) for i, hi in enumerate(XL_SEMI_HI)]
XL_LFO1 = spread(["Saw", "Square", "Triangle", "S&H", "Random"])
XL_LFO2 = spread(["Saw", "Square+", "Sine", "S&H", "Random"])
XL_SOURCES = [("EG1", 10), ("EG2", 20), ("EG3", 31), ("LFO1", 42), ("LFO2", 52), ("Velocity", 63), ("Pitch bend", 74),
              ("Mod wheel", 84), ("Key track", 95), ("MIDI1", 106), ("MIDI2", 116), ("MIDI3", 127)]
XL_DESTS = [("Pitch", 2), ("OSC2 tune", 5), ("OSC1 C1", 9), ("OSC1 level", 12), ("OSC2 level", 15), ("Noise level", 18),
            ("F1 type bal", 21), ("Cutoff 1", 25), ("Reso 1", 28), ("Cutoff 2", 31), ("WS depth", 34), ("Amp level", 37),
            ("Pan", 41), ("LFO1 freq", 44), ("LFO2 freq", 47), ("Portamento", 50), ("OSC1 C2", 53), ("F1 EG1 int", 57),
            ("F1 key track", 60), ("Reso 2", 63), ("F2 EG1 int", 66), ("F2 key track", 69), ("EG1 attack", 73),
            ("EG1 decay", 76), ("EG1 sustain", 79), ("EG1 release", 82), ("EG2 attack", 85), ("EG2 decay", 89),
            ("EG2 sustain", 92), ("EG2 release", 95), ("EG3 attack", 98), ("EG3 decay", 101), ("EG3 sustain", 105),
            ("EG3 release", 108), ("Patch 1 int", 111), ("Patch 2 int", 114), ("Patch 3 int", 117), ("Patch 4 int", 121),
            ("Patch 5 int", 124), ("Patch 6 int", 127)]

write("korg-microkorg-xl-osc", "Osc/Mixer", MKXL, MKXLP, MKXL_NOTE + " OSC1 C1/C2 act on the parameters the WAVE / OSC MOD combination selects (manual p. 37).", [
    selector("OSC1 wave", 8, spread(["Saw", "Pulse", "Triangle", "Sine", "Formant", "Noise", "PCM/DWGS", "Audio in"]), 1),
    buttons("OSC1 mod", 9, spread(["Wave", "Cros", "Unis", "VPM"]), 1), cc7("OSC1 C1", 15, 1), cc7("OSC1 C2", 17, 1),
    buttons("Unison", 3, spread(["Off", "2", "3", "4"]), 1),
    buttons("OSC2 wave", 18, spread(["Saw", "Puls", "Tri", "Sine"]), 2), buttons("OSC2 mod", 19, spread(["Off", "Ring", "Sync", "R+S"]), 2),
    cc7("Semitone", 20, 2, 64, XL_SEMI, [f"{i - 24:+d}" if i != 24 else "0" for i in range(49)]),
    bi("Tune", 21, 2),
    cc7("OSC1 level", 23, 3, 127), cc7("OSC2 level", 24, 3), cc7("Noise level", 25, 3), cc7("Portamento", 5, 3),
], {1: "Oscillator 1", 2: "Oscillator 2", 3: "Mixer"})

write("korg-microkorg-xl-filter", "Filter/Amp", MKXL, MKXLP, MKXL_NOTE + " Filter 1 type morphs: 0 LPF24, 32 LPF12, 64 HPF, 96 BPF, 127 Thru. "
      "Key track is centred (0–127 = −2…+2). Filter 2 has no effect with routing Single.", [
    cc7("Cutoff", 74, 1, 127), cc7("Resonance", 71, 1), cc7("Type bal", 27, 1),
    buttons("Routing", 26, spread(["Sngl", "Ser", "Par", "Indv"]), 1), bi("EG1 int", 79, 1), bi("Key track", 28, 1),
    cc7("Cutoff", 30, 2, 127), cc7("Resonance", 68, 2), buttons("Type", 29, [("LPF", 21), ("HPF", 63), ("BPF", 106)], 2),
    bi("EG1 int", 69, 2), bi("Key track", 82, 2),
    cc7("Level", 7, 3, 127), bi("Pan", 10, 3), cc7("WS depth", 83, 3),
], {1: "Filter 1", 2: "Filter 2", 3: "Amp"})

write("korg-microkorg-xl-eg-lfo", "EG/LFO", MKXL, MKXLP, MKXL_NOTE + " With BPM SYNC on, LFO freq selects a note value (8/1 … 1/64). EG3 has no CC.", [
    cc7("Attack", 85, 1), cc7("Decay", 86, 1, 64), cc7("Sustain", 87, 1, 64), cc7("Release", 88, 1),
    cc7("Attack", 73, 2), cc7("Decay", 75, 2, 64), cc7("Sustain", 70, 2, 127), cc7("Release", 72, 2),
    selector("LFO1 wave", 89, XL_LFO1, 3, XL_LFO1[2][1]), cc7("LFO1 freq", 90, 3, 64),
    selector("LFO2 wave", 102, XL_LFO2, 4, XL_LFO2[2][1]), cc7("LFO2 freq", 76, 4, 64),
], {1: "EG1 (filter)", 2: ("EG2 (amp)", False), 3: "LFO 1", 4: ("LFO 2", False)})

write("korg-microkorg-xl-patch", "Virtual patch", MKXL, MKXLP, MKXL_NOTE + " Source and destination are NRPN (MSB 4, LSB 0–5 and 8–13), intensity is a centred CC.",
    [dict(c, sec=i) for i in range(6) for c in [
        xl_nrpn("Source", 4, i, XL_SOURCES, i % 2 + 1), xl_nrpn("Dest", 4, 8 + i, XL_DESTS, i % 2 + 1), bi("Intensity", 103 + i, i % 2 + 1)]],
    {i: (f"Patch {i + 1}", i % 2 == 0) for i in range(6)})

write("korg-microkorg-xl-fx-arp", "FX/Arp", MKXL, MKXLP, MKXL_NOTE + " FX CTRL-1/2 control the parameters assigned on the MST FX pages. "
      "EQ gain is centred (±15 dB). The arp gate maps 0–127 to 0–100 %. Vocoder switch: the chart prints LSB 04(00), 4 is used here.", [
    bi("Lo EQ", 110, 1), bi("Hi EQ", 109, 1),
    cc7("FX1 dry/wet", 115, 2), cc7("FX1 ctrl 1", 12, 2), cc7("FX1 ctrl 2", 112, 2),
    cc7("FX2 dry/wet", 116, 3), cc7("FX2 ctrl 1", 13, 3), cc7("FX2 ctrl 2", 113, 3),
    xl_nrpn("Arp", 0, 2, [("Off", 63), ("On", 127)], 4), xl_nrpn("Latch", 0, 4, [("Off", 63), ("On", 127)], 4),
    xl_nrpn("Arp type", 0, 7, [("Up", 21), ("Down", 42), ("Alt1", 63), ("Alt2", 85), ("Random", 106), ("Trigger", 127)], 4),
    nrpn("Arp gate", 0, 10, 0, 127, 4), xl_nrpn("Arp timbre", 0, 11, [("Timbre 1", 42), ("Timbre 2", 85), ("Timbre 1+2", 127)], 4),
    xl_nrpn("Voice mode", 5, 0, [("Single", 31), ("Layer", 63), ("Split", 95), ("Multi", 127)], 5),
    xl_nrpn("Vocoder", 5, 4, [("Off", 63), ("On", 127)], 5),
], {1: "EQ", 2: ("FX 1", False), 3: "FX 2", 4: "Arpeggiator", 5: "Program"})

write("korg-microkorg-xl-vocoder", "Vocoder bands", MKXL, MKXLP, MKXL_NOTE + " Level and pan of the 16 vocoder bands, NRPN MSB 4, LSB 64–79 and 80–95 (pan centred). "
      "The other vocoder parameters have no CC until one is assigned in CC MAP.",
    [nrpn(f"Level {i + 1}", 4, 64 + i, 0, 127, 1, val=16383) for i in range(16)]
    + [nrpn(f"Pan {i + 1}", 4, 80 + i, 0, 127, 2, val=8192, bipolar=True) for i in range(16)],
    {1: "Band level", 2: "Band pan"})
