import { ipcRenderer } from 'electron';
import { CCController, CCControllerType, isHiResCC } from './zone/interfaces';

/**
 * Device presets: named CC/NRPN controller sets for a target device, stored as files by
 * the main process (main/device-presets.ts), separate from scenes. A zone keeps its own
 * copy of the controllers plus a reference ({id, name}) to the preset they came from.
 * Preset files are untrusted input: everything goes through sanitizePreset().
 */

export const PRESET_FORMAT = 'midi-zoner-device-preset';

export interface DevicePresetRef {
  id: string;
  name: string;
}

export interface DevicePresetMeta {
  name: string;
  device: string;
  portMatch?: string;
  notes?: string;
}

export interface DevicePreset extends DevicePresetMeta {
  id: string;
  source: 'factory' | 'user';
  controllers: CCController[];
}

interface PresetFile {
  id: string;
  source: 'factory' | 'user';
  json: string;
}

const MAX_CONTROLLERS = 256;

// [field, min, max, nullable]
const NUMBER_FIELDS: [string, number, number, boolean][] = [
  ['number', 0, 127, false],
  ['number_lsb', 0, 127, false],
  ['val', 0, 16383, false],
  ['min', 0, 16383, false],
  ['max', 0, 16383, false],
  ['note_cc', 0, 127, true],
  ['velocity_cc', 0, 127, true],
  ['group', 0, 4, false],
  ['nrpn_msb', 0, 127, false],
  ['nrpn_lsb', 0, 127, false],
  ['nrpn_data_lsb_cc', 0, 127, true],
  ['nrpn_data_lsb_bits', 0, 7, false],
  ['lsb_bits', 3, 7, false]
];

function text(v: unknown, maxLength: number): string | undefined {
  return typeof v == 'string' ? v.slice(0, maxLength) : undefined;
}

function clampInt(v: unknown, min: number, max: number): number | undefined {
  if (typeof v != 'number' || !isFinite(v)) return undefined;
  return Math.min(max, Math.max(min, Math.round(v)));
}

/** A controller with known fields only, numbers clamped; number_in is never kept */
export function sanitizeController(raw: any): CCController | null {
  if (raw == null || typeof raw != 'object') return null;
  const type = clampInt(raw.type, 0, CCControllerType.NRPN);
  if (type === undefined || type !== raw.type) return null;
  const c: any = {
    type,
    label: text(raw.label, 64) ?? '',
    number: 1,
    number_in: null,
    val: 0,
    min: 0,
    max: type == CCControllerType.NRPN ? 16383 : 127,
    note_cc: null,
    velocity_cc: null
  };
  for (const [field, min, max, nullable] of NUMBER_FIELDS) {
    if (raw[field] === null && nullable) {
      c[field] = null;
    } else {
      const v = clampInt(raw[field], min, max);
      if (v !== undefined) c[field] = v;
    }
  }
  if (!isHiResCC(type)) c.val = Math.min(c.val, 127);
  if (typeof raw.msb_first == 'boolean') c.msb_first = raw.msb_first;
  if (typeof raw.bipolar == 'boolean') c.bipolar = raw.bipolar;
  if (Array.isArray(raw.valueNames)) {
    c.valueNames = raw.valueNames.slice(0, 128).map((n: unknown) => text(n, 24) ?? '');
  }
  if (Array.isArray(raw.discreteValues)) {
    c.discreteValues = raw.discreteValues
      .slice(0, 128)
      .map((v: unknown) => clampInt(v, 0, 16383))
      .filter((v: number | undefined) => v !== undefined);
  }
  for (let i = 0; i < 8; i++) {
    const label = text(raw[`buttonlabel${i}`], 32);
    const value = clampInt(raw[`buttonvalue${i}`], 0, 16383);
    if (label !== undefined) c[`buttonlabel${i}`] = label;
    if (value !== undefined) c[`buttonvalue${i}`] = value;
  }
  return c as CCController;
}

function sanitizeMeta(raw: any): DevicePresetMeta | null {
  const name = text(raw?.name, 64)?.trim();
  if (!name) return null;
  const meta: DevicePresetMeta = { name, device: text(raw.device, 64)?.trim() || 'Other' };
  const portMatch = text(raw.portMatch, 64)?.trim();
  const notes = text(raw.notes, 2000)?.trim();
  if (portMatch) meta.portMatch = portMatch;
  if (notes) meta.notes = notes;
  return meta;
}

export function sanitizePreset(raw: any, id: string, source: DevicePreset['source']): DevicePreset | null {
  if (raw?.format !== PRESET_FORMAT || !Array.isArray(raw.controllers)) return null;
  const meta = sanitizeMeta(raw);
  if (!meta) return null;
  const controllers = raw.controllers
    .slice(0, MAX_CONTROLLERS)
    .map(sanitizeController)
    .filter((c: CCController | null): c is CCController => c != null);
  return { ...meta, id, source, controllers };
}

let presets: DevicePreset[] = [];

