# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

midi-zoner is an Electron-based MIDI application that routes MIDI input to multiple output devices with extensive per-zone control. It features zone-based MIDI routing, arpeggiators with euclidean patterns and strum modes, step sequencers, 4 global arrangements for live switching, key switches, and customizable CC controllers. The application is built with TypeScript and uses the Web MIDI API.

## Development Commands

### Running the Application
```bash
npm start                # Run the Electron app in development mode
```

### Building
```bash
npm run build:ts         # Compile TypeScript to JavaScript
npm run build:win        # Build Windows portable executable
npm run build:mac        # Build macOS DMG installer
npm run build:linux      # Build Linux AppImage
npm run build:all        # Build all platforms + macOS app
npm run pack:osx         # Build macOS .app without DMG (x64)
npm run pack:osx:arm     # Build macOS .app without DMG (arm64)
```

## Architecture

### Directory Structure
```
src/
├── main/
│   └── main.ts          # Electron main process
├── renderer/
│   └── app.ts           # Renderer process entry point
└── modules/
    ├── midi.ts          # Web MIDI API wrapper
    ├── internal-clock.ts
    ├── undo-history.ts
    ├── zone-template.ts
    ├── dragzone.ts
    ├── potdraghandler.ts
    ├── domutils.ts
    ├── prng.ts
    ├── zone/            # Zone-related classes
    │   ├── interfaces.ts
    │   ├── note.ts
    │   ├── note-display.ts
    │   ├── zone-class.ts
    │   ├── zone-elements.ts
    │   ├── sequence.ts
    │   ├── seq-layer.ts
    │   ├── seq-step.ts
    │   └── drum-lane.ts
    └── viewcontroller/  # UI controller modules
        ├── index.ts
        ├── types.ts
        ├── toast.ts
        ├── number-input-controller.ts
        ├── cc-controller-view.ts
        ├── output-port-manager.ts
        └── actions/
            ├── index.ts
            ├── zone-actions.ts
            ├── arp-actions.ts
            ├── filter-actions.ts
            ├── cc-actions.ts
            └── seq-actions.ts
```

### Application Entry Points
- **src/main/main.ts**: Electron main process. Handles window creation, application menu, file dialogs (save/load scenes), IPC communication, and window state persistence via electron-settings.
- **index.html**: Main application UI structure. Loads compiled app.js and styles.css.
- **src/renderer/app.ts**: Renderer process entry point. Initializes MIDI, loads/saves zones from localStorage, manages the zone list, handles UI interactions, and coordinates between modules.

### Core Modules

#### midi.ts
Web MIDI API wrapper with typed interfaces (MIDIAccess, MIDIInput, MIDIOutput, MIDIMessageEvent). Manages:
- Input/output port enumeration and state changes
- MIDI message routing (notes, CC, pitch bend, program change)
- Clock input/output routing (external and internal clock selection)
- Transport messages (start/stop/continue)
- Multi-input port selection support
- `midi.zoneInputPorts` — set of ports claimed by per-zone routing; these bypass the global channel gate so all channels pass through for zone-level filtering

#### zone/ Directory
Contains zone-related classes split into separate modules:

- **zone-class.ts**: Main Zone class with note range, channel, output/input routing, arpeggiator, sequencer, and CC controllers. Holds `arrangements[]` array and `captureArrangement()` / `applyArrangement()` methods
- **sequence.ts**: Flat step sequencer (no sub-layers); supports melodic and drum modes. The old 4-layer system is replaced by global arrangements
- **seq-layer.ts**: Contains only `DIV_TICKS` and `DivTick` — the tick-to-division mapping constants (24ppq)
- **seq-step.ts**: Single sequencer step with notes, velocity, gate, length, probability, condition, and ratchet fields
- **drum-lane.ts**: Drum sequencer lane
- **note.ts**: MIDI note representation with velocity, channel, and portId
- **note-display.ts**: Static NoteDisplay class with note name arrays
- **zone-elements.ts**: DOM element references for a zone
- **interfaces.ts**: TypeScript interfaces and enums (CCController, ArpState, ZoneJSON, etc.)

