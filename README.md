# midi-zoner

Play multiple MIDI devices, channels, and note ranges from a single MIDI input source — without opening a DAW.

My main motivation for building midi-zoner: I wanted to interact and perform with my MIDI gear without the hassle of starting a big, bloated DAW just to split my master keyboard across multiple destinations. And I didn't want to fiddle with tiny 16-character LCD screens to configure zones either.

This is an [Electron](https://www.electronjs.org/) application built with TypeScript and the Web MIDI API.

## Features

- **Multiple independent zones** — each with its own note range, output port, MIDI channel, label, and color
- **Arpeggiator** — up/down/random/order modes, euclidean rhythm patterns, strum modes (down/up/alternating) with velocity taper, ratchet, gate, chance, and hold with keyboard transposition
- **Step sequencer** — melodic (up to 256 steps) and drum modes (up to 64 steps), per-step velocity/gate/length/chance/conditions, ratchet, live recording, copy/paste, transpose
- **4 global arrangements (A/B/C/D)** — snapshot and switch entire zone configurations for live performance; switching is quantized
- **CC controllers** — unipolar and bipolar rotary knobs, 14-bit precision, button banks, note-to-CC converters, and spacers
- **Per-zone input routing** — assign a specific MIDI input port and channel per zone (in addition to global multi-input selection)
- **Internal and external MIDI clock** — internal clock via Web Audio API for accurate timing; external clock from any MIDI input; configurable clock output routing per port
- **Key switches** — MIDI notes 0–19 (C-2 to G0) mute zones, toggle sequencers, and switch arrangements from a hardware controller
- **Swing** — per-zone swing amount (0–100%) applied to arpeggiator and sequencer timing
- **Scene save/load** — export and import complete configurations as JSON files; auto-save to localStorage; undo/redo (20 levels)
- **Panic** — send All Notes Off to all outputs instantly

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

Pre-built releases for macOS, Windows, and Linux (64-bit) are available under [releases](https://github.com/privatepublic-de/midi-zoner/releases).

## License

ISC — Peter Witzel / [privatepublic.de](https://www.privatepublic.de)
