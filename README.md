# midi-zoner

Play multiple MIDI devices, channels, and note ranges from a single MIDI input source — without opening a DAW.

My main motivation for building midi-zoner: I wanted to interact and perform with my MIDI gear without the hassle of starting a big, bloated DAW just to split my master keyboard across multiple destinations. And I didn't want to fiddle with tiny 16-character LCD screens to configure zones either.

This is an [Electron](https://www.electronjs.org/) application built with TypeScript and the Web MIDI API.

## Features

![midi-zoner](https://github.com/privatepublic-de/midi-zoner/wiki/images/scr/mz-full-dark.png)

- **Zones**: split your keyboard into zones, each with its own key range, output port and channel, octave, what passes (Thru), velocity, program change and a sustain pedal latch. Mute, solo and named output configurations
- **Arpeggiator**: up/down/random/order and strum directions with velocity taper, 1–4 octaves, ratchet, chance, gate, hold with transpose, euclidean patterns
- **Step sequencer**: melodic (up to 256 steps) and drum mode (up to 12 lanes, 64 steps each); per-step velocity, length, gate, chance, conditions and ratchet; live recording, piano roll, transpose and adjust tools
- **Parameter locks**: per-step controller values, optionally sliding, Elektron style
- **Takes**: everything you play while the clock runs is recorded. Keep a take or a part of it afterwards, edit its notes, quantize it, or turn it into a sequence
- **Looper**: a loop per zone and arrangement, each its own length. Press Loop (or Rec on a Mackie) on a 1 to record (a little late is fine), on a later 1 to close it: it plays at once, with the pick-up you played before the first 1 at its end. Press again to overdub, twice quickly to clear; mute silences it
- **Track view**: all zones on a timeline, what was played behind the playhead and what comes ahead, with a loop range per arrangement
- **4 arrangements (A/B/C/D)**: snapshots of all zone settings, switched at the next bar, beat or 16th; each with its own meter (any n/4 or n/8 with grouping)
- **Quantized switching**: mute, solo and feature switches can wait for the next bar while playing
- **CC controllers**: knobs (7-bit, 14-bit, 10-bit KORG logue, NRPN), buttons, selectors, note-to-CC; sections and pages; MIDI learn; a full-window editor
- **Device presets**: factory controller sets for KORG (minilogue xd, monologue, NTS-1 mkII, microKORG XL, volcas), Moog (Little Phatty, Minitaur) and the Waldorf Streichfett; save and share your own
- **MPE**: pass an MPE keyboard (such as the Seaboard) through to an MPE synth, or merge it onto one channel with bend, slide and pressure
- **Clock**: internal clock or external MIDI clock, clock outputs per port, metronome (audio and MIDI) with count-in
- **Hardware control**: key switches (notes C-1 to G0) and Mackie Control for mutes, solos, sequencers, arrangements, transport and the looper (Rec)
- **Views**: cards, tracks, or a small floating mini view
- **Scenes**: auto-save, scene and zone files, undo/redo (20 steps)
- **Panic**: All Notes Off to all outputs

## Quick Start

```bash
# Prerequisites: Node.js (current LTS) and npm
git clone https://github.com/privatepublic-de/midi-zoner.git
cd midi-zoner
npm install
npm start
```

## Building

```bash
npm run build:ts         # Compile TypeScript only
npm run build:win        # Windows portable executable
npm run build:mac        # macOS DMG installer
npm run build:linux      # Linux AppImage
npm run build:all        # All platforms + macOS app
npm run pack:osx         # macOS .app without DMG (x64)
npm run pack:osx:arm     # macOS .app without DMG (arm64)
```

Built files are placed in the `dist/` directory.

## User Manual

The complete user manual is on the wiki: [midi-zoner User Manual](https://github.com/privatepublic-de/midi-zoner/wiki)

## Download

Pre-built releases for macOS, Windows, and Linux (64-bit) are available under [releases](https://github.com/privatepublic-de/midi-zoner/releases). The latest release (1.2.0) is from 2020 and lacks most of the features above; build from source for the current version.

## License

ISC — Peter Witzel / [privatepublic.de](https://www.privatepublic.de)
