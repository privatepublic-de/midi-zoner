# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

midi-zoner is an Electron-based MIDI application that routes MIDI input to multiple output devices with extensive per-zone control. It features zone-based MIDI routing, arpeggiators with euclidean patterns, step sequencers, and customizable CC controllers. The application is built with TypeScript and uses the Web MIDI API.

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
    ├── zone-template.ts
    ├── dragzone.ts
    ├── potdraghandler.ts
    ├── domutils.ts
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

#### zone/ Directory
Contains zone-related classes split into separate modules:

- **zone-class.ts**: Main Zone class with note range, channel, output routing, arpeggiator, sequencer, and CC controllers
- **sequence.ts**: Step sequencer with 4 layers (A-D), supports both melodic and drum modes
- **seq-layer.ts**: Individual sequencer layer data with DIV_TICKS constants
- **seq-step.ts**: Single sequencer step with notes, probability, conditions
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
- **zone-template.ts**: Generates HTML templates for zones using string interpolation
- **dragzone.ts**: Implements drag-and-drop reordering of zones
- **potdraghandler.ts**: Handles mouse drag interactions for rotary CC controller knobs
- **domutils.ts**: DOM utility functions for element selection and class management

### Data Flow

1. **MIDI Input**: Web MIDI API → midi.ts → app.ts eventHandler
2. **Zone Processing**: app.ts distributes MIDI events to zones based on note range and enabled state
3. **Arpeggiator**: Triggered by internal-clock.ts or external MIDI clock, processes held notes
4. **Sequencer**: Triggered by clock, reads active layer steps and triggers notes
5. **MIDI Output**: Zone sends processed notes/CC → midi.ts → Web MIDI API output ports
6. **Persistence**: Zones serialized to localStorage on every change (debounced 500ms). Scene files are JSON exports of the zones object.

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
- `zones.seqLayerIndex`: Active sequencer layer (0-3)
- `zones.seqLayerQuantIndex`: Quantization mode for layer recording

Solo mode is tracked via `Zone.solocount` static counter.

### Key Concepts
- **Zones are independent**: Each zone has its own sequencer, arpeggiator, and settings
- **Zone.solo**: When any zone is soloed, all non-solo zones are muted
- **Internal clock**: Generated via Web Audio API for precise timing, always runs in background
- **Multi-input support**: Multiple MIDI input ports can be selected simultaneously
- **Output presets**: Named configurations of output port + channel for quick recall
- **DIV_TICKS array**: Maps note division indices to MIDI ticks (24ppq)

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
  UP_DOWN = 2,    // Alternating
  RANDOM = 3,
  ORDER = 4       // As played
}
```

### StepCondition (interfaces.ts)
```typescript
enum StepCondition {
  ALWAYS = 0,
  PREVIOUS = 1,
  NOT_PREVIOUS = 2,
  FIRST_CYCLE = 3,
  NOT_FIRST_CYCLE = 4
  // 5+ are cycle-based conditions
}
```

## Important Implementation Notes

### MIDI Note Numbers
Note numbers range 0-127. Display format uses `Note.display()` which shows "C-1" to "G9".

### Sequencer Features
- 4 independent layers (A/B/C/D) per zone
- Melodic mode: Multi-note polyphonic steps with velocity, gate, length, chance, and conditions
- Drum mode: Up to 12 lanes of monophonic triggers
- Step conditions: Always, Previous, Not Previous, 1st cycle, Not 1st cycle, Every N cycles
- Copy/paste steps and entire sequences
- Transpose, double, half-time, velocity scaling operations
- Live recording while sequence plays

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
- Arpeggiator patterns and hold mode
- Sequencer step editing and playback
- CC controller interaction
- Multi-input port handling
- Clock source switching (external ↔ internal)
- Scene save/load
- Solo/mute interactions
- MIDI device connect/disconnect