/** (Re)reads all preset files. Returns the names of files that could not be used. */
export async function loadDevicePresets(): Promise<string[]> {
  const files: PresetFile[] = await ipcRenderer.invoke('presets-list');
  const broken: string[] = [];
  presets = [];
  for (const f of files) {
    let preset: DevicePreset | null = null;
    try {
      preset = sanitizePreset(JSON.parse(f.json), f.id, f.source);
    } catch {
      // reported below
    }
    if (preset) presets.push(preset);
    else broken.push(f.id);
  }
  presets.sort((a, b) => a.device.localeCompare(b.device) || a.name.localeCompare(b.name));
  return broken;
}

export function getDevicePresets(): DevicePreset[] {
  return presets;
}

export function findDevicePreset(id: string | undefined): DevicePreset | undefined {
  return presets.find((p) => p.id === id);
}

/** Presets whose portMatch occurs in the given port name */
export function matchesPort(preset: DevicePreset, portName: string | undefined): boolean {
  return !!preset.portMatch && !!portName && portName.toLowerCase().includes(preset.portMatch.toLowerCase());
}

function definitions(controllers: CCController[]): string {
  return JSON.stringify(
    controllers.map((c) => {
      const { val, number_in, ...definition } = sanitizeController(c) as any;
      return definition;
    })
  );
}

/** True when the controllers differ from the preset's, ignoring knob positions and MIDI learn */
export function differsFromPreset(controllers: CCController[], preset: DevicePreset): boolean {
  return definitions(controllers) !== definitions(preset.controllers);
}

function address(c: CCController): string {
  return c.type == CCControllerType.NRPN ? `nrpn:${c.nrpn_msb || 0}:${c.nrpn_lsb || 0}` : `cc:${c.number}`;
}

/**
 * Controllers for a zone from a preset. Replacing keeps the zone's MIDI learn
 * (number_in) on controllers that address the same CC / NRPN.
 */
export function controllersFromPreset(
  preset: DevicePreset,
  current: CCController[],
  append: boolean
): CCController[] {
  const learned = new Map<string, number>();
  if (!append) {
    for (const c of current) {
      if (c.number_in != null && c.type != CCControllerType.SPACER) learned.set(address(c), c.number_in);
    }
  }
  const copies = preset.controllers.map((c) => ({
    ...JSON.parse(JSON.stringify(c)),
    number_in: learned.get(address(c)) ?? null
  }));
  return append ? [...current, ...copies] : copies;
}

function presetJSON(meta: DevicePresetMeta, controllers: CCController[]): string {
  const cleanMeta = sanitizeMeta(meta);
  if (!cleanMeta) throw new Error('A preset needs a name');
  return JSON.stringify(
    {
      format: PRESET_FORMAT,
      version: 1,
      ...cleanMeta,
      // MIDI learn belongs to the zone, not to the device
      controllers: controllers
        .map(sanitizeController)
        .filter((c) => c != null)
        .map(({ number_in, ...c }: any) => c)
    },
    null,
    2
  );
}

function writePreset(meta: DevicePresetMeta, controllers: CCController[], overwriteId: string | null): Promise<string> {
  return ipcRenderer.invoke('presets-save', presetJSON(meta, controllers), overwriteId, `${meta.device} ${meta.name}`);
}

/**
 * Writes the controllers as a preset: a new user preset, or overwriting `overwriteId`.
 * Returns the saved preset after reloading the list.
 */
export async function saveDevicePreset(
  meta: DevicePresetMeta,
  controllers: CCController[],
  overwriteId: string | null
): Promise<DevicePreset | undefined> {
  const id = await writePreset(meta, controllers, overwriteId);
  await loadDevicePresets();
  return findDevicePreset(id);
}

export async function deleteDevicePreset(id: string): Promise<void> {
  await ipcRenderer.invoke('presets-delete', id);
  await loadDevicePresets();
}

/** Lets the user pick preset files; valid ones become new user presets */
export async function importDevicePresets(): Promise<{ imported: number; skipped: string[] }> {
  const files: { name: string; json: string }[] = await ipcRenderer.invoke('presets-import');
  const skipped: string[] = [];
  let imported = 0;
  for (const f of files) {
    let preset: DevicePreset | null = null;
    try {
      preset = sanitizePreset(JSON.parse(f.json), '', 'user');
    } catch {
      // reported below
    }
    if (preset) {
      await writePreset(preset, preset.controllers, null);
      imported++;
    } else {
      skipped.push(f.name);
    }
  }
  if (files.length > 0) await loadDevicePresets();
  return { imported, skipped };
}

/** Exports presets as files (one: save dialog, several: into a folder); returns the count written */
export function exportDevicePresets(list: DevicePreset[]): Promise<number> {
  return ipcRenderer.invoke(
    'presets-export',
    list.map((p) => ({ name: `${p.device} ${p.name}`, json: presetJSON(p, p.controllers) }))
  );
}

export function revealDevicePresetFolder(): Promise<void> {
  return ipcRenderer.invoke('presets-reveal');
}
