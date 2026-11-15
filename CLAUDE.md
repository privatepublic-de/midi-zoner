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
- **src/main/main.ts**: Electron main process. Handles window creation, application menu, file dialogs (save/load scenes), IPC communication, and window state persistence via electron-settings. One instance per profile (`requestSingleInstanceLock()`): a second start focuses the running window, since it would get no localStorage and open the same MIDI ports; `--user-data-dir` gives a test instance a profile (and lock) of its own.
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
- Port hot-plug: every `statechange` (plus one re-scan 1s after the last event) re-enumerates ports at once (keeps `knownPorts` current) but reports to `portsChangedHandler` 300ms after the last change, as one net diff (one toast per device). Don't gate on the event's own port — multi-port devices can list ports before their own event fires
- `midi.zoneInputPorts` — set of ports claimed by per-zone routing; these bypass the global channel gate so all channels pass through for zone-level filtering

#### zone/ Directory
Contains zone-related classes split into separate modules:

- **zone-class.ts**: Main Zone class with note range, channel, output/input routing, arpeggiator, sequencer, and CC controllers. Holds `arrangements[]` array and `captureArrangement()` / `applyArrangement()` methods
- **sequence.ts**: Flat step sequencer (no sub-layers); supports melodic and drum modes. The old 4-layer system is replaced by global arrangements
- **seq-layer.ts**: Contains only `PPQ` (24), `DIV_TICKS` and `DivTick` — the clock resolution and tick-to-division mapping constants
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
- **cc-controller-view.ts**: CC pot rendering, knob geometry/display shared with the editor (`knobPaths()`, `controllerDisplay()`), mouse drags (`startControllerDrag()`)
- **cc-editor.ts**: the controller editor panel (`#ccEditor`), see Device presets / CC controllers below
- **output-port-manager.ts**: MIDI output port selection UI
- **track-view.ts**: the track view (see below)
- **take-editor.ts**: the track view dock's Notes tab, a piano roll for a take (see Takes)
- **toast.ts**: Toast notification utilities
- **editor-sheet.ts**: the header shared by the full-window editor panels (piano roll, controller editor), `.editor-sheet` / `.es-bar` in styles.css: panel name, zone chip, Play/Stop (clicks `#startClockButton`, hidden with an external clock), the panel's tools, undo/redo naming the step (`updateSheetHistory()` from app.ts, the chip's zone prefix dropped), Done. Edits apply immediately, so Done, Esc and a click on the dimmed app only close. Space passes through both panels as play/stop
- **number-input-controller.ts**: Numeric input with +/- buttons

#### Other Modules
- **internal-clock.ts**: Generates internal MIDI clock at specified BPM using Web Audio API for timing accuracy. Ticks are handled `LOOKAHEAD_MS` (100 ms) ahead: the clock output goes at the tick's timestamp, what zones play (and Start) goes out when the tick is handled. Tick timestamps jitter by a few ms (`currentTime` moves in audio blocks)
- **metronome.ts**: click on every beat while running and the count-in's clicks (see Metronome below)
- **meter.ts**: meters (see Meters below): bar length, beat positions, snapping, labels, `parseMeter()` for scene data and typed text
- **undo-history.ts**: `UndoHistory` class — push/undo/redo stack (max 20 entries), with gesture grouping so continuous drags produce a single undo entry
- **zone-template.ts**: Generates HTML templates for zones using string interpolation
- **dragzone.ts**: Implements drag-and-drop reordering of zones
- **potdraghandler.ts**: Handles mouse drag interactions for rotary CC controller knobs
- **domutils.ts**: DOM utility functions for element selection and class management
- **timeline.ts**: run, session and song positions for the track view and takes (`timelineClock()` / `timelineTransport()` / `timelineSection()` from app.ts, `nowTick()`, `songNow()`) and `NoteHistory`
- **prng.ts**: Deterministic PRNG utilities (`mulberry32`, `BagShuffle`) used for arpeggiator randomization

### Data Flow

1. **MIDI Input**: Web MIDI API → midi.ts → app.ts eventHandler
2. **Zone Filtering**: eventHandler checks per-zone `inputPortId`/`inputChannel` (if set) or falls back to global `selectedInputPorts` channel filter
3. **Zone Processing**: app.ts distributes MIDI events to zones based on note range and enabled state
4. **Arpeggiator**: Triggered by internal-clock.ts or external MIDI clock, processes held notes
5. **Sequencer**: Triggered by clock, reads the flat `Sequence` steps for the active arrangement and triggers notes
6. **MIDI Output**: Zone sends processed notes/CC → midi.ts → Web MIDI API output ports
7. **Persistence**: Zones serialized to localStorage on every change (debounced 500ms). Takes are kept apart (`<userData>/takes.json`, see Takes). Scene files are JSON exports of the zones object, with each zone's takes. Load (`#load`): a file with only `list` (a zone file from ⋯ → Save zone to file…, `isZoneFile()`) adds its zones; any other file replaces the scene, settings included (`sceneFromFile()` keeps only known, checked keys with defaults for the rest, port names merge with the file's winning, then `remapChangedPortIds()` re-links ports from another machine; `showScene()` redraws the scene-wide controls, shared with undo/redo). Every mutation is also pushed to `UndoHistory`.

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
- `zones.arrangementQuantIndex`: Quantization mode for arrangement switching (2 bar, 8 beat, 14 16th of the playing song, in its meter; the old 3 = "3/4 bar" loads as bar)
- `zones.meters[0–3]`: each arrangement's meter (null = 4/4)
- `zones.toggleQuantOn` / `zones.toggleQuantIndex`: whether zone toggles wait for a boundary while running, and which (2 bar, 8 beat, 14 16th; see Quantized toggles)

