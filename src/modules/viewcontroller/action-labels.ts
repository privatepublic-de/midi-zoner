import { ZoneType, ZonesData } from './types';

// Sorted longest-prefix-first so e.g. "zone_arp_" is tried before "zone_",
// regardless of declaration order.
const PREFIX_CATEGORIES: Array<[string, string]> = (
  [
    ['zone_arp_', 'Arp '],
    ['seq_step_', 'Step '],
    ['seq_drum_', 'Drum '],
    ['seq_', 'Sequence '],
    ['cc_', 'CC '],
    ['filters_', 'Filter '],
    ['zone_', '']
  ] as Array<[string, string]>
).sort((a, b) => b[0].length - a[0].length);

function titleCase(s: string): string {
  return s
    .split('_')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function humanizeAction(action: string): string {
  for (const [prefix, category] of PREFIX_CATEGORIES) {
    if (action.startsWith(prefix)) {
      return category + titleCase(action.slice(prefix.length));
    }
  }
  return titleCase(action);
}

export const ARRANGEMENT_LETTERS = ['A', 'B', 'C', 'D'];

type OverrideFn = (actionParam1: string, actionParam2: string) => string;

// Only the action names whose auto-humanized form reads badly or needs
// dynamic detail get an entry here — everything else falls through to
// humanizeAction().
const ACTION_LABEL_OVERRIDES: Record<string, string | OverrideFn> = {
  zone_label: 'Zone Name',
  zone_range: 'Note Range',
  zone_outport: 'Output Port',
  zone_arp_euclid: 'Euclidean Rhythm',
  zone_arp_gatelength: 'Arp Gate Length',
  zone_arp_showeuclid: 'Show Euclidean Editor',
  zone_arr_copy_to: (p1) => `Copy to Arrangement ${ARRANGEMENT_LETTERS[parseInt(p1)] ?? ''}`.trim(),
  global_arr_copy_to: (p1, p2) =>
    `Copy Arrangement ${ARRANGEMENT_LETTERS[parseInt(p1)] ?? ''} → ${ARRANGEMENT_LETTERS[parseInt(p2)] ?? ''} (All Zones)`,

  seq_clear_all: 'Clear Sequence',
  seq_clear_selected_step: 'Clear Step(s)',
  seq_clear_step: 'Clear Step',
  seq_gatelength: 'Sequence Gate Length',
  seq_open_piano_roll: 'Open Piano Roll',
  seq_record_live: 'Live Recording',
  seq_step_add_notes: 'Add Notes to Step',
  seq_step_probability: 'Step Chance',
  seq_step_ratchet_delta: 'Ratchet Velocity Delta',
  seq_step_ratchet_res: 'Ratchet Rate',
  seq_steps: 'Step Count',
  seq_paste_step: 'Paste Step',
  seq_copy_step: 'Copy Step',
  seq_drumstep_select: 'Select Drum Step',

  cc_add: 'Add CC Controller',
  cc_remove: 'Remove CC Controller',
  cc_button_trig: 'Trigger CC Button',
  cc_change_group: 'CC Group',
  cc_change_type: 'CC Type',
  cc_left: 'Reorder CC Controller',
  cc_right: 'Reorder CC Controller',
  cc_notenum2cc: 'Note Number → CC',
  cc_notevelocity2cc: 'Note Velocity → CC',
  cc_number_in: 'CC Input Number',
  cc_number_lsb: 'CC Number (LSB)',
  cc_toggle: 'Toggle CC',

  filters_at2mod: 'Aftertouch → Mod Filter',
  filters_cc: 'CC Filter',
  filters_changebank_lsb: 'Bank Change (LSB) Filter',
  filters_changebank_msb: 'Bank Change (MSB) Filter',
  filters_changeprogram: 'Program Change Value',
  filters_fixedvel: 'Fixed Velocity Filter',
  filters_fixedvel_value: 'Fixed Velocity Value',
  filters_mod: 'Mod Wheel Filter',
  filters_pitchbend: 'Pitch Bend Filter',
  filters_programchange: 'Program Change Filter',
  filters_sustain: 'Sustain Filter',
  filters_sustain_on: 'Sustain Polarity',
  filters_toggle: 'Message Filters',
  filters_velocity_scaling: 'Velocity Scaling',

  iorouting_toggle: 'I/O Routing',
  program_toggle: 'Program Change',
  toggle_seq: 'Sequencer On/Off'
};

// The property/action description, without any zone prefix.
export function describeActionProperty(
  action: string,
  actionParam1?: string,
  actionParam2?: string
): string {
  const override = ACTION_LABEL_OVERRIDES[action];
  if (typeof override === 'function') return override(actionParam1 ?? '', actionParam2 ?? '');
  return override || humanizeAction(action);
}

export function zonePrefix(zone: ZoneType | undefined, zoneindex: number): string {
  if (!zone || zoneindex < 0) return '';
  const name = zone.label ? ` (${zone.label})` : '';
  return `Zone ${zoneindex + 1}${name}`;
}

export function labelForZone(
  zone: ZoneType | undefined,
  zoneindex: number,
  property: string
): string {
  const prefix = zonePrefix(zone, zoneindex);
  return prefix ? `${prefix} – ${property}` : property;
}

interface ActionParts {
  zoneindex: number;
  action: string;
  actionParam1: string;
  actionParam2: string;
}

// Parses the "zoneindex:action:param1:param2" convention shared by
// data-action/data-change/data-focus-change/data-contextmenu attributes.
export function parseActionParts(actionString: string): ActionParts {
  const params = actionString.split(':');
  return {
    zoneindex: parseInt(params[0]),
    action: params[1],
    actionParam1: params[2],
    actionParam2: params[3]
  };
}

// Derives a human-readable undo/redo label, resolving the zone by index
// from a full ZonesData (used where the caller doesn't already have the zone).
export function describeAction(actionString: string, zones: ZonesData): string {
  const { zoneindex, action, actionParam1, actionParam2 } = parseActionParts(actionString);
  return labelForZone(zones.list?.[zoneindex], zoneindex, describeActionProperty(action, actionParam1, actionParam2));
}

// Same as describeAction, but for callers that already have the specific
// zone/zoneindex in scope and don't have a full ZonesData to look it up from.
export function describeActionForZone(
  actionString: string,
  zone: ZoneType | undefined,
  zoneindex: number
): string {
  const { action, actionParam1, actionParam2 } = parseActionParts(actionString);
  return labelForZone(zone, zoneindex, describeActionProperty(action, actionParam1, actionParam2));
}
