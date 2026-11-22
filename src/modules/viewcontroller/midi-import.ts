import { ipcRenderer } from 'electron';
import { escapeHTML } from '../domutils';
import { Note } from '../zone/note';
import { Take } from '../zone/take';
import type { Zone } from '../zone/zone-class';
import { takeStore } from '../take-store';
import { MidiFile, MidiPart, parseMidiFile, partsOf, takeFromPart, partLabel } from '../midi-file';
import { Meter, meterLabel, sameMeter } from '../meter';
import type { UndoPatch } from '../undo-history';
import { toast } from './toast';

/**
 * A zone's ⋯ → Import MIDI file as take…: a track (one channel of it) of a Standard MIDI
 * File becomes the zone's newest take, shown; the current arrangement takes the file's
 * meter and the internal clock its tempo. One undo step.
 */

export interface MidiImportHooks {
  zones: () => Zone[];
  /** "1 Lead: Import Take" */
  label: (zoneindex: number, label: string) => string;
  pushPatch: (label: string, patch: UndoPatch) => void;
  arrangement: () => number;
  meterOf: (arrangement: number) => Meter;
  setMeter: (arrangement: number, meter: Meter) => void;
  /** The internal clock's tempo, null with an external clock (the file's isn't used then) */
  tempo: () => number | null;
  setTempo: (bpm: number) => void;
  /** Track view and cards show the new take */
  refresh: () => void;
}

let hooks: MidiImportHooks | null = null;

export function initMidiImport(h: MidiImportHooks): void {
  hooks = h;
}

export async function importMidiFile(zoneindex: number): Promise<void> {
  const zoneId = hooks?.zones()[zoneindex]?.id;
  if (!hooks || !zoneId) return;
  const picked: { name: string; bytes: Uint8Array } | { error: string } | undefined = await ipcRenderer.invoke('open-midi-file');
  if (!picked) return;
  if ('error' in picked) {
    toast(escapeHTML(picked.error), { warning: true });
    return;
  }
  let file: MidiFile;
  try {
    file = parseMidiFile(picked.bytes);
  } catch (e) {
    toast(`${escapeHTML(picked.name)}: ${escapeHTML((e as Error).message)}`, { warning: true });
    return;
  }
  const parts = partsOf(file);
  if (parts.length === 0) toast(`${escapeHTML(picked.name)} has no notes`, { warning: true });
  else if (parts.length === 1) importPart(zoneId, file, parts[0]);
  else openPartMenu(zoneId, file, parts, picked.name);
}

/** The zone's index now (undo replaces zone objects; the id stays) */
function indexOf(zoneId: string): number {
  return hooks?.zones().findIndex((z) => z.id === zoneId) ?? -1;
}

/** A menu of the file's parts at the zone's ⋯ button; a click imports one */
function openPartMenu(zoneId: string, file: MidiFile, parts: MidiPart[], fileName: string): void {
  const menu = document.getElementById('contextmenu');
  if (!menu) return;
  menu.classList.remove('cc-presets-menu');
  // names come from the file: escaped
  menu.innerHTML =
    `<li class="heading">${escapeHTML(fileName)}: import as a take</li>` +
    parts
      .map((part, i) => `<li data-part="${i}"><i class="material-icons">music_note</i> ${escapeHTML(partLabel(part, Note.display))}</li>`)
      .join('');
  menu.querySelectorAll<HTMLElement>('[data-part]').forEach((li) =>
    li.addEventListener('click', (e) => {
      e.stopPropagation();
      window.dispatchEvent(new CustomEvent('closeContextMenu'));
      const part = parts[Number(li.dataset['part'])];
      if (part) importPart(zoneId, file, part);
    })
  );
  menu.style.display = 'block';
  const anchor = document.querySelector(`#zone${indexOf(zoneId)} .zonemenu`)?.getBoundingClientRect();
  const m = menu.getBoundingClientRect();
  const left = anchor ? anchor.right - m.width : (window.innerWidth - m.width) / 2;
  const top = anchor ? anchor.bottom : (window.innerHeight - m.height) / 2;
  menu.style.left = `${Math.max(0, Math.min(left, window.innerWidth - m.width))}px`;
  menu.style.top = `${Math.max(0, top + m.height > window.innerHeight ? window.innerHeight - m.height : top)}px`;
}

function importPart(zoneId: string, file: MidiFile, part: MidiPart): void {
  const h = hooks;
  const index = indexOf(zoneId);
  if (!h || index < 0) return;
  const result = takeFromPart(file, part);
  const take = Take.from(result.take);
  if (!take || take.notes.length === 0) {
    toast(`${escapeHTML(part.name)} has no notes to import`, { warning: true });
    return;
  }
  take.seq = ++Take.counter;
  // past MAX_TAKES the oldest (not the one playing along) goes: undo brings it back
  const before = takeStore.of(zoneId);
  let evicted: { take: Take; at: number } | null = null;
  const arr = h.arrangement();
  const oldMeter = h.meterOf(arr);
  const oldTempo = h.tempo();
  const newTempo = oldTempo !== null && result.bpm !== null ? Math.min(240, Math.max(30, Math.round(result.bpm))) : oldTempo;
  const apply = (): void => {
    takeStore.add(zoneId, take);
    takeStore.show(zoneId, take);
    h.setMeter(arr, result.meter);
    if (newTempo !== null) h.setTempo(newTempo);
    h.refresh();
  };
  const revert = (): void => {
    takeStore.remove(zoneId, take);
    if (evicted) takeStore.add(zoneId, evicted.take, evicted.at);
    h.setMeter(arr, oldMeter);
    if (oldTempo !== null) h.setTempo(oldTempo);
    h.refresh();
  };
  apply();
  const after = takeStore.of(zoneId);
  const gone = before.findIndex((t) => !after.includes(t));
  if (gone >= 0) evicted = { take: before[gone], at: gone };
  h.pushPatch(h.label(index, 'Import Take'), { undo: revert, redo: apply });

  const zone = h.zones()[index];
  const settings = [
    ...(!sameMeter(oldMeter, result.meter) || !result.meterExact
      ? [`${meterLabel(result.meter)}${result.meterExact ? '' : ' (the file’s meter isn’t supported)'}`]
      : []),
    ...(newTempo !== oldTempo ? [`${newTempo} BPM`] : [])
  ];
  toast(
    `${escapeHTML(zone?.label || `Zone ${index + 1}`)}: imported “${escapeHTML(part.name)}” · ` +
      `${Take.lengthLabel(take.length, result.meter)}` +
      (settings.length ? ` · ${settings.join(', ')}` : '') +
      (result.cut ? ' · cut short: too long for a take' : ''),
    { warning: result.cut }
  );
}