Setup drawer (`#setupDrawer` in index.html, under the top bar's Setup button): a grid of columns (`.drawer-col`: MIDI, Metronome, Switching, View, Scene; narrow windows wrap whole columns), each a title (`.drawer-title`) over rows of a dim label and its controls (`.drawer-row` > `.drawer-label` + `.drawer-val`). Every control has a word, not just an icon. The metronome's Channel and Notes rows (`.metro-midi`) show once a MIDI out is chosen (`#metroSettings.has-midi`); Count-in's row (`#metroBarsField`) is disabled with an external clock.

Hidden MIDI ports: `midi.hiddenPorts` (id → name, localStorage key `hiddenPorts`, per machine, not in scenes). `app.ts` filters port lists through `visiblePorts()` before building any selector; ports referenced by zones, clock, Mackie or selected inputs (`portsInUse()`) always stay visible. Managed via "Manage MIDI ports" in the input port window.

Device presets: named CC/NRPN controller sets, stored apart from scenes as one JSON file each (`format: "midi-zoner-device-preset"`). Factory presets are read-only in `res/device-presets/` (KORG minilogue xd: VCOs, Multi, Filter/EG, LFO, FX; KORG monologue: Panel; KORG NTS-1 mkII: Osc/Filter, FX, Arp, Osc params, FX params; Waldorf Streichfett: Panel; Moog Little Phatty: Osc/Filter, Mod/EG, Arp; Moog Minitaur: Panel, Extras; KORG volca bass, keys, fm, fm2: Panel; KORG volca drum and sample2: Single ch, for their single channel mode, with pages; KORG microKORG XL: Osc/Mixer, Filter/Amp, EG/LFO, Virtual patch, FX/Arp, Vocoder bands — range-coded NRPNs (arp, voice mode, patch source/dest) are NRPN knobs with 128 `valueNames`). They are generated by `scripts/gen-device-presets.py` (edit there and rerun, values measured on hardware override the KORG charts). Button banks show up to 8 entries: one column up to 3, then two equal columns of up to 4 rows (`--button-rows`), where labels must be ~4 characters; user presets live in `<userData>/device-presets/`. Ids are `factory/<file>` / `user/<file>`. `main/device-presets.ts` does the file IPC (`presets-list`, `presets-save`, `presets-delete`, `presets-import`, `presets-export`, `presets-reveal`); `modules/device-presets.ts` parses, validates (`sanitizePreset()`: preset files are untrusted), caches and applies them. A zone keeps a copy of the controllers plus `zone.devicePreset = {id, name}`; the editor's Presets button shows "device · name" of the linked preset (`devicePresetLabel()`) and "•" when the controllers differ (`differsFromPreset()`, ignoring `val` and `number_in`). Presets never contain `number_in`; replacing keeps a zone's MIDI learn on controllers with the same CC/NRPN address. The zone's CC panel is for playing only (knobs always drag, double-click or the pencil button opens the editor) with a toolbar above the controls (`.cctools`: page tabs on the left as separate chips (like the arrangements A–D), Edit (pencil icon) and Send all on the right); without tabs `renderControllersForZone()` moves the toolbar into the heading of the first row's last section (`.tools-on-ruler`), so Edit/Send all sit at the end of its ruler after a thin divider, which sets them apart from that section (moved back before each re-render). There are no right-click menus; device presets are only in the editor's header, next to Send all. "Delete all" (`cc_remove_all`: confirms, clears the controllers and the preset link, one undo step) sits after Delete in the list tools. Setting up happens in the controller editor (`viewcontroller/cc-editor.ts`, `#ccEditor` in index.html): a full-window panel like the piano roll with a table of all controllers (drag to reorder: a section takes its controllers along, a page its whole page, and they snap to section / page boundaries, `moveUnit()` / `dropIndex()` in cc-layout.ts, action `cc_move_range`; ↑/↓, ⌥↑/↓ move, ⌫ delete, ⌘D duplicate, ⌘Z undo), the zone's layout at 3/8 scale, and the selected controller's settings: a test knob or buttons that send, Sends, Range, Played by (Learn button), Values (one row per snap step or named value) and Buttons. Its static fields carry `data-cce-action` / `data-cce-change` (the zone index is added when it calls `actionHandler`); it redraws via `onControllersChanged()` after every `updateControllerValues()`, keeps the selection across undo (zone objects are replaced) and stops key events so the app's shortcuts don't fire behind it. Sections show as header rows in its table (controllers indented below, "Section" button adds one, its settings: name, colour, start a new row), and the layout preview mirrors the zone's sections. Field values are only written when the field isn't focused, and value rows are rebuilt only when their count changes, so typing is never interrupted. The editor's Presets menu button uses `ccpresets:<zone>` in its `data-contextmenu` spec, which expands to maker headings (`presetsByMaker()`: a device name's first word when 2+ devices share it, the rest under "Other") and a row per device with its presets as chips (`html:` / `heading:` menu entries, user presets dashed). Click replaces, shift-click appends; "Add all" (`cc_preset_apply_all`) puts every preset of the device on a page of its own. "Manage presets…" opens `#presetManageDialog` (viewcontroller/device-preset-manager.ts): edit details, duplicate, export and delete per preset (factory: duplicate/export only), import, export all, show folder. Renaming keeps the file id, so zone links stay valid; imports are sanitized before they are written.

Port id changes: macOS/CoreMIDI can give a device a new port id after a reboot. On every port update `remapChangedPortIds()` (app.ts) re-links references to absent ids (zone output/input, output presets, clock outputs, selected inputs, clock input, Mackie in/out) to the single present port of the same direction whose name matches `zones.knownPortNames[oldId]` (full port names). Ambiguous names (identical devices) are left as "⚠ missing".

Card layout: `#zones` is a grid of 560px columns, cards in rows in zone order (left to right, so with two columns zone N is in row ⌈N/2⌉, like the pad and the mini view); every card stretches to the tallest card of its row, so opening a sequencer or arp or folding a zone never moves a card to another column, only the rows below. (A packed masonry layout was tried in Nov 2026 and dropped: cards jumped columns while editing.) Below 1150px the cards are one column.

Mini view (⌘⇧M, `body.minimized`, app.ts `setMiniView()`): a floating window with M/S/Seq/Arp per zone. It has its own zoom (localStorage `miniZoomFactor`, default 0.8, 0.5–1.5; the full view keeps `zoomFactor`), and the zoom sets the window size (width = `MINI_WIDTH` × zoom, height fits the zones). Dragging its edge sets the zoom: main.ts sends `mini-resized` with the content width once a drag ends ('resized'; Linux: 'resize', settled 300 ms) and the renderer answers with the fitting size. ⌘+ / ⌘− / ⌘0 zoom whichever view is showing.

Track view (topbar "Cards | Tracks", ⌘⇧T, localStorage `viewMode`, per machine; `viewcontroller/track-view.ts`, `body.track-view`, all CSS scoped `:not(.minimized)` so the mini view wins): each zone is a row, the zone's own header laid out by CSS on the left (two flex rows split by a `::after` break, each laid out on its own: [M S] name ⋯ ⠿ over [Seq Arp Loop] | [CC output] activity LED) and a `.track-lane` canvas (in the zone template) on the right, under a shared bar ruler (`#trackRuler`, 4/4, timeline zoom 0.5–4 px per tick, localStorage `trackZoom`). Styled as xr18: each track is a card like a zone (`--zone-surface`, `--slate-edge` frame with a lighter top, 6px gaps, `--track-gap` round the tracks and the dock), its lane and the ruler inset wells (`--slate-inset`, `--lane-pad`), the dock a tab frame (inset, edged towards the zone colour, led by its name box) over a card of its own (`#trackDock::before`), floating `--track-gap` above the window's bottom. One rAF loop draws all lanes; the playhead is fixed at 30 % and the content scrolls. Lanes are drawn on the current arrangement's song (bar 1 = where it began), with a take lane above (see Takes). While running, behind the playhead each lane shows what the zone actually sent in this section (`Zone.noteHistory`, recorded in `Zone.sendOut`, see `modules/timeline.ts`: position from the clock handler, interpolated between ticks; histories are kept at session positions (`timeline.runStart`, `sessionNow()`) up to `NoteHistory.MAX` (50000) notes; lanes draw only `between()` the view, found by binary search on start, and rows span the history's `low`–`high`), and on arp tracks the notes the arp plays from (`arp.orderlist`, or `arp_holdlist` with Hold, followed per frame by `syncHeld()`) as a faint band behind its notes, fading out ahead of the playhead while still held; ahead of it the loop cycle by cycle (see Looper) and the sequence step by step from the step now playing, as playback will decide each one (`Sequence.upcoming()`; dashed = skipped by its condition, chance or a muted drum lane), drum lanes one row each. Stopped, the playhead waits at bar 1 with the sequence starting there. A horizontal wheel or trackpad (or Shift + wheel) over the lanes or the ruler scrolls through the song, from bar 1 to the end of the longest shown take (`pinnedAt`, song positions), the ruler's Follow button (lit while following) returns. A press selects a track (an amber card edge as a `::after` overlay, as a selected xr18 strip, so the card gets no stacking context for the dock's fixed blocks); the dock (`#trackDock`, tabs Sequencer / Arp / Controllers / Track / Loop (internal id `notes`, the take editor) in `body[data-dock]`, `trackDockTab`, a tab click only selects, the chevron or a double-click on the bar's empty part folds it; its top edge drags its height, `trackDockHeight` → `--dock-open-h` on body, capped by CSS to leave the tracks 120px; double-click resets) shows the selected zone's `.seq`, `.arp-settings-block`, `.ccpots` or, in the Track tab (internal id `zone`), `.settings` + `.rangeholder` on the left (`--track-settings-w`) beside its takes (`.td-track`, `updateTakeList()`, see Takes; rebuilt only when its key changes). A tab with nothing for the track (Seq or Arp off) is dim (`.td-tab.off`); opened, the dock keeps its height and says so in its place with a Turn on button (`#trackDock.empty`, `.td-empty`). The selected row grows by a strip over its notes (`.track-strip` in the lane, `STRIP_H` = `--strip-h` 28px) holding one chip at a time at the take it is for (picked bars, else the shown take) or a hint; presses in the strip don't reach the lane. These blocks stay inside the zone element (all selectors keep working) and are only placed there with `position: fixed`; in the dock the sequencer is a grid with its tools over the steps and the step editor (`.step-info`) beside them. Seq/Arp in a track header switch the feature and open its tab; CC only opens the Controllers tab (the click is stopped before `cc_toggle`). Double-click on the take lane opens the shown take in the Notes tab, on the song lane the piano roll (melodic), the loop (Seq off) or the Sequencer tab. View-only lanes. The drag handle reorders tracks by insert (`DragZone` with `insert`: the row takes the target's place, the others shift; cards swap), the selection follows the dragged zone (`followTrack()`). Undo/redo hand each zone's `noteHistory` / `heldHistory` to its replacement (`carryOverNoteHistory()` in app.ts: same label, output and channel, else the same index if the zone count is unchanged; `Zone.adoptHistory()`), and the selection follows the zone holding the selected history.