#### viewcontroller/ Directory
UI controller split into focused modules:

- **index.ts**: Main entry point, coordinates all UI updates
- **types.ts**: Shared TypeScript interfaces (ActionContext, ActionHelpers, ZonesData)
- **actions/**: Action handlers grouped by domain
  - **zone-actions.ts**: Zone enable/solo/delete, output port, channel, range
  - **arp-actions.ts**: Arpeggiator enable/hold, pattern, euclidean
  - **filter-actions.ts**: Message filters (CC, sustain, pitchbend, etc.)
  - **cc-actions.ts**: CC controller editing and management
  - **seq-actions.ts**: Sequencer step editing, copy/paste, transpose
- **cc-controller-view.ts**: CC pot rendering with SVG arc utilities
- **output-port-manager.ts**: MIDI output port selection UI
- **toast.ts**: Toast notification utilities
- **number-input-controller.ts**: Numeric input with +/- buttons

#### Other Modules
- **internal-clock.ts**: Generates internal MIDI clock at specified BPM using Web Audio API for timing accuracy
- **undo-history.ts**: `UndoHistory` class — push/undo/redo stack (max 20 entries), with gesture grouping so continuous drags produce a single undo entry
- **zone-template.ts**: Generates HTML templates for zones using string interpolation
- **dragzone.ts**: Implements drag-and-drop reordering of zones
- **potdraghandler.ts**: Handles mouse drag interactions for rotary CC controller knobs
- **domutils.ts**: DOM utility functions for element selection and class management
- **prng.ts**: Deterministic PRNG utilities (`mulberry32`, `BagShuffle`) used for arpeggiator randomization

### Data Flow

1. **MIDI Input**: Web MIDI API → midi.ts → app.ts eventHandler
2. **Zone Filtering**: eventHandler checks per-zone `inputPortId`/`inputChannel` (if set) or falls back to global `selectedInputPorts` channel filter
3. **Zone Processing**: app.ts distributes MIDI events to zones based on note range and enabled state
4. **Arpeggiator**: Triggered by internal-clock.ts or external MIDI clock, processes held notes
5. **Sequencer**: Triggered by clock, reads the flat `Sequence` steps for the active arrangement and triggers notes
6. **MIDI Output**: Zone sends processed notes/CC → midi.ts → Web MIDI API output ports
7. **Persistence**: Zones serialized to localStorage on every change (debounced 500ms). Scene files are JSON exports of the zones object. Every mutation is also pushed to `UndoHistory`.

### HTML Templates
- **res/template-zone.html**: Zone UI template with placeholders for dynamic content
- **res/template-controller.html**: CC controller knob template
- **res/about.html**: About dialog

### State Management

Global state is stored in the `zones` object in app.ts:
- `zones.list[]`: Array of Zone instances
- `zones.clockOutputPorts{}`: Which output ports receive clock
- `zones.selectedInputPorts{}`: Which input ports are active
- `zones.tempo`: BPM when using internal clock
- `zones.sendInternalClockIfPlaying`: Clock sending mode
- `zones.outputConfigNames{}`: Named output port configurations
- `zones.arrangementIndex`: Active arrangement (0–3, maps to A/B/C/D)
- `zones.nextArrangementIndex`: Pending arrangement for quantized switching
- `zones.arrangementQuantIndex`: Quantization mode for arrangement switching

Solo mode is tracked via `Zone.solocount` static counter.

Undo/redo state is tracked in a standalone `UndoHistory` instance in app.ts (not part of `zones`). Every discrete mutation calls `undoHistory.push()`; continuous gestures (e.g. dragging a CC knob) use `startGesture()` / `endGesture()` to collapse into a single entry.

### Key Concepts
- **Zones are independent**: Each zone has its own sequencer, arpeggiator, and settings
- **Arrangements**: 4 global snapshots (A/B/C/D) of all zone settings (enabled, arp, sequencer, filters, etc.). Zone identity (port, channel, range, CCs, label, color) is global and shared across arrangements. Switching is quantized to avoid mid-sequence jumps.
- **Per-zone input routing**: `Zone.inputPortId` / `Zone.inputChannel` — when set, that zone only responds to that specific port+channel, overriding global input selection
- **Zone.solo**: When any zone is soloed, all non-solo zones are muted
- **Internal clock**: Generated via Web Audio API for precise timing, always runs in background
- **Multi-input support**: Multiple MIDI input ports can be selected simultaneously
- **Output presets**: Named configurations of output port + channel for quick recall
- **DIV_TICKS array**: Maps note division indices to MIDI ticks (24ppq)
- **Key switches**: When enabled, MIDI notes 0–7 (C-1–G-1) mute zones 1–8, notes 8–15 (G#-1–D#0) toggle sequencers, notes 16–19 (E0–G0) select arrangements A/B/C/D

## TypeScript Enums and Interfaces

### CCControllerType (interfaces.ts)
```typescript
enum CCControllerType {
  UNIPOLAR_ROTARY = 0,  // 0-127
  BIPOLAR_ROTARY = 1,   // -64 to +63
  SPACER = 2,           // Visual separator
  BUTTON_BANK = 3,      // 8 buttons with custom values
  NOTE_TO_CC = 4,       // Converts note number/velocity to CC
  UNIPOLAR_14BIT = 5,   // MSB + LSB
  BIPOLAR_14BIT = 6
}
```

### ArpDirection (interfaces.ts)
```typescript
enum ArpDirection {
  UP = 0,
  DOWN = 1,
  UP_DOWN = 2,      // Alternating up then down
  RANDOM = 3,
  ORDER = 4,        // As played
  STRUM_DOWN = 5,   // Fast descending sweep with velocity taper
  STRUM_UP = 6,     // Fast ascending sweep with velocity taper
  STRUM_ALT = 7     // Alternating strum direction
}
```

### StepCondition (interfaces.ts)
```typescript
enum StepCondition {
  ALWAYS = 0,
  PREVIOUS = 1,       // Play if previous step played
  NOT_PREVIOUS = 2,   // Play if previous step did NOT play
  FIRST_CYCLE = 3,    // Play only on first loop cycle
  NOT_FIRST_CYCLE = 4 // Play on every cycle except the first
  // Values 5+ encode "every N cycles" as (N - 1 + 5)
}
```

### ZoneArrangementJSON (interfaces.ts)
Each zone stores an array of 4 `ZoneArrangementJSON` objects (one per arrangement A/B/C/D). Captures: enabled/solo, octave, velocity/filter settings, all arp state (direction, hold, pattern, ratchet, strum taper, euclidean params, swing), and the flat `SequenceJSON`. Zone-global state (port, channel, range, CC controllers, label, color) lives in `ZoneJSON` itself, not in arrangements.

## Important Implementation Notes

### MIDI Note Numbers
Note numbers range 0-127. Display format uses `Note.display()` which produces `MIDI.NOTENAMES[note % 12] + (Math.floor(note / 12) - 1)`, giving a range of "C-1" (note 0) to "G9" (note 127).

**Convention**: middle C (note 60) = C4. This matches most DAWs and Roland/Korg hardware. The Yamaha convention is one octave lower (middle C = C3, note 0 = C-2) — if a user's hardware labels notes differently, all displayed note names in midi-zoner will appear shifted by one octave.

### Arrangements
- 4 global arrangements A/B/C/D; each captures all per-zone settings (see `ZoneArrangementJSON`)
- `zone.captureArrangement(index)` / `zone.applyArrangement(index)` — snapshot and restore
- `zone.saveArrangement()` must be called **before** `zone.stopped()` during arrangement switching so the snapshot captures actual playing state
- `migrateFromLegacyZone()` in app.ts converts old 4-layer scene files to the arrangement format (layer A → arrangement 0, etc.)
- Switching is quantized: `zones.nextArrangementIndex` is set, applied on the next `arrangementQuantIndex` boundary
- `enabled` and `solo` are per-arrangement, so switching arrangements can change mute/solo state

### Undo/Redo
- `UndoHistory` (src/modules/undo-history.ts) — max 20 entries, JSON snapshots of the full `zones` object
- Discrete mutations: `undoHistory.push(JSON.stringify(zones))` after the change
- Continuous gestures (CC knob drag, BPM input focus): `startGesture(before)` → `endGesture(after)` collapses to one entry
- Scene file loads also push a snapshot so load is undoable
- UI buttons `#undoBtn` / `#redoBtn` are disabled when the stack is empty

### Key Switches
When enabled (toggle in toolbar), MIDI notes 0–19 from any input are intercepted before zone routing:

| Note range | Dec | Action |
|---|---|---|
| C-1 to G-1 | 0–7 | Mute/unmute zones 1–8 |
| G#-1 to D#0 | 8–15 | Toggle sequencer on zones 1–8 |
| E0 to G0 | 16–19 | Select arrangement A/B/C/D |

### Sequencer Features
- Flat single sequence per zone (no sub-layers); each arrangement stores its own `SequenceJSON`
- Melodic mode: Up to 256 steps (`Sequence.MAX_STEPS`), multi-note polyphonic, with velocity, gate, length, chance, and conditions
- Drum mode: Up to 64 steps (`Sequence.MAX_STEPS_DRUMS`), up to 12 lanes of monophonic triggers; per-lane enable, solo, note, euclidean fill
- Step conditions: Always, Previous, Not Previous, 1st cycle, Not 1st cycle, Every N cycles
- Per-step ratchet: count (1–8), rate (subdivision), velocity delta per repeat
- Copy/paste steps and entire sequences
- Transpose, double, half-time, velocity scaling operations
- Live recording while sequence plays

### Arpeggiator Features
- Directions: Up, Down, Up/Down, Random, Order, Strum Down, Strum Up, Strum Alt
- Strum modes: fast sweep across held notes with velocity taper (0–100%)
- Ratchet: probability and count (2×/3×/4×) per step
- Repeat: re-trigger the same note if still held
- Hold: keep notes sounding after release; optional keyboard transposition
- Euclidean pattern generator with shift control

### Swing
Per-zone swing amount (0–100%) stored in `ZoneArrangementJSON.swingAmount`. Applied to both arpeggiator and sequencer step timing by delaying every other tick.

### Clock Sources
- External: MIDI clock from selected input port
- Internal: Generated by internal-clock.ts at zones.tempo BPM
- Clock source selected via `#midiClockInDeviceId` dropdown (INTERNAL_PORT_ID = '*')

### Zone Color Indices
Zones have color indices (0-N) that map to CSS classes. Colors can be randomized per-zone or globally shuffled.

## Testing Notes

The application has no automated tests. Manual testing should cover:
- Zone creation, deletion, reordering
- Note routing with various ranges and octave transposition
- Per-zone input port/channel filtering
- Arpeggiator patterns, hold mode, strum modes, ratchet
- Sequencer step editing and playback; per-step conditions and ratchet
- Arrangement switching (A/B/C/D), quantized switching, key switches
- CC controller interaction (all types including 14-bit)
- Swing timing
- Undo/redo (including gesture grouping for CC drags)
- Multi-input port handling
- Clock source switching (external ↔ internal)
- Scene save/load; backward compat with legacy 4-layer scenes
- Solo/mute interactions (note: these are per-arrangement)
- MIDI device connect/disconnect

## Known Bugs and Minor Issues

### Minor Issues
1. **Drum lane count decrease leaves stale data** — `seq_drum_lanes` action (seq-actions.ts) only updates `sequence.drumLanes` (the display count) without clearing the sparse `drum_lanes` array. Decreasing then increasing the lane count restores old step data.
2. **Arrangement switch stops live recording without a toast** — `z.stopped()` during arrangement switching resets `isLiveRecoding = false` and calls `updateRecordingState()` (which removes the CSS indicator), but there is no toast notification to tell the user recording was interrupted.
