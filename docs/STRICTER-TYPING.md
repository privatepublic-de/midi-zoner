# Stricter Typing Opportunities in midi-zoner

## Summary

Found **60+ locations** across 10 files where stricter typing would improve type safety.

---

## High Priority: Explicit `any` Types

### midi.ts - Web MIDI API Types
| Line | Current | Suggested |
|------|---------|-----------|
| 20, 73 | `eventHandler: (event: any) => void` | `(event: MIDIMessageEvent) => void` |
| 77 | `midiAccess: any = null` | `MIDIAccess \| null` |
| 79 | `deviceInClock: any = null` | `MIDIInput \| null` |
| 135 | `onMIDISuccess = (midiAccess: any)` | `(midiAccess: MIDIAccess)` |
| 149 | `onMIDIFailure = (msg: any)` | `(msg: DOMException)` |
| 154 | `onStateChange = (e: any)` | `(e: MIDIConnectionEvent)` |
| 282 | `onMIDIMessage(event: any)` | `(event: MIDIMessageEvent)` |
| 355 | `forEach((entry: any)` | `(entry: MIDIInput)` |

### viewcontroller.ts - Dynamic Property Access
| Line | Issue | Solution |
|------|-------|----------|
| 159, 163, 178 | `(zone as any)[actionProperty]` | Create `ZoneToggleableProps` union type |
| 476, 484, 494 | `(cc_controllers[i] as any)[buttonlabel${n}]` | Extend CCController interface with button properties |
| 575, 578, 809-818 | `(actions.fn as any)(arg)` | Define proper function signatures with optional params |
| 666, 900 | `steps: any[]` | `(SeqStep \| null)[]` |
| 1905, 1910, 1932 | `outputs: any[]` | `PortDescriptor[]` |

### app.ts
| Line | Current | Suggested |
|------|---------|-----------|
| 81 | `applyStoredZones(storedZones: any, ...)` | Define `StoredZonesData` interface |
| 95 | `slayer: any` | `SeqLayer` |
| 101 | `st: any` | `SeqStep \| null` |
| 318 | `eventHandler: (event: any)` | `(event: MIDIMessageEvent)` |

---

## Medium Priority: Loose Object Types

### toJSON() Return Types
| File | Line | Should Return |
|------|------|---------------|
| zone-class.ts | 103 | `ZoneJSON` interface |
| sequence.ts | 70 | `SequenceJSON` interface |
| seq-layer.ts | 34 | `SeqLayerJSON` interface |
| seq-step.ts | 12 | `SeqStepJSON` interface |

### Generic Element Types (zone-elements.ts)
| Line | Current | Suggested |
|------|---------|-----------|
| 9-10 | `NodeListOf<Element>` | `NodeListOf<HTMLElement>` |
| 11 | `(NodeListOf<Element>)[]` | `HTMLElement[][]` |
| 15, 20-21 | `NodeListOf<Element> \| null` | `NodeListOf<HTMLElement> \| null` |
| 62, 94 | Returns `Element \| null` | `HTMLElement \| null` |

---

## Medium Priority: Enum Candidates

### CC Controller Types (interfaces.ts:9)
```typescript
// Current: type: number
// Suggested:
enum CCControllerType {
  UNIPOLAR_ROTARY = 0,
  BIPOLAR_ROTARY = 1,
  SPACER = 2,
  BUTTON_BANK = 3,
  NOTE_TO_CC = 4,
  UNIPOLAR_14BIT = 5,
  BIPOLAR_14BIT = 6
}
```

### Arpeggiator Direction (zone-class.ts:55)
```typescript
// Current: arp_direction = 0
// Suggested:
enum ArpDirection {
  UP = 0,
  DOWN = 1,
  UP_DOWN = 2,
  RANDOM = 3,
  ORDER = 4
}
```

### Step Conditions (sequence.ts)
```typescript
enum StepCondition {
  ALWAYS = 0,
  PREVIOUS = 1,
  NOT_PREVIOUS = 2,
  FIRST_CYCLE = 3,
  NOT_FIRST_CYCLE = 4
  // 5+ are cycle conditions
}
```

---

## Lower Priority: Magic Numbers

### MIDI Constants (various files)
- `127` - MAX_MIDI_VALUE
- `0` - MIN_MIDI_VALUE
- `12` - SEMITONES_PER_OCTAVE
- `5` - COLOR_PALETTE_SIZE (zone-class.ts:146)

### Black Key Detection (note.ts:18)
```typescript
// Current: nn == 1 || nn == 3 || nn == 6 || nn == 8 || nn == 10
// Suggested:
static readonly BLACK_KEY_SEMITONES = [1, 3, 6, 8, 10] as const;
```

### Potentiometer Angles (potdraghandler.ts:23-29)
- `225`, `135` - POT_ANGLE constants

---

## Lower Priority: Action String Literals

### viewcontroller.ts - Action Names
```typescript
// Current: Record<string, () => void>
// Suggested:
type ZoneAction =
  | 'zone_enabled' | 'zone_solo' | 'zone_delete'
  | 'arp_enabled' | 'arp_hold' | 'seq_toggle'
  // ... etc
```

---

## Files Summary

| File | Issues |
|------|--------|
| viewcontroller.ts | 20+ `any` types, dynamic property access |
| midi.ts | 15+ `any` types (Web MIDI API) |
| app.ts | 6 `any` types |
| zone-class.ts | Magic numbers, enum candidates |
| zone-elements.ts | Generic Element types |
| interfaces.ts | Enum candidates for `type` field |
| zone-template.ts | 2 `any` types |
| dragzone.ts | 1 global `any[]` declaration |
| seq-step.ts, seq-layer.ts, sequence.ts | `object` return types |