Mini lanes (cards): under each card's header a 40px canvas (`.mini-lane` in the zone template) shows what the zone plays, drawn by the track view's `drawLane()` in its mini mode (`drawCards()` in track-view.ts, from the same rAF loop while the cards show, `cardsActive()`): its own zoom (`MINI_BARS` 3.5 bars, playhead at `MINI_PLAYHEAD_AT` 22 %, always following), bar numbers, no take lane, nothing to edit. Shown on zones with something to play (`has-mini-lane`: sequence notes, the loop or one being recorded, the arp, takes) and on unmuted zones with Seq on, even with an empty sequence. Behind the playhead what was sent (live input included), ahead the sequence and the loop; dashed is only what won't sound: a sequence that's off (`Sequence.upcoming(lane, asOn)` plays it out as if on), steps skipped by condition or chance, the loop of a silent zone. Muted or soloed-out zones draw their sequence normally (it still sounds). With the arp on, the sequence and the loop only feed it: ahead of the playhead (in the track view too) they show as the faint band of the notes it plays from (`feedsArp` in `drawLane()`), behind it the arp's notes. While running, a waiting toggle (see Quantized toggles) shows as a light line where it lands (`landingAt()`, the next bar/beat/16th of `toggleBoundary()`) tagged with what it will do (`pendingOf()` in pending-toggles.ts, e.g. "Seq on"); a waiting Seq switch flips the sequence between dashed and solid there.

Solo mode is tracked via `Zone.solocount` static counter. Zones silenced by another zone's solo get `.soloed-out`; with "Fold silenced zones" (View column of the setup drawer, localStorage `foldSoloedOut`, per machine, default on) they also get `.disabled` and fold like muted zones, otherwise they keep their layout, dimmed, so nothing moves when soloing.

Zone header: M (mute) and S chips like a mixer strip; in cards the name follows them, before Seq Arp | Loop | CC (flex `order`, groups 14px apart with a divider, chips in a group 6px; the looper is a group of its own since it records rather than switches). The M chip carries `zone.enabled` (`.ch.enabled`, "selected" while playing) and is lit dark red (`--mute-fill`, white letter) only while muted, S in the live green (`--live`); zone colours are only for zones, so the A–D buttons light neutral; the global M clears all mutes. Colour, save to file, copy to arrangement and delete are in the ⋯ menu (`.zonemenu`, `data-contextclick`), which shows the same entries as a right-click on the header (`updateZoneHeaderContextMenus()`).

Undo/redo state is tracked in a standalone `UndoHistory` instance in app.ts (not part of `zones`). Every discrete mutation calls `undoHistory.push()`; continuous gestures (e.g. dragging a CC knob) use `startGesture()` / `endGesture()` to collapse into a single entry.

