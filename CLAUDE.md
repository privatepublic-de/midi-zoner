# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

midi-zoner is an Electron-based MIDI application that routes MIDI input to multiple output devices with extensive per-zone control. It features zone-based MIDI routing, arpeggiators with euclidean patterns, step sequencers, and customizable CC controllers. The application is built with vanilla JavaScript (no build step) and uses the Web MIDI API.

## Development Commands

### Running the Application
```bash
npm start                # Run the Electron app in development mode
```

### Building for Distribution
```bash
npm run build:win        # Build Windows portable executable
npm run build:mac        # Build macOS DMG installer
npm run build:linux      # Build Linux AppImage
npm run build:all        # Build all platforms + macOS app
npm run pack:osx         # Build macOS .app without DMG (x64)
npm run pack:osx:arm     # Build macOS .app without DMG (arm64)
```

## Architecture

### Application Entry Points
- **main.js**: Electron main process. Handles window creation, application menu, file dialogs (save/load scenes), IPC communication, and window state persistence via electron-settings.
- **index.html**: Main application UI structure. Loads app.js and styles.css.
- **app.js**: Renderer process entry point. Initializes MIDI, loads/saves zones from localStorage, manages the zone list, handles UI interactions, and coordinates between modules.

### Core Modules (modules/)

#### midi.js
Web MIDI API wrapper. Manages:
- Input/output port enumeration and state changes
- MIDI message routing (notes, CC, pitch bend, program change)
- Clock input/output routing (external and internal clock selection)
- Transport messages (start/stop/continue)
- Multi-input port selection support

#### zone.js
Contains the Zone, Sequence, SeqLayer, and Note classes:
- **Zone**: Represents a single MIDI zone with note range, channel, output routing, arpeggiator, sequencer, and CC controllers
- **Sequence**: Step sequencer with 4 layers (A-D), supports both melodic and drum modes
- **SeqLayer**: Individual sequencer layer data
- **Note**: MIDI note representation with velocity, channel, and portId

Each zone has:
- Note range filtering (low/high)
- Channel and octave transposition
- Arpeggiator with euclidean patterns, hold mode, and transpose
- Step sequencer with per-step velocity, gate length, probability, and conditions
- CC controller mapping (including 14-bit, bipolar, button banks, note-to-CC)
- Message filters (pitch bend, mod wheel, sustain, CC, aftertouch-to-mod)
- Program change support

#### viewcontroller.js
Manages all UI updates and user interactions:
- Zone element creation and updates
- Event delegation for zone controls
- Sequencer step editing and visualization
- CC controller UI and editing
- Context menus and popup management
- Number input handling with increment/decrement buttons

#### internal-clock.js
Generates internal MIDI clock at specified BPM using Web Audio API for timing accuracy. Runs continuously and calls tick handler at 24ppq (pulses per quarter note).

#### zone-template.js
Generates HTML templates for zones using string interpolation. Creates the zone UI structure including channels, sequencer grid, arpeggiator settings, CC controllers, and note range selector.

#### dragzone.js
Implements drag-and-drop reordering of zones using native drag events.

#### potdraghandler.js
Handles mouse drag interactions for rotary CC controller knobs with vertical drag motion.

#### domutils.js
Simple DOM utility functions for element selection, class management, and event handling. Provides jQuery-like convenience methods.

### Data Flow

1. **MIDI Input**: Web MIDI API → midi.js → app.js eventHandler
2. **Zone Processing**: app.js distributes MIDI events to zones based on note range and enabled state
3. **Arpeggiator**: Triggered by internal-clock.js or external MIDI clock, processes held notes
4. **Sequencer**: Triggered by clock, reads active layer steps and triggers notes
5. **MIDI Output**: Zone sends processed notes/CC → midi.js → Web MIDI API output ports
6. **Persistence**: Zones serialized to localStorage on every change (debounced 500ms). Scene files are JSON exports of the zones object.

### HTML Templates
- **res/template-zone.html**: Zone UI template with placeholders for dynamic content
- **res/template-controller.html**: CC controller knob template
- **res/about.html**: About dialog

### State Management

Global state is stored in the `zones` object in app.js:
- `zones.list[]`: Array of Zone instances
- `zones.clockOutputPorts{}`: Which output ports receive clock
- `zones.selectedInputPorts{}`: Which input ports are active
- `zones.tempo`: BPM when using internal clock
- `zones.sendInternalClockIfPlaying`: Clock sending mode
- `zones.outputConfigNames{}`: Named output port configurations
- `zones.seqLayerIndex`: Active sequencer layer (0-3)
- `zones.seqLayerQuantIndex`: Quantization mode for layer recording

Solo mode is tracked via `Zone.solocount` static counter.

### Sequencer Features
- 4 independent layers (A/B/C/D) per zone
- Melodic mode: Multi-note polyphonic steps with velocity, gate, length, chance, and conditions
- Drum mode: Up to 12 lanes of monophonic triggers
- Step conditions: Always, Previous, Not Previous, 1st cycle, Not 1st cycle, Every N cycles
- Copy/paste steps and entire sequences
- Transpose, double, half-time, velocity scaling operations
- Live recording while sequence plays

### Key Concepts
- **Zones are independent**: Each zone has its own sequencer, arpeggiator, and settings
- **Zone.solo**: When any zone is soloed, all non-solo zones are muted
- **Internal clock**: Generated via Web Audio API for precise timing, always runs in background
- **Multi-input support**: Multiple MIDI input ports can be selected simultaneously
- **Output presets**: Named configurations of output port + channel for quick recall
- **DIV_TICKS array**: Maps note division indices to MIDI ticks (24ppq)

## Important Implementation Notes

### MIDI Note Numbers
Note numbers range 0-127. Display format uses `Note.display()` which shows "C-1" to "G9".

### Arpeggiator Direction Modes
0=Up, 1=Down, 2=Up/Down (alternating), 3=Random, 4=Order (as played)

### Sequencer Conditions
Step conditions determine when a step plays. Condition evaluation happens in `zone.js` during clock ticks. Conditions reference previous step state and cycle count.

### CC Controller Types
- 0: Unipolar rotary (0-127)
- 1: Bipolar rotary (-64 to +63)
- 2: Spacer (visual separator)
- 3: Button bank (8 buttons with custom values)
- 4: Note-to-CC (converts incoming note number/velocity to CC)
- 5: Unipolar 14-bit (MSB + LSB)
- 6: Bipolar 14-bit

### Clock Sources
- External: MIDI clock from selected input port
- Internal: Generated by internal-clock.js at zones.tempo BPM
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