### Key Concepts
- **Zones are independent**: Each zone has its own sequencer, arpeggiator, and settings
- **Arrangements**: 4 global snapshots (A/B/C/D) of all zone settings (enabled, arp, sequencer, filters, etc.). Zone identity (port, channel, range, CCs, label, color) is global and shared across arrangements. Switching is quantized to avoid mid-sequence jumps.
- **Thru, Program, Pedal** (the zone's settings row after Oct): Thru (`.popupsettings`, action prefix `filters_`, per arrangement) has a Pass line (Bend, Wheel, Sustain, CC, Program, AT→MW) and a Velocity line (Fixed, Scale); its chip shows a dot when set apart from a new zone (`NEW_ZONE_THRU`, `showThruAndProgram()` in filter-actions.ts). Program (`pgm_no`, `bank_msb`/`bank_lsb`, zone-global) shows its number on the chip; typing only sets the numbers, they go out (bank first) on the fields' `change` (Enter, leaving the field, an arrow step, a +/− step button) or Send (`filters_sendprogram`), and on scene load / port connect. Pedal (`sustain_on`) holds CC 64 down on the output: a live gesture, not saved; undo hands it to the replacing zone (`adoptHistory()`), deleting a zone or loading a scene lets go (`releasePedal()`), Panic clears it
- **Per-zone input routing**: `Zone.inputPortId` / `Zone.inputChannel` — when set, that zone only responds to that specific port+channel, overriding global input selection
- **In/Out routing popup** (`.iorouting-popup` under the zone's output chip): reads in signal order, In → MPE → Out, down a line (`.ior-link`, `--on`, grey while MPE is off) with the MPE settings on it; bend fields say "keys ± → synth ±"; the output config's name field sits under Out. With a Global input the In channel select is hidden (the channel is set per port in the input window). With its own input the chip reads "<first word of the input> → <output>"
- **MPE input** (`zone/mpe.ts`, per zone and zone-global, in the In/Out routing popup; chip shows "MPE" / "MPE→n"): Off, Pass through (member channels go out as they came, bends rescaled from `mpe_bend_in` to the synth's `mpe_pass_bend_out` (default 48 = unchanged, `rescaleBend()`), master messages on the zone channel; `sendMpeSetup()` sends the MPE Configuration Message (RPN 6, 15 members) and bend ranges (`mpeSetupMessages()`, members at `mpe_pass_bend_out`) on startup, port connect, scene load, switching to Pass, changing the bend or output, and from the popup's button) or To one channel (bend, slide and pressure follow the last held key; slide plays the zone's controllers learned to CC 74 (`playControllers()`, like a hardware knob, result via `handleMidi`) and goes nowhere else (CC 74 is the cutoff on many synths); bend rescaled from `mpe_bend_in` to `mpe_bend_out` semitones plus the master channel's ±2 and clamped; pressure counts from `mpe_at_from` (default 80, 0–120: measured on a Seaboard RISE 49, just playing reads 50–100, so 80 gives about what a KeyLab's aftertouch does) stretched to 0–127, 0 when no key is held, through AT→MW; when another key takes over it glides there in 150 ms (`PressureGlide`); or, with Pressure: Poly AT (`mpe_poly_at`), each held key's pressure as poly aftertouch on its output note (same threshold, no glide, no channel pressure) (summing or the strongest key was tried: held pedal notes swamped a solo)). An MPE zone takes every channel of its input; the master is the zone's In channel (own input) or the global port's channel (`zoneInputClaims()`, `midi.zoneAllChannels`). `MpeInput` keeps each member channel's bend/slide/pressure, since they arrive before the note-on, and a zone acts on a channel only while it owns it (it played that channel's last note, held or released less than `RELEASE_KEEP_MS` = 500 ms ago: key splits, so the next key on a reused channel can't move a fading note in the other zone). Arp, sequencer and takes play on the zone channel; with the arp on, pass-through drops per-note expression. The zone's keyboard strip shows the keys it plays as dots in the zone colour (`MpeInput.dots()`, `drawMpeDots()`; MPE zones get a 40px strip via `.zone.mpe-on`, held keys drawn dimmer): x = the pitch sounding (key + bend, interpolated between key centres), y = slide, size and brightness = pressure (muted at a light touch, full colour pressed hard), a dark rim against the keys; with To one channel the followed key is a filled dot, the others rings; released keys fade over 300 ms. Member messages redraw through `requestRender()`, one `renderNotes()` per frame however many arrive
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
  SPACER = 2,           // "Gap": half a knob of space inside a row
  BUTTON_BANK = 3,      // 8 buttons with custom values
  NOTE_TO_CC = 4,       // Converts note number/velocity to CC
  UNIPOLAR_14BIT = 5,   // MSB + LSB
  BIPOLAR_14BIT = 6,
  NRPN = 7,             // CC99/98 param number + Data Entry (see below)
  SECTION = 8,          // Named, coloured group of the controllers after it (see below)
  SELECTOR = 9,         // List of named values, each sent as is (see below)
  PAGE = 10             // Named page: the zone shows one page of controllers at a time
}
```
Sections (`zone/cc-layout.ts`): a SECTION entry in `cc_controllers` groups the controllers after it, up to the next section. In the zone each section is a block (`.ccsection`) with an optional heading line in its colour; it starts a new row (`.ccsection-break`) unless `new_row === false`, then it continues the row. The last section on a row (`.last`) grows to the zone's edge so its ruler spans the row; knobs still wrap after 8 (`.ccsection-pots` max-width 536px). A section's `group` is the colour of its controllers (groups 1–4 = `--group-1`…`--group-4`: violet, pink, bone, periwinkle, the same in every zone and never a zone colour or a state colour); a controller's own `group` is an override (0 = the section's, `effectiveGroup()`). An unnamed section is just a row break. Zone controls are drawn without boxes: colour only on the value arc (`--arc`: the effective colour, white without one), the chosen button or selector entry (a pill filled in it; unchosen buttons are dark pills; a bank with 4 rows (`data-rows`) is taller, 88px instead of 72px, so its labels keep 11px) and the section name set into its thin ruler (a quarter cell of ruler before it); a named value replaces the number in the knob (the number shows on hover or while dragging, `.ccpot.dragging`). Lists without sections from before (spacer runs used to force line breaks) are converted on load and in `sanitizePreset()` by `migrateSpacers()`: it replays the old 536px flex layout and turns spacer runs that push the next controller onto a new row into unnamed sections; spacers inside a row stay as gaps. The factory presets get their sections from `with_sections()` in the generator (one per colour group). Pot ids stay `pot_<zone>_<controller index>`, so section entries have no pot.
Pages (`pageBlocks()` in cc-layout.ts): a PAGE entry starts a page, up to the next one; entries before the first page form a page shown as "Main". With 2+ pages the zone's CC toolbar (above the controls) shows a tab per page; only the current page (`zone.ccPage`, saved as `cc_page`) is drawn, so `updateControllerValues()` skips controllers without a pot. Hidden controllers keep working (hardware input, Send all, sync). Tab switches go through `showControllerPage()` (saved, no undo step). Sections end at a page (`sectionIndexOf()`, `sectionBlocks(start, end)`). Shift-applying a preset appends it as a new page named after it (the existing controllers get a page first if there was none). In the editor pages are header rows, "Page" adds one, page and section rows collapse (chevron, double-click, ←/→; ⌥-click all of that kind; view only, kept per zone index by kind + label + occurrence, a collapsed row containing the selection opens again, ↑/↓ skip hidden rows), the layout preview shows the current page, and the zone follows the page of the selected controller.
Selectors: `discreteValues` are the values sent (0–127, one 7-bit CC, no min/max remap) and `valueNames` their names; `val` is the value last sent. In the zone the selector shows the chosen name (a pill in the section colour) over ‹ position › arrows: click opens the list (`ccselect:<zone>:<controller>` in `data-contextmenu`, expanded to `cc_select_value` entries), drag up/down and the wheel step through it (`cc_step`); `startControllerDrag()` drags over the list index, and a hardware knob sweeps the entries evenly. Converting Buttons ⇄ Selector and Knob (with snap steps or names) → Selector carries the entries over (`toSelector()` in cc-actions.ts).
Controllers on the same address stay in sync: `Zone.sendCC()` calls `syncSameAddress()`, which sets every other controller of the same 7-bit CC (`isSevenBitCC()`: knob, bipolar knob, buttons, selector), the same NRPN number or the same 14-bit pair to what was just sent, and returns the changed indices for redrawing.
`isHiResCC(type)` is true for types 5–7 (value 0–16383). NRPN controllers map the knob onto `min`–`max` in device units (`Zone.nrpnValue()`) and send CC99, CC98, the low bits on `nrpn_data_lsb_cc` (`nrpn_data_lsb_bits` wide: 7 on CC38 standard, 3 on CC63 for Korg logue devices, none = CC6 only), then CC6 with the remaining high bits. `bipolar` (NRPN only) draws the knob from the centre and shows the value relative to the middle of min–max. `valueNames` (types 0 and 7) are shown under the knob: indexed by snap step when `discreteValues` is set, otherwise by value − min.
MIDI learn (`number_in`) is armed only by the editor's Learn button (`zone.midiLearnCC`, disarmed after one CC, on selection change and on close), so pedals and wheels don't rebind controllers while editing; incoming values snap to `discreteValues` like mouse drags. Knob drags only send when the transmitted value changes (`Zone.ccOutputValue()`).
14-bit types send `number_lsb` then `number` (or MSB first with `msb_first`); `lsb_bits` = 7 (14 bit) or 3 (10 bit, Korg logue: low 3 bits on CC63, `Zone.hiResValue()` = 0–1023).

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
  NOT_FIRST_CYCLE = 4, // Play on every cycle except the first
  CYCLES = 5          // 5+ index Sequence.CYCLE_CONDITIONS ("every N cycles")
}
```

### ZoneArrangementJSON (interfaces.ts)
Each zone stores an array of 4 `ZoneArrangementJSON` objects (one per arrangement A/B/C/D). Captures: enabled/solo, octave, velocity/filter settings, all arp state (direction, hold, pattern, ratchet, strum taper, euclidean params, swing), and the flat `SequenceJSON`. Zone-global state (port, channel, range, CC controllers, label, color) lives in `ZoneJSON` itself, not in arrangements.

## Important Implementation Notes

### HTML and untrusted strings
The renderer runs with `nodeIntegration: true`, so HTML injected from a scene file can run Node code. Any string from a scene file or a MIDI device (CC/button labels, zone labels, preset names, port names) must go through `escapeHTML()` (domutils.ts) before it reaches `innerHTML`/`addHTML`/a template, or be set via `textContent`/`.value`. Templates get it as `esc`.

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

### Transport Stop and Note Ring-Out
- Arp/sequencer note-offs are normally tick-driven; once the clock stops they would never fire
- Transport stops (external Stop, Start/Stop button, MMC, Mackie) call `zone.stopped(true)`: sounding notes finish their remaining gate on timers (`Zone.ringOutAfterTicks`, last measured tick interval, capped at `Zone.MAX_RING_OUT_MS`); unsounded swing/strum/ratchet hits are dropped
- Arrangement switches, zone delete and `stopped()` without argument cut notes immediately (`flushRingOuts()`); panic just cancels the timers
- `Zone.sendOut` releases a ringing-out or still-sounding strum/ratchet note of the same pitch before any note-on, so a late note-off never cuts a new note
- Sequencer notes that only feed the arp are released at once (not audible)
- Clock pause: some sources stop sending ticks without Stop. `midi.ts` arms a watchdog on every external tick while running (`max(4 × tick interval, 100ms)`); on timeout `clockPausedHandler` → `zone.paused()` rings out sounding notes but keeps arp/sequencer positions, and the transport stays running so ticks resuming without Start continue in place. Ticks while stopped never start playback (some devices keep ticking after Stop)
- Start while already running is treated as stop + restart: notes ring out, song position resets to 0
- `midi.ts` clears the tick-interval history on Start/Continue/Stop, otherwise the first interval after Start would average across the pause and stretch strum/ratchet/swing timing

### Undo/Redo
- `UndoHistory` (src/modules/undo-history.ts) — max 20 entries, JSON snapshots of the full `zones` object
- Discrete mutations: `undoHistory.push(JSON.stringify(zones))` after the change
- Continuous gestures (CC knob drag, BPM input focus): `startGesture(before)` → `endGesture(after)` collapses to one entry
- Scene file loads also push a snapshot so load is undoable
- UI buttons `#undoBtn` / `#redoBtn` are disabled when the stack is empty
- ⌘Z / ⇧⌘Z are app-wide (keydown in app.ts, no undo roles in the macOS Edit menu, which only has cut/copy/paste/select all for text fields). A focused field is blurred first (`commitFocusedField()`), so typing in progress becomes its own entry; the editor panels let these keys through and stop all others (the piano roll in the capture phase; Space also passes there, for play/stop)
- Takes aren't in the snapshots: a take edit or delete is a patch entry (`pushPatch()`, it undoes and redoes itself), on the same stack with its label
- Undo replaces the zone objects: the piano roll and the controller editor follow the zone at the same index; the track view's note history and selection go with the matching zone (see Track view)

### Quantized toggles
- While the clock runs (not during a count-in), M, S, Seq and Arp wait for the next "Zone switches at next" boundary (Setup → Switching, `#togglequant`) when the transport's Quant chip (`#toggleQuantChip`, "Quant bar") is lit; Shift-click does the opposite of the chip. Global M/S/H stay instant
- `viewcontroller/pending-toggles.ts` keeps the waiting toggles (by zone object, in order) and blinks their chips (`.pending`, `data-flip` = the look after the toggle, CSS at the end of styles.css); pressing a waiting chip again cancels it
- `waitsForBoundary()` in `actionHandler` (viewcontroller/index.ts) runs before the undo snapshot; key switches and Mackie mute/solo/rec go through `zoneToggle()`, the same path as a plain click
- They land in `clockHandler` (app.ts) on `isSwitchPoint(pos, zones.toggleQuantIndex)`, after a pending arrangement switch on the same tick (so in the new arrangement), before the zones play the tick; `applyPendingToggles()` runs each one as a click (one undo step each). Stop lands what is still waiting

### Key Switches
When enabled (toggle in toolbar), MIDI notes 0–19 from any input are intercepted before zone routing (mutes and sequencer toggles wait like clicks, see Quantized toggles):

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
- Chance is decided ahead: `chanceRoll()` hashes a per-run seed (`chanceSeed`, renewed in `stopped()`) with cycle, step and lane (`hashRoll()` in prng.ts), so `Sequence.upcoming()` can replay conditions and chance exactly for the track view. The arp's chance still rolls live (`Zone.rngProb`)
- While running, conditional steps show whether their condition is met this cycle (`Sequence.conditionOutcome()`, results recorded per cycle in `conditionResults` on the sequence / drum lane): dimmed = skips, green corner mark = plays. Passed steps show the actual result; later ones only a certain prediction
- Per-step ratchet: count (1–8), rate (subdivision), velocity delta per repeat
- Copy/paste steps and entire sequences
- Step selection lasts while working in that zone's sequencer panel; a press anywhere else or Escape clears it (`initStepDeselection()` in viewcontroller/index.ts). Presses in `#contextmenu` and the piano roll keep it (the piano roll sets it from its note selection)
- Transpose, double, half-time, velocity scaling operations
- Live recording while sequence plays
- Piano roll (`viewcontroller/piano-roll.ts`): click on empty grid adds a note, a drag there draws a selection box (⇧/⌘ add to it); ⌘A select all, arrows move the selection (⇧: a beat / an octave, `moveItems()` orders notes along the move so none collides with one about to leave), ⌘C/⌘X/⌘V copy, cut, paste (its own note clipboard; ⌘V goes on after the copied notes, then after each paste), ⌘D duplicates after the selection. An empty target step takes the copied/moved note's step settings, an occupied one keeps its own. The zone's step selection follows the selected notes (`syncStepSelection()`, set directly so it doesn't arm note recording) and the zone's own step editor (`.step-info`) is moved into `.pr-steps` below the velocity lane while the panel is open (`hostStepInfo()`: a step editor found in the zone is a fresh one after a re-render and is taken over; `ZoneElements.stepInfoHost` lets `zone._$()` still find its fields). `.pr-steps` carries the `zone`/`seq` classes so the zone's styles apply; step move/clear, note input and an empty Locks row are hidden there. Closing puts it back and clears the step selection. The piano roll redraws on `ZONES_CHANGED_EVENT` (sent by `triggerSave`)
- Parameter locks (Elektron style, `zone/param-locks.ts`): a step's `locks` are `{a, v}` pairs, `a` the controller's address (`controllerAddress()`: `cc:<n>`, `nrpn:<msb>:<lsb>`, `hr:<msb cc>:<lsb cc>`), `v` the transmitted value (`transmittedValue()`, device units), so they survive reordering and preset replacement; locks without a controller on their address stay dormant (kept, shown dimmed, not sent). `SeqStep.from()` deep-copies and sanitizes them (`parseLocks()`), so every step copy must go through it. A step may hold locks only (`isBlank()` = no notes and no locks). Playback: `ParamLocks` (owned by the zone, survives arrangement switches) gets `stepPlayed()` from `playRegularStep` / `playDrumStep` (after condition/chance, inside the swing timer, once per step); a lock holds until the next played step of the same lane (melodic = -1, drum lanes 0–11) that doesn't lock it; per address the highest lane wins. `slide` glides over the step length in `tick()` (called from `Zone.clock` before the sequence). Value catch: start (not a Continue) and switching the sequencer on / an arrangement in while running send the controllers' own values for all locked addresses; stop restores where a lock was sent last, after ring-out notes (`_ringOutUntil` + 20 ms); pause keeps them. Everything goes out through `Zone.sendTransmitted()`, which never changes `val`. Editing: with steps selected, knob drags, hardware knobs (app.ts: one undo entry per burst), selector and button clicks go through `zone.beginControllerEdit()` (a copy, its value becomes a lock on the selected steps and is auditioned) and knobs show `lockedView()` (red arc, dashed when the steps differ); deselecting while stopped restores the auditioned value; while playing without a selection knobs follow the value a lock or slide sent last (`ParamLocks.liveValue()`, green dot `.lock-live`, redrawn once per frame via `CC_LOCK_VALUES_EVENT`); the controller editor clears the selection. `initStepDeselection()` keeps the selection on the same zone's `.ccpots`. The step editor (`.step-info`) sits in the layout below the grid so the controllers stay reachable; its Locks row is `viewcontroller/step-locks.ts`. ⌥-click selects a drum step without adding a hit. The piano roll's step editor lists existing locks (the knobs are behind the panel)

### Takes
- midi-zoner is for noodling: nothing is armed. Every run (Start → Stop) records what is played into each zone (input notes after the octave shift, `Zone.recordTakeNote()` / `recordNoteOff()` from `handleMidi`, in run ticks); a muted zone records nothing. Stop makes it the zone's newest take (`takeStore.endRun()` from the transport handler in app.ts); an arrangement switch doesn't end it, it adds a section (`takeStore.section()`: where it began and its meter, `Take.sections`, so `Take.barLine()` / `sectionAt()` give the bars as played). Takes don't play back (the looper plays); they're an archive to keep as the loop, loop bars from, edit, quantize or turn into steps
- `modules/take-store.ts` (`takeStore`): takes per **zone id** (`Zone.id`, stable, in `ZoneJSON.id`; a zone file's zones get fresh ids, `createZone(…, freshId)`), oldest first, at most `MAX_TAKES` (16), plus the recording under way and which take each zone shows (`shownTake()`, `browse()`, `show()`). Takes are **not scene data**: not in `zone.toJSON()`, so not in undo snapshots or localStorage (they can grow to megabytes); undoing a zone's delete or a Load finds them again under its id
- Saved apart (`modules/take-files.ts`): `<userData>/takes.json` (`format: "midi-zoner-takes"`, the takes of the scene's zones by id), written a second after a change (`takeStore.onChange`), atomically (temp file + rename), synchronously on `beforeunload`, and once at every start (`takesNeedSaving()`); read at start (`loadSavedTakes()`, sanitized by `Take.listFrom()`). Scene files (`sceneWithTakes()` in app.ts) and zone files (`zone_export`) carry each zone's `takes`; `createZone()` puts them in the store
- `zone/take.ts`: `Take { id, start, length, offset, notes: {t, d, n, v}[], at, seq, sections }`, times in ticks (fractional); recorded takes have start 0 (run tick 0 = Start). `visibleNotes()`, `slice()`, `moveNotes()`, `restore()` (undo of an edit), `lengthLabel()`
- Undo: a take edit or delete is a patch entry in `UndoHistory` (`pushPatch(label, {undo, redo})`, same stack and labels as scene steps): `commitTake` / `remove` hooks from `initTrackView` in viewcontroller/index.ts (`Take.restore()` with its JSON before/after; a deleted take goes back at its index)
- Track view: a track with takes (or recording, `Zone.hasRecorded`) gets a take lane above its song lane (`TAKE_LANE_H` 48px, same pitch rows): while running the take being recorded (`takeStore.recordingOf()`, run ticks drawn at `t − runToSong`), after Stop the shown take in a dashed frame from bar 1. The selected track's strip holds `‹ Take n/m · 6 bars ›` Keep / Edit / Quantize / To steps. A drag in the take lane picks bars (`capture`, the take's own bars via `snapInTake()`, ⌥ beats), with "Loop · n bars" / Quantize / To steps: **Loop** makes them the zone's loop in this arrangement (`loopFromTake()` → `loopFromNotes()` in looper.ts, the pick-up from the bar before them at its end; one scene undo step; while running its first 1 is the next bar line, `looper.anchor`). The Track tab lists the takes newest first (time recorded, preview to one scale, length, notes; Keep always shown, Edit / Delete on the hovered and the shown row; a narrow list (container query under 640px) drops time and notes); a row click shows it in the lane
- **Loop n bars** (`keepTake()` in track-view.ts; the take chip, the list and the cards' strip, the button names the loop's length, `keepLabel()`, cached per take and store version): the whole take becomes the zone's loop in this arrangement, replacing the loop there (one undo step "Loop from Take", via `loopFromTake()`, refused while the looper records or dubs, over 64 bars a toast). `keepRange()`: from the bar of its first note to the bar line after its last (a release under a 16th past a bar line adds no bar); a first bar holding only a pick-up into the next 1 (`pickupStart()` in looper.ts, the rule `loopFromNotes()` uses) isn't a bar of the loop: the loop starts at that 1 and the pick-up goes at its end. Works while running (the loop comes in at the next bar line)
- Cards: while stopped, a zone with takes shows a strip under its mini lane (`.card-takes` in the zone template, `has-card-takes`, `updateCardTakes()` from `drawCards()`, rebuilt when its key changes): `‹ Take n/m ›`, a preview, Loop n bars, Discard. ‹ › browse the same shown take as the track view (`takeStore.browse()`). Discard (and a Loop from the strip that worked) puts the strip away until the zone's next take (`dismissCardTakes()`: zone id → its newest take's id, localStorage `dismissedTakes`, per machine); the take stays in the track view's list
- Take → steps (`zone/take-quantize.ts`, panel `.td-convert` in the dock, `conv` in track-view.ts): from the take chip, the list or picked bars. `analyse()` picks the coarsest grid of 1/4…1/32 incl. triplets that the notes fit (mean distance ≤ 15 % of a step and at most 5 % of the notes more than 0.3 off), each straight grid also tried with swing 0–60 % (used when it cuts the error by a third). Notes snap to the nearest (swung) step; same pitch on one step keeps the louder, a chord takes its longest note's length; a note released within a fifth of a step before the next counts as legato; gate rounds to 5 %, ≥ 90 % → 100 %. Drums: one lane per pitch (≤ 12). Convert (`applyToSequence()`, one undo step) replaces the zone's sequence for this arrangement and switches Seq on; the take stays
- Quantizing a take: the same panel with "Into: Steps | The take". `quantizeStarts()` moves each note start `strength` (10–100 %) of the way to its step (with the Swing chip on, to the swung step), lengths stay; the take changes in place (`Take.moveNotes()`, a take patch)
- Loop tab (internal id `notes`; `viewcontroller/take-editor.ts`, `.td-notes`): a piano roll for the zone's **loop** or a **take** (`TakeTarget.kind`, the Loop | Take switch in its toolbar, `editing` in track-view.ts by zone id; default: the shown take, else the loop; double-click on the take lane opens the take, on the song lane the loop when Seq is off). The length stays (no edge trimming; pasted notes past the end are left out). Grid (1/4…1/32 or Off, localStorage `takeEditorGrid`): moves go by whole grid steps (relative snapping, ⌥ free), new notes and lengths snap to it. Click on empty space adds a note, a drag boxes (⇧/⌘ add), a note's body moves, its right edge sets the length, a velocity bar drags. Keys while the editor was the last place pressed: arrows, ⌫, ⌘A, ⌘C/X/V/D, Esc; Space and ⌘Z pass. Quantize (selection, else all) with a strength; on a take "Loop these bars" makes the bars around the selected notes the loop. Each gesture is one undo step (the loop's a scene step via `commit`, a take's a patch via `commitTake`); the playhead shows on the loop while running
- Old scenes (kept takes per arrangement, before Nov 2026): `migrateKeptTakes()` in app.ts moves every kept take into the zone's takes (its shown window, from 0); in an arrangement without a loop whose kept takes played (`takes_on`, missing = on), the first one of up to 16 bars becomes its loop. `zones.loops` (the ruler's loop ranges) are dropped
- Planned next: MIDI export

### Looper
- One loop per zone and arrangement (`Zone.loop`, a `Take` with `start` 0, saved as `ZoneArrangementJSON.loop`), played every cycle from `Looper.anchor` (where it was recorded; 0 after Start, Stop or an arrangement's entry, so it starts over at bar 1) by a second `TakePlayer` (`loopPlayer`, `clockLoop()`, not marked as a take in the note history). Silent while the zone is muted or soloed out (`Zone.audible`; sounding notes ring out)
- One button: the Loop chip after Arp, in a group of its own (`zone_loop`, handled before `waitsForBoundary()`: never quantized by the Quant chip) and Mackie Rec on the zone picked with a strip's Select (key switch planned). `zone/looper.ts` (`Looper`, runtime only, handed on by `adoptHistory()`), positions in ticks since the section began (`nowTick() − sectionStart`, so the ruler's loop range doesn't move them): a press counts for the nearest 1 (`nearestOne()`: in a bar's first half the 1 just passed, what was played since comes from its input buffer; in the second half it waits for the coming 1). No loop: starts recording; the next press closes at its nearest 1 (at least a bar after the start; ahead: waits, `to`), the loop plays from there. A loop: starts an overdub (its notes play along on later cycles as `dubLayer()`), the next press ends it and merges them (`closeDub()`; a note is left out when the loop has the same pitch within `SAME` (4 ticks) of its place, or an earlier cycle of the overdub has; same-pitch notes close together on one cycle all stay; the layer is cached per buffer change). A press while waiting for the 1 cancels; two presses within `DOUBLE_PRESS_MS` (400) on a playing loop clear it (only when the first one started an overdub, so a quick tap after closing doesn't). While stopped a press waits for bar 1 (`loopNow()` = −1). Longest loop 64 bars (closes by itself)
- Pick-ups (`loopFromNotes()`, also for Loop from a take): the phrase leading into the first 1 goes at the loop's end: in the bar before it, the notes after the last rest of a beat or more that starts after that bar's 1 (playing straight through, or a bar of the line from its 1, wraps nothing; tested with continuous 8ths and pick-up shapes), unless the loop has the same pitch there already (within `MIRROR`, under a 16th); an overdub takes notes up to half a bar before its 1 (they fold to their place). Notes up to `EARLY` (3 ticks) before a 1 belong to it: the start's downbeat is in, the end's (the next round) is out
- Ends that wait land from the clock handler (`landLoops()` in viewcontroller/index.ts, before the zones play the tick, so the loop plays from it); Stop (before `timelineTransport(false)`) and an arrangement switch (before `switchZonesToArrangement()`) close a recording or overdub at its nearest 1 (`finishLoops()`, `Looper.finishAt()`), each zone's close an undo step of its own. Undo steps: Record Loop, Overdub Loop (only when notes were added), Clear Loop; the snapshot is taken at the landing; nothing played → no loop, a toast
- Chip (`updateLoopChips()` in track-view.ts, every drawn frame and after a press; `Zone.loopChip`): "Rec" (none), "Loop 4" outlined in `--on`, not filled (plays: a press overdubs, so it mustn't look like a lit Seq or Arp you'd switch off; dimmed outline in a silent zone), red "Rec 2" / "Dub 4" while recording or overdubbing, blinking off ↔ red while it waits for its 1, red ↔ outlined while it waits for its end (CSS `loop-wait`, `loop-closing`). Its tooltip says what a press does next (`loopChipTitle()`). Mackie Rec LED: lit while recording/overdubbing, flashing while waiting (`recLed()` in app.ts, checked every tick)
- Lanes (`drawLane()`): the loop cycle by cycle ahead of the playhead with a line at each cycle start (dashed while silent; with the arp on it feeds it: the faint band), its notes a light fill with an edge (`asLoop`) so they read apart from the sequence's solid ones; tags in the zone colour at the bottom (`lineTags`): "Loop 4 bars" at its next cycle start in view (else at the playhead), "Seq" one row up at the sequence's next repeat while a loop plays too, a red wash from a recording's or overdub's first 1 to the playhead, and a mark where it starts ("Rec" / "Dub") or ends ("Loop 4 bars" / "Dub end")
- Tested with scripted presses (`looper.ts` alone, 4/4 and 3/4) and in the app (late/early presses, pick-up, overdub, mute, clear + undo, Stop and an arrangement switch while recording)

### Metronome
- Transport chips: Click (`#metroClick`, a click on every beat while running; its `.beat-led` flashes on every beat either way, the bar's first in live green) and Count-in (`#metroCountIn`, internal clock only, hidden with an external one). Sound in the setup drawer's Metronome group (`viewcontroller/metronome-controls.ts`): count-in length (1 or 2 bars), volume, audio output (`setSinkId` on the metronome's own AudioContext, so the clock's is never affected), MIDI click port/channel/accent and beat notes. Settings are per machine (localStorage `metronome`), not in scenes; the MIDI port is kept visible by `portsInUse()` and remapped by `remapChangedPortIds()`
- Beats come from the song position (`metronomeBeatAt()` in app.ts, in the arrangement's meter): accents follow the bars and a pending arrangement switch. `metronomeTick()` gets every tick with `atMs`, when the tick is due for what it plays (`clockHandler`'s third argument: internal ticks = timestamp − `LOOKAHEAD_MS`, external = arrival). It follows a steady time and interval (`steadyTime()`: a line fitted through the first bar of ticks, then a phase lock; restarts on a pause, a jump or a tempo change over 15 %) and schedules audio clicks up to 40 ms ahead, so an external clock's beats are predicted. Measured: clicks within ±2 ms of the beat grid from the first count-in beat, a 120 → 90 BPM change settles within one beat. Audio clicks are mapped to the output via `getOutputTimestamp()` and cancelled on Stop; MIDI clicks go out on the beat's own tick (a sent note can't be taken back)
- Count-in (`midi.startClock(ticks)`, from `startTransport()` in app.ts for the Start button, Space, MMC Play, Mackie Play and an incoming Start; not Continue): the internal clock's ticks go on as while stopped (forwarded to clock outputs as then) and are reported to `midi.countInHandler` at positions −ticks…−1, Start (`startInternal()`) follows on the next tick. Stop during it only cancels (`countInHandler(null)`). The Start button shows "Count n" (`.counting`), the track view's song comes in from the right (`timelineCountIn()` / `countInNow()`), the ruler says Count-in. Notes played during the count-in are not recorded (the run hasn't started)
- An external clock decides where bar 1 is, so it has no count-in (the drawer's field is disabled with a hint to use the clock source's own)

### Meters
- One meter per arrangement (`zones.meters`, saved with the scene, sanitized by `parseMeter()`), set in the A–D right-click menu (`meters:<arrangement>` in `data-contextmenu`, expanded by `meterMenu()` in viewcontroller/index.ts: `METER_CHOICES` plus a field for any n/4 or n/8 with a grouping, e.g. "11/8 3+3+3+2"; action `global_arr_meter`, one undo step). A–D show a meter other than 4/4 as a small superscript (`data-meter`), the ruler head as "Stopped · 7/8 2+2+3"
- A bar is n × 1/d; beats are quarters in x/4 and the group starts in x/8 (6/8 = 3+3, 7/8 = 2+2+3 by default, `groupsOf()`), so the metronome clicks the groups (accent on the bar). Labels show the grouping except for the usual threes (6/8, 9/8, 12/8)
- `timeline.meter` is the current arrangement's (`timelineMeter()`: from the clock handler each tick and after a switch, Start, and every track-view frame), so a take ending at a switch is cut to bars of its own meter (`Zone.endTake()`)
- Follows the meter: metronome accents and beats, count-in length and count, ruler and lane lines, bar numbers and "bar.beat", the looper's nearest 1, picking bars of a take (in its own sections' meters, `Take.sections`; the lane's lines use the current arrangement's), take length labels (x/8: eighths), and A–D switching at the next bar (`isSwitchPoint()` in app.ts, on song positions)
- Not affected: step sequences and the arp (polymeter against the bar is fine), the session timeline between runs (`SESSION_BAR` stays 96), the piano roll's beat marks (every 4 steps). Changing a meter moves nothing: takes keep their tick positions

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
- The chosen source (localStorage `midiInClockId`, per machine) stays chosen while its port is missing: the internal clock stands in (`followClockSource()` in app.ts, on every port update), the selector lists it as "⚠ name (missing, internal clock)" and keeps it visible (`portsInUse()`). When it reconnects (also under a new id, via `remapChangedPortIds()`) it takes over at once when stopped, else at Stop (`clockReturnPending`). Picking internal forgets it

### Zone Color Indices
Zones have color indices (0-N) that map to CSS classes. Colors can be randomized per-zone or globally shuffled.

### Look
Shared with the sibling app xr18-console: slate surfaces (`--slate-bg`, `--slate-panel`, `--slate-raise`, `--slate-inset`, `--slate-line` in styles.css) and Barlow Semi Condensed (`res/`, SIL OFL in `res/OFL.txt`). `--zone-surface-N` is slate with a 9 % wash of the zone colour (3 % muted), so cards, editor sheets and popups follow one token; playing zone cards add a soft band of the zone colour behind the header (20 % fading to 10 % within 110px, not in the mini view; the arp, sequencer and controller blocks are transparent so it shows through, and sequencer steps and arp pattern cells are opaque, dark in the zone's hue (8 % on #15171a), so they keep their tone on it and don't clash with warm zone colours); the zone name is a solid box in the zone colour; a silent zone (muted or silenced by solo) shows it in the zone colour on a grey (`--slate-line`) outline and keeps the slate frame. Radii as in xr18 (`--radius-sm` 2px small parts such as steps and notes, `--radius` 4px controls, `--radius-lg` 6px cards, sheets, dialogs and menus; only dots and LEDs are round, no pills). Text in three tiers as in xr18: labels `--slate-dim` (`.zone .label`, knob labels, unchecked `.check`), values `--text-base-color` (#e7eaee). Every button, dropdown and number field in a zone is one raised material (`--slate-raise` with a `--slate-line` edge); no see-through or black fills, the inset tone is only for the top bar groups. Two signals as in xr18: amber (`--select`, a 1px inset line on raised slate) is "where you are" (the active arrangement A–D, the current controller page tab, Cards | Tracks, the selected track and the open dock tab in the track view), the `--on` fill is "switched on"; in a muted zone a switched-on feature chip is a dimmed `--on`. Switches in zones are toggle chips (`.zone .check`, icons hidden), the octave selector is a segmented control named −3…+3 (the chosen one a step lighter with its number bright, no on fill, so it stays quiet), sliders have a 6px track with `--slider-fill` (#8fa3b8) and a small `--on` thumb, the zone number is small and dim, a missing output port shows in red (`.iorouting-text.missing`), as does "No output" (no port chosen and no named output config; no channel shown then). Chips are raised with a thin line and light up in `--on` with `--on-text`; top bar groups sit in inset frames. Mutes are red as in xr18 (`--mute-highlight` = `--danger` for text and edges, `--mute-fill` for lit M chips); S stays midi-zoner's live green.

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
- Hiding/unhiding ports (persists across restart; in-use ports can't be hidden)
