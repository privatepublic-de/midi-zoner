import DOM, { escapeHTML as esc } from '../modules/domutils';
import { Zone } from '../modules/zone/zone-class';
import { migrateSpacers } from '../modules/zone/cc-layout';
import { MpeMode, sanitizeMpeMode, sanitizeBendRange, sanitizePressureFrom, DEFAULT_PRESSURE_FROM, zoneInputClaims } from '../modules/zone/mpe';
import { Sequence } from '../modules/zone/sequence';
import { DIV_TICKS } from '../modules/zone/seq-layer';
import MIDI, { PortDescriptor, MIDIMessage } from '../modules/midi';
import * as view from '../modules/viewcontroller';
import { ZonesData } from '../modules/viewcontroller/types';
import { ipcRenderer, webFrame } from 'electron';
import { ZoneArrangementJSON, isLayoutEntry } from '../modules/zone/interfaces';
import { UndoHistory } from '../modules/undo-history';
import { labelForZone } from '../modules/viewcontroller/action-labels';
import { updateSheetHistory } from '../modules/viewcontroller/editor-sheet';
import { loadDevicePresets } from '../modules/device-presets';
import { timeline, timelineClock, timelineTransport, timelineSection, timelineLoop, timelineCountIn, timelineMeter, songAt, LoopRange } from '../modules/timeline';
import { Meter, DEFAULT_METER, barTicks, beatIndexAt, beatNumberAt, parseMeter } from '../modules/meter';
import { metronomeSettings, metronomeTick, resetMetronome, initMetronome, updateMetronome, Beat } from '../modules/metronome';
import { initMetronomeControls, updateMetronomePorts, setMetronomeClockExternal, flashBeat } from '../modules/viewcontroller/metronome-controls';

// Type aliases for class types
type ZoneType = Zone;
type MIDIInstance = InstanceType<typeof MIDI>;

const zones: ZonesData = {
  list: [],
  inChannel: 0,
  clockOutputPorts: {},
  clockSuppressTransportPorts: {},
  selectedInputPorts: {},
  tempo: 120,
  sendInternalClockIfPlaying: false, // TODO misnamed; means send everything
  outputConfigNames: {},
  arrangementIndex: 0,
  nextArrangementIndex: 0,
  arrangementQuantIndex: 2,
  toggleQuantOn: true,
  toggleQuantIndex: 2,
  keySwitchEnabled: true,
  mackieOutlineEnabled: true,
  knownPortNames: {}
};

const debounce = function <T extends (...args: any[]) => void>(
  func: T,
  delay: number
): T {
  let timer: ReturnType<typeof setTimeout>;
  return function (this: any, ...args: any[]) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      func.apply(this, args);
    }, delay);
  } as T;
};

const saveZones = debounce(() => {
  localStorage.setItem('zones', JSON.stringify(zones));
}, 500);

const undoHistory = new UndoHistory();
let hardwareLockTimer: ReturnType<typeof setTimeout> | null = null;
// Notes recorded into a sequence: one undo entry per phrase (notes less than a second apart)
let recordTakeTimer: ReturnType<typeof setTimeout> | null = null;

const channelOptions = (function (): string {
  var result = '';
  for (var i = 0; i < 16; i++) {
    result += `<option>Ch ${i + 1}</option>`;
  }
  return result;
})();

function syncZoneInputPorts(midi: MIDIInstance): void {
  const claims = zoneInputClaims(zones.list);
  midi.zoneInputPorts = claims.ports;
  midi.zoneAllChannels = claims.allChannels;
  midi.selectDevices(midi.deviceIdInClock);
  zones.selectedInputPorts = midi.selectedInputPorts;
}

function loadZones(midi: MIDIInstance): void {
  const zonesJson = localStorage.getItem('zones');
  if (zonesJson) {
    applyStoredZones(JSON.parse(zonesJson), midi);
    syncZoneInputPorts(midi);
  }
}

function migrateFromLegacyZone(zoneData: any): ZoneArrangementJSON[] {
  const oldLayers: any[] = zoneData.sequence?.layers || [];
  const baseFields = {
    enabled: zoneData.enabled ?? true,
    solo: zoneData.solo ?? false,
    octave: zoneData.octave ?? 0,
    fixedvel: zoneData.fixedvel ?? false,
    fixedvel_value: zoneData.fixedvel_value ?? 127,
    velocity_scaling: zoneData.velocity_scaling ?? 1,
    mod: zoneData.mod ?? true,
    sustain: zoneData.sustain ?? true,
    cc: zoneData.cc ?? false,
    at2mod: zoneData.at2mod ?? false,
    pitchbend: zoneData.pitchbend ?? true,
    programchange: zoneData.programchange ?? false,
    arp_enabled: zoneData.arp_enabled ?? false,
    arp_hold: zoneData.arp_hold ?? false,
    arp_direction: zoneData.arp_direction ?? 0,
    arp_octaves: zoneData.arp_octaves ?? 0,
    arp_division: zoneData.arp_division ?? 11,
    arp_gatelength: zoneData.arp_gatelength ?? 0.5,
    arp_repeat: zoneData.arp_repeat ?? 0,
    arp_probability: zoneData.arp_probability ?? 1,
    arp_velocity: zoneData.arp_velocity ?? 0,
    arp_transpose: zoneData.arp_transpose ?? false,
    arp_transpose_amount: zoneData.arp_transpose_amount ?? 0,
    arp_pattern: zoneData.arp_pattern ?? [true, true, true, true, true, true, true, true],
    arp_holdlist: zoneData.arp_holdlist ?? [],
    arp_sortedHoldList: zoneData.arp_sortedHoldList ?? [],
    euclid_hits: zoneData.euclid_hits ?? 5,
    euclid_length: zoneData.euclid_length ?? 8,
  };
  // Map each legacy seq layer (A/B/C/D) to the corresponding arrangement
  return [0, 1, 2, 3].map((i) => {
    const layer = oldLayers[i] || oldLayers[0] || {};
    return {
      ...baseFields,
      sequence: {
        active: zoneData.sequence?.active ?? false,
        steps: layer.steps ?? [],
        length: layer.length ?? 16,
        ticks: layer.ticks ?? DIV_TICKS[14],
        division: layer.division ?? 14,
        isDrumSequence: zoneData.sequence?.isDrumSequence ?? false,
        drumLanes: zoneData.sequence?.drumLanes ?? 4,
        drum_lanes: layer.drum_lanes ?? []
      }
    };
  });
}

function createZone(midi: MIDIInstance, zoneData: any): Zone {
  const zone = new Zone(midi);

  zone.channel = zoneData.channel ?? 0;
  // String(): output presets used to store the port id as a number
  zone.preferredOutputPortId = String(zoneData.preferredOutputPortId ?? MIDI.INTERNAL_PORT_ID);
  zone.outputPortId = zone.preferredOutputPortId;
  zone.inputPortId = zoneData.inputPortId ?? null;
  zone.inputChannel = zoneData.inputChannel ?? null;
  zone.mpe = sanitizeMpeMode(zoneData.mpe);
  zone.mpe_bend_in = sanitizeBendRange(zoneData.mpe_bend_in, 48);
  zone.mpe_bend_out = sanitizeBendRange(zoneData.mpe_bend_out, 2);
  zone.mpe_at_from = sanitizePressureFrom(zoneData.mpe_at_from, DEFAULT_PRESSURE_FROM);
  zone.mpe_poly_at = zoneData.mpe_poly_at === true;
  zone.label = zoneData.label ?? '';
  zone.low = zoneData.low ?? 0;
  zone.high = zoneData.high ?? 127;
  zone.show_cc = zoneData.show_cc ?? false;
  zone.pgm_no = zoneData.pgm_no ?? null;
  zone.bank_msb = zoneData.bank_msb ?? null;
  zone.bank_lsb = zoneData.bank_lsb ?? null;
  if (zoneData.cc_controllers) zone.cc_controllers = migrateSpacers(zoneData.cc_controllers);
  if (typeof zoneData.cc_page == 'number') zone.ccPage = Math.max(0, Math.floor(zoneData.cc_page));
  if (typeof zoneData.devicePreset?.id == 'string' && typeof zoneData.devicePreset?.name == 'string') {
    zone.devicePreset = { id: zoneData.devicePreset.id, name: zoneData.devicePreset.name };
  }
  if (zoneData.colorIndex != null) zone.colorIndex = zoneData.colorIndex;

  if (Array.isArray(zoneData.arrangements) && zoneData.arrangements.length > 0) {
    zone.arrangements = [...zoneData.arrangements];
    while (zone.arrangements.length < 4) {
      zone.arrangements.push(JSON.parse(JSON.stringify(zone.arrangements[0])));
    }
  } else {
    zone.arrangements = migrateFromLegacyZone(zoneData);
  }

  zone.loadArrangement(zones.arrangementIndex || 0);
  return zone;
}

function applyStoredZones(
  storedZones: Partial<ZonesData> & { list?: object[] },
  midi: MIDIInstance,
  append?: boolean
): void {
  if (storedZones) {
    if (append) {
      // add storedZones to existing zones, but don't overwrite any settings
      for (let i = 0; i < (storedZones.list?.length ?? 0); i++) {
        zones.list.push(createZone(midi, storedZones.list![i]));
      }
    } else {
      // overwrite existing zones with stored zones
      zones.list.forEach((z) => z.dismiss());
      Object.assign(zones, storedZones);
      if (!zones.tempo || !isFinite(zones.tempo)) zones.tempo = 120;
      // Ensure knownPortNames values are strings (old data may have stored objects)
      if (zones.knownPortNames) {
        for (const key of Object.keys(zones.knownPortNames)) {
          if (typeof zones.knownPortNames[key] !== 'string') {
            delete zones.knownPortNames[key];
          }
        }
      }
      zones.loops = sanitizeLoops(storedZones.loops);
      zones.meters = sanitizeMeters(storedZones.meters);
      // "3/4 bar" became "bar" (of the arrangement's meter)
      if (zones.arrangementQuantIndex === 3) zones.arrangementQuantIndex = 2;
      if (![2, 8, 14].includes(zones.toggleQuantIndex)) zones.toggleQuantIndex = 2;
      zones.toggleQuantOn = zones.toggleQuantOn !== false;
      showToggleQuant();
      zones.list = [];
      for (let i = 0; i < (storedZones.list?.length ?? 0); i++) {
        zones.list.push(createZone(midi, storedZones.list![i]));
      }
    }
    midi.clockOutputPorts = zones.clockOutputPorts;
    midi.suppressTransportPorts = zones.clockSuppressTransportPorts ?? {};
    midi.selectedInputPorts = zones.selectedInputPorts;
  }
}

/**
 * Undo and redo build new zone objects; what the old ones played (the track view's
 * lanes) goes to the same zone: same name, output and channel, otherwise the same
 * place when the number of zones didn't change.
 */
function carryOverNoteHistory(previous: Zone[], current: Zone[]): void {
  const key = (z: Zone): string => `${z.label}\u0000${z.outputPortId}\u0000${z.channel}`;
  const unclaimed = new Set(previous);
  const adopt = (zone: Zone, from: Zone): void => {
    zone.adoptHistory(from);
    unclaimed.delete(from);
  };
  const pending = current.filter((zone) => {
    const matches = previous.filter((p) => key(p) === key(zone));
    if (matches.length !== 1 || !unclaimed.has(matches[0])) return true;
    adopt(zone, matches[0]);
    return false;
  });
  if (previous.length !== current.length) return;
  pending.forEach((zone) => {
    const from = previous[current.indexOf(zone)];
    if (unclaimed.has(from)) adopt(zone, from);
  });
}

/** Loop ranges per arrangement from a scene file (untrusted): whole ticks, at most 1024 bars */
function sanitizeLoops(data: unknown): ZonesData['loops'] {
  if (!Array.isArray(data)) return [];
  return data.slice(0, 4).map((l) => {
    if (!l || typeof l !== 'object') return null;
    const from = Math.round(Number((l as any).from));
    const to = Math.round(Number((l as any).to));
    if (!(from >= 0 && to > from && to <= 96 * 1024)) return null;
    return { on: (l as any).on === true, from, to };
  });
}

/** Meters per arrangement from a scene file (untrusted); null: 4/4 */
function sanitizeMeters(data: unknown): ZonesData['meters'] {
  if (!Array.isArray(data)) return [];
  return data.slice(0, 4).map((m) => parseMeter(m));
}

function activeMeter(index = zones.arrangementIndex): Meter {
  return zones.meters?.[index] ?? DEFAULT_METER;
}

/** The current arrangement's loop range while it's on */
function activeLoop(index = zones.arrangementIndex): LoopRange | null {
  const loop = zones.loops?.[index];
  return loop && loop.on ? { from: loop.from, to: loop.to } : null;
}

function beatOfSong(meter: Meter, song: number): Beat {
  const beat = beatIndexAt(meter, song);
  return beat === 0 ? Beat.ACCENT : beat > 0 ? Beat.BEAT : Beat.NONE;
}

const SIXTEENTH = 6;

/**
 * Whether a pending arrangement switch (or, with `quant` = toggleQuantIndex, a waiting
 * zone toggle) happens at run position p: on the current song's next bar, beat or 16th
 * (Setup → Switching → A–D), in its meter.
 */
function isSwitchPoint(p: number, quant = zones.arrangementQuantIndex): boolean {
  const song = songAt(p - timeline.sectionStart);
  if (quant === 14) return song % SIXTEENTH === 0;
  const beat = beatIndexAt(timeline.meter, song);
  return quant === 8 ? beat >= 0 : beat === 0;
}

const QUANT_NAMES: Record<number, string> = { 2: 'bar', 8: 'beat', 14: '16th' };

/** The Quantize chip (lit while zone toggles wait for the boundary) and its setting */
function showToggleQuant(): void {
  const chip = DOM.get('#toggleQuantChip');
  if (!chip) return;
  chip.classList.toggle('active', zones.toggleQuantOn);
  view.setToggleBoundary(zones.toggleQuantIndex);
  chip.textContent = `Quant ${QUANT_NAMES[zones.toggleQuantIndex]}`;
  (DOM.get('#togglequant') as HTMLSelectElement).value = String(zones.toggleQuantIndex);
}

/**
 * The metronome's beat at run position `p`, a few ticks ahead of `now`: from the song
 * position, so it follows the loop and the meter; a pending arrangement switch starts
 * its song at its switch point. Negative positions are the count-in, which ends at Start.
 */
function metronomeBeatAt(p: number, now: number, running: boolean): Beat {
  if (!running) return beatOfSong(activeMeter(), p);
  if (zones.nextArrangementIndex !== zones.arrangementIndex) {
    for (let at = now + 1; at <= p; at++) {
      if (!isSwitchPoint(at)) continue;
      const next = zones.nextArrangementIndex;
      return beatOfSong(activeMeter(next), p - at);
    }
  }
  return beatOfSong(timeline.meter, songAt(p - timeline.sectionStart));
}

interface Dismissable {
  close: () => void;
  trigger?: string;
}
const dismissables: Dismissable[] = [];

// Closes every registered popup on a click outside of it. Clicks inside a popup
// stop propagating; clicks on its trigger are left to the trigger's own toggle.
function bodyClickHandler(ev: Event): void {
  const target = ev.target as Node;
  dismissables.forEach((d) => {
    if (d.trigger && DOM.get(d.trigger)?.contains(target)) return;
    d.close();
  });
}

// Register once per popup; close() must be safe to call when already closed.
function onBackgroundClick(
  close: () => void,
  filterElement: string | Element,
  trigger?: string
): void {
  DOM.on(filterElement, 'click', (ev) => {
    ev.stopPropagation();
  });
  dismissables.push({ close, trigger });
}

let hideOnLeaveContextMenuTimeout: ReturnType<typeof setTimeout> | null = null;
function resetHideOnLeaveContextMenuTimeout(): void {
  if (hideOnLeaveContextMenuTimeout) {
    clearTimeout(hideOnLeaveContextMenuTimeout);
  }
}

function closeContextMenu(): void {
  resetHideOnLeaveContextMenuTimeout();
  (DOM.get('#contextmenu') as HTMLElement).style.display = 'none';
  DOM.removeClass('*', 'contextMenuTrigger');
}

const MINI_STORAGE_KEY = 'miniView';
const MINI_WIDTH = 420; // CSS px: two zone columns
let miniView = false;
let lastMiniSize = '';

const ZOOM_STEP = 0.1;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.0;
const ZOOM_STORAGE_KEY = 'zoomFactor';
let currentZoomFactor = parseFloat(localStorage.getItem(ZOOM_STORAGE_KEY) || '1');

// Narrowest page layout in CSS px (matches --floor-page in styles.css). The window's minimum width follows it
// scaled by zoom, so a zoomed window can never be narrower than the layout needs.
const PAGE_FLOOR_CSS_PX = 540;

// The mini view has its own zoom; it sets the window's size (width = MINI_WIDTH × zoom)
const MINI_ZOOM_STORAGE_KEY = 'miniZoomFactor';
const MINI_ZOOM_MIN = 0.5;
const MINI_ZOOM_MAX = 1.5;
let miniZoomFactor = parseFloat(localStorage.getItem(MINI_ZOOM_STORAGE_KEY) || '0.8');

/** Zooms the view that is showing: the full view, or the mini view with its own factor. */
function applyZoom(factor: number): void {
  if (miniView) {
    applyMiniZoom(Math.round(factor * 10) / 10);
    return;
  }
  currentZoomFactor = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, Math.round(factor * 10) / 10));
  webFrame.setZoomFactor(currentZoomFactor);
  localStorage.setItem(ZOOM_STORAGE_KEY, String(currentZoomFactor));
  ipcRenderer.invoke('set-min-width', Math.ceil(PAGE_FLOOR_CSS_PX * currentZoomFactor));
}

/** Finer steps than applyZoom: a dragged window width maps to any factor in range. */
function applyMiniZoom(factor: number): void {
  miniZoomFactor = Math.max(MINI_ZOOM_MIN, Math.min(MINI_ZOOM_MAX, Math.round(factor * 100) / 100));
  localStorage.setItem(MINI_ZOOM_STORAGE_KEY, String(miniZoomFactor));
  if (!miniView) return;
  webFrame.setZoomFactor(miniZoomFactor);
  lastMiniSize = '';
  applyMiniSize();
}

applyZoom(currentZoomFactor);

// The user dragged the mini window's edge: its width becomes the zoom, the height follows
ipcRenderer.on('mini-resized', (_event, width: number) => {
  if (!miniView) return;
  applyMiniZoom(width / MINI_WIDTH);
});


/** Places a fixed popup just below the control that opened it, kept inside the window. */
function anchorBelow(popup: HTMLElement, anchor: HTMLElement): void {
  const rect = anchor.getBoundingClientRect();
  popup.style.top = `${Math.round(rect.bottom + 4)}px`;
  popup.style.right = 'auto';
  popup.style.left = `${Math.max(4, Math.min(Math.round(rect.left), window.innerWidth - popup.offsetWidth - 4))}px`;
}

/** Tells the main process to shrink/grow the window to fit the mini grid. */
function applyMiniSize(): void {
  if (!miniView) return;
  const zonesBottom = DOM.get('#zones')!.getBoundingClientRect().bottom;
  const width = MINI_WIDTH * miniZoomFactor;
  const height = (zonesBottom + 8) * miniZoomFactor;
  const size = `${width}x${height}`;
  if (size === lastMiniSize) return;
  lastMiniSize = size;
  ipcRenderer.invoke('set-view-mode', true, width, height);
}

function setMiniView(on: boolean, refresh = true): void {
  miniView = on;
  lastMiniSize = '';
  localStorage.setItem(MINI_STORAGE_KEY, on ? '1' : '0');
  document.body.classList.toggle('minimized', on);
  DOM.get('#miniViewBtn')!.classList.toggle('active', on);
  const miniBtn = DOM.get('#miniViewBtn') as HTMLElement;
  miniBtn.title = `${on ? 'Back to full view' : 'Switch to mini view'} (Cmd/Ctrl+Shift+M)`;
  miniBtn.querySelector('i')!.textContent = on ? 'open_in_full' : 'close_fullscreen';
  if (refresh) view.updateValuesForAllZones();
  // each view keeps its own zoom
  webFrame.setZoomFactor(on ? miniZoomFactor : currentZoomFactor);
  if (on) {
    applyMiniSize();
  } else {
    ipcRenderer.invoke('set-view-mode', false, 0, 0);
    // canvases of hidden elements had no size while minimized
    zones.list.forEach((z) => {
      z.renderNotes();
      z.renderPattern();
    });
  }
}

document.addEventListener('DOMContentLoaded', function () {
  DOM.get('#zoomIn')!.addEventListener('click', () => applyZoom(currentZoomFactor + ZOOM_STEP));
  DOM.get('#zoomOut')!.addEventListener('click', () => applyZoom(currentZoomFactor - ZOOM_STEP));
  DOM.get('#zoomReset')!.addEventListener('click', () => applyZoom(1.0));
  DOM.get('#miniViewBtn')!.addEventListener('click', () => setMiniView(!miniView));
  // Cards or tracks: a choice of the full view, so picking one leaves the mini view
  const showTracks = (on: boolean): void => {
    if (miniView) setMiniView(false);
    view.setTrackView(on);
  };
  DOM.get('#viewCards')!.addEventListener('click', () => showTracks(false));
  DOM.get('#viewTracks')!.addEventListener('click', () => showTracks(true));
  document.addEventListener('keydown', (e) => {
    if (e.code === 'KeyM' && e.shiftKey && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      setMiniView(!miniView);
    }
    if (e.code === 'KeyT' && e.shiftKey && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      showTracks(!view.isTrackView());
    }
    // ⌘+ / ⌘− / ⌘0 zoom the view that is showing (by key, so "+" works on any layout)
    if ((e.metaKey || e.ctrlKey) && !e.altKey) {
      const zoom = miniView ? miniZoomFactor : currentZoomFactor;
      if (e.key === '+' || e.key === '=') applyZoom(zoom + ZOOM_STEP);
      else if (e.key === '-') applyZoom(zoom - ZOOM_STEP);
      else if (e.key === '0') applyZoom(1.0);
      else return;
      e.preventDefault();
    }
  });
  new ResizeObserver(applyMiniSize).observe(DOM.get('#zones')!);
  if (localStorage.getItem(MINI_STORAGE_KEY) === '1') setMiniView(true, false); // zones aren't loaded yet
  const contextMenuElement = DOM.get('#contextmenu') as HTMLElement;
  DOM.on(document, 'click', bodyClickHandler);
  const select_in_clock = DOM.get('#midiClockInDeviceId') as HTMLSelectElement;
  const select_mackie = DOM.get('#mackieControlDeviceId') as HTMLSelectElement;
  const select_mackie_out = DOM.get('#mackieControlOutputDeviceId') as HTMLSelectElement;
  const startClockButton = DOM.get('#startClockButton') as HTMLElement;
  const bpmInput = DOM.get('#bpm') as HTMLInputElement;
  document.getElementById('zones')!.addEventListener('mousedown', (e) => {
    if (!midi.deviceIdMackieControl && !midi.deviceIdMackieOutput) return;
    const zoneEl = (e.target as Element).closest('#zones > .zone[id^="zone"]') as HTMLElement | null;
    if (!zoneEl) return;
    const zoneIndex = parseInt(zoneEl.id.replace('zone', ''));
    if (isNaN(zoneIndex) || zoneIndex === mackieSelectedZone) return;
    mackieSelectedZone = zoneIndex;
    sendMackieLeds();
  });
  const optionNoDevice = '<option value="">(No devices available)</option>';
  /**
   * Input summary on the setup toggle, so a closed drawer still shows what is set.
   * The clock source shows in the transport instead: BPM for internal, the port name for external.
   */
  let inputSummary = '';
  function updateSetupSummary(): void {
    const el = document.getElementById('setupSummary');
    if (el) el.textContent = inputSummary || 'No input';
    const extBadge = document.querySelector('.transport .ext-badge');
    if (extBadge && midi.deviceIdInClock != MIDI.INTERNAL_PORT_ID) {
      extBadge.textContent = select_in_clock.selectedOptions[0]?.text || 'External clock';
    }
  }
  /** Start from any internal transport control: with Count-in on, the clock counts in first */
  function startTransport(): void {
    timelineMeter(activeMeter());
    const ticks = metronomeSettings.countIn ? metronomeSettings.countInBars * barTicks(activeMeter()) : 0;
    resetMetronome();
    midi.startClock(ticks);
    if (midi.isCountingIn) showCountIn(-ticks);
  }
  let countingIn = false;
  /** The Start button counts the beats of the count-in (null: not counting in) */
  function showCountIn(pos: number | null): void {
    countingIn = pos !== null;
    startClockButton.classList.toggle('counting', countingIn);
    if (pos === null) return startClockButton.removeAttribute('data-count');
    startClockButton.setAttribute('data-count', String(beatNumberAt(activeMeter(), pos) + 1));
  }
  function updateBpmInput(): void {
    updateSetupSummary();
    setMetronomeClockExternal(midi.deviceIdInClock != MIDI.INTERNAL_PORT_ID);
    if (midi.deviceIdInClock == MIDI.INTERNAL_PORT_ID) {
      DOM.addClass('.clocksettings', 'isInternal');
      DOM.removeClass('.clocksettings', 'isExternal');
      bpmInput.setAttribute('type', 'number');
      if (document.activeElement !== bpmInput) bpmInput.value = String(zones.tempo);
      bpmInput.disabled = false;
    } else {
      DOM.removeClass('.clocksettings', 'isInternal');
      DOM.addClass('.clocksettings', 'isExternal');
      showCountIn(null);
      bpmInput.setAttribute('type', 'text');
      bpmInput.value = midi.detectedBpm !== null ? midi.detectedBpm.toFixed(1) : '---';
      bpmInput.disabled = true;
    }
  }
  function updateClockOutputCount(): void {
    let count = 0;
    for (const [portid, enabled] of Object.entries(midi.clockOutputPorts)) {
      let present = false;
      midi.outputPortsRegistered.forEach((p: PortDescriptor) => {
        if (p.id === portid) {
          present = true;
        }
      });
      if (enabled && present) {
        count++;
      }
    }
    (DOM.get('#clockOutPortsCount') as HTMLElement).textContent =
      count === 0 ? 'None' : count === 1 ? '1 port' : `${count} ports`;
  }

  function updateInputDisplay(inputs: PortDescriptor[]): void {
    let displayString = '';
    const count = inputs.reduce((selcount, inp) => {
      if (
        midi.selectedInputPorts[inp.id] &&
        midi.selectedInputPorts[inp.id].isSelected
      ) {
        return selcount + 1;
      } else {
        return selcount;
      }
    }, 0);
    inputs.forEach((inp) => {
      if (
        midi.selectedInputPorts[inp.id] &&
        midi.selectedInputPorts[inp.id].isSelected
      ) {
        if (displayString.length > 0) {
          displayString += ', ';
        }
        displayString +=
          count < 3
            ? esc(inp.fullName)
            : esc(inp.name.slice(0, 10).trim()) + (inp.name.length > 10 ? '…' : '');
      }
    });
    if (count == 0) {
      displayString = 'None';
    }
    inputSummary = count == 0 ? '' : displayString;
    (DOM.get('#midiInputSelector') as HTMLElement).innerHTML = displayString;
    updateSetupSummary();
  }

  function updateInputSelection(inputs: PortDescriptor[]): void {
    const listContainer = DOM.get(
      '#inputPortWindow #inputPortList'
    ) as HTMLElement;
    DOM.empty(listContainer);
    if (!inputs) {
      return;
    }
    inputs.forEach((inport) => {
      const isSelected =
        midi.selectedInputPorts[inport.id] &&
        midi.selectedInputPorts[inport.id].isSelected;
      DOM.addHTML(
        listContainer,
        'beforeend',
        `<div class="clockOutOption ${
          isSelected ? 'selected' : ''
        }" data-portid="${
          esc(inport.id)
        }"><span class="material-icons sel">check_box</span
        ><span class="material-icons unsel">check_box_outline_blank</span>
        <span>${esc(inport.fullName)}</span>
        <span class="chsel"><select tabindex="-1">${channelOptions}</select></span>
        </div>`
      );
      (
        DOM.get(
          `#inputPortList .clockOutOption[data-portid="${inport.id}"] select`
        ) as HTMLSelectElement
      ).selectedIndex = (midi.selectedInputPorts[inport.id] || {}).ch || 0;
    });
    DOM.all('#inputPortWindow #inputPortList .clockOutOption').forEach(
      (option) => {
        const portid = option.getAttribute('data-portid')!;
        const channelSelector = DOM.get(
          `#inputPortList .clockOutOption[data-portid="${portid}"] select`
        ) as HTMLSelectElement;
        option.addEventListener('click', (e) => {
          const state = !(
            midi.selectedInputPorts[portid] &&
            midi.selectedInputPorts[portid].isSelected
          );
          DOM.switchClass(option, state, 'selected');
          midi.selectInputPort(portid, channelSelector.selectedIndex, state);
          zones.selectedInputPorts = midi.selectedInputPorts;
          midi.selectDevices(midi.deviceIdInClock);
          saveZones();
          updateInputDisplay(inputs);
        });
        DOM.attachInside(option, 'select', 'click', (ev) => {
          ev.stopPropagation();
        });
        DOM.attachInside(option, 'select', 'change', (ev: Event) => {
          midi.selectInputPort(portid, channelSelector.selectedIndex, true);
          zones.selectedInputPorts = midi.selectedInputPorts;
          saveZones();
        });
      }
    );
    updateInputDisplay(inputs);
  }

  function updateClockReceivers(outputs: PortDescriptor[]): void {
    const clockOutListContainer = DOM.get(
      '#clockOutPortWindow #clockOutPortList'
    ) as HTMLElement;
    DOM.empty(clockOutListContainer);
    if (!outputs) {
      return;
    }
    outputs.forEach((outport) => {
      const isSelected = midi.clockOutputPorts[outport.id] === true;
      const isSuppressed = midi.suppressTransportPorts[outport.id] === true;
      DOM.addHTML(
        clockOutListContainer,
        'beforeend',
        `<div class="clockOutOption ${
          isSelected ? 'selected' : ''
        }" data-portid="${
          esc(outport.id)
        }"><span class="material-icons sel">check_box</span
        ><span class="material-icons unsel">check_box_outline_blank</span>
        <span class="outname">${esc(outport.fullName)}</span
        ><span class="clockSuppressBtn material-icons${isSuppressed ? ' active' : ''}" data-portid="${esc(outport.id)}" title="Free-running clock: send only ticks, no start/stop (keeps delay/reverb synced while transport is stopped)">sync_lock</span>
        </div>`
      );
    });
    DOM.all('#clockOutPortWindow #clockOutPortList .clockOutOption').forEach(
      (option) => {
        option.addEventListener('click', (e) => {
          const portid = option.getAttribute('data-portid')!;
          const state = !(midi.clockOutputPorts[portid] === true);
          DOM.switchClass(option, state, 'selected');
          midi.updateClockOutputReceiver(portid, state);
          view.updateValuesForAllZones();
          zones.clockOutputPorts = midi.clockOutputPorts;
          saveZones();
          updateClockOutputCount();
        });
      }
    );
    DOM.all('#clockOutPortWindow #clockOutPortList .clockSuppressBtn').forEach(
      (btn) => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          const portid = btn.getAttribute('data-portid')!;
          if (!(midi.clockOutputPorts[portid] === true)) return;
          const state = !(midi.suppressTransportPorts[portid] === true);
          midi.updateClockSuppressTransport(portid, state);
          DOM.switchClass(btn, state, 'active');
          zones.clockSuppressTransportPorts = midi.suppressTransportPorts;
          saveZones();
        });
      }
    );
    updateClockOutputCount();
    DOM.all('#clockOutPortWindow input[name="sendinternal"]').forEach((el) => {
      const inputEl = el as HTMLInputElement;
      if (
        inputEl.id == 'sendinternalplaying' &&
        zones.sendInternalClockIfPlaying
      ) {
        inputEl.checked = true;
      }
      if (
        inputEl.id == 'sendinternalalways' &&
        !zones.sendInternalClockIfPlaying
      ) {
        inputEl.checked = true;
      }
    });
    midi.sendClockIfPlaying = zones.sendInternalClockIfPlaying;
  }
  let allPorts: { inputs: PortDescriptor[]; outputs: PortDescriptor[] } = { inputs: [], outputs: [] };

  /** Port ids that must stay selectable because something references them */
  function portsInUse(): { in: Set<string>; out: Set<string> } {
    const inUse = { in: new Set<string>(), out: new Set<string>() };
    zones.list.forEach((z) => {
      inUse.out.add(z.outputPortId);
      inUse.out.add(z.preferredOutputPortId);
      if (z.inputPortId) inUse.in.add(z.inputPortId);
    });
    Object.values(midi.selectedInputPorts).forEach((d) => {
      if (d.isSelected) inUse.in.add(d.id);
    });
    for (const [id, on] of Object.entries(midi.clockOutputPorts)) {
      if (on) inUse.out.add(id);
    }
    if (midi.deviceIdInClock) inUse.in.add(midi.deviceIdInClock);
    const clockChoice = chosenClockSource();
    if (clockChoice !== MIDI.INTERNAL_PORT_ID) inUse.in.add(clockChoice);
    if (midi.deviceIdMackieControl) inUse.in.add(midi.deviceIdMackieControl);
    if (midi.deviceIdMackieOutput) inUse.out.add(midi.deviceIdMackieOutput);
    if (metronomeSettings.midiPortId) inUse.out.add(metronomeSettings.midiPortId);
    return inUse;
  }

  /**
   * Re-link references to ports whose id changed (CoreMIDI may assign new ids
   * after a reboot) by matching the remembered port name. Only remaps when the
   * old id is absent and exactly one present port carries that name.
   * Returns the names of remapped ports.
   */
  function remapChangedPortIds(inputs: PortDescriptor[], outputs: PortDescriptor[]): string[] {
    const remapped = new Set<string>();
    const cache = { in: new Map<string, string | null>(), out: new Map<string, string | null>() };
    const resolve = (id: string | null | undefined, dir: 'in' | 'out'): string | null => {
      if (!id || id === MIDI.INTERNAL_PORT_ID) return null;
      const ports = dir === 'in' ? inputs : outputs;
      if (ports.some((p) => p.id === id)) return null;
      if (cache[dir].has(id)) return cache[dir].get(id)!;
      const name = zones.knownPortNames[id];
      let newId: string | null = null;
      if (typeof name === 'string' && name) {
        const matches = ports.filter((p) => p.fullName === name || p.name === name);
        if (matches.length === 1) {
          newId = matches[0].id;
          remapped.add(name);
          console.log(`app: port "${name}" changed id ${id} → ${newId}`);
        }
      }
      cache[dir].set(id, newId);
      return newId;
    };

    zones.list.forEach((z) => {
      const out = resolve(z.preferredOutputPortId, 'out');
      if (out) {
        z.preferredOutputPortId = out;
        if (z.outputPortId !== MIDI.INTERNAL_PORT_ID) z.outputPortId = out;
      }
      const inp = resolve(z.inputPortId, 'in');
      if (inp) z.inputPortId = inp;
    });

    for (const key of Object.keys(zones.outputConfigNames || {})) {
      const [portId, ch] = key.split(',');
      const out = resolve(portId, 'out');
      if (out && zones.outputConfigNames[`${out},${ch}`] == null) {
        zones.outputConfigNames[`${out},${ch}`] = zones.outputConfigNames[key];
        delete zones.outputConfigNames[key];
      }
    }

    for (const id of Object.keys(midi.clockOutputPorts)) {
      const out = resolve(id, 'out');
      if (out) {
        midi.clockOutputPorts[out] = midi.clockOutputPorts[out] || midi.clockOutputPorts[id];
        delete midi.clockOutputPorts[id];
      }
    }
    zones.clockOutputPorts = midi.clockOutputPorts;

    for (const [id, def] of Object.entries(midi.selectedInputPorts)) {
      const inp = resolve(id, 'in');
      if (inp && !midi.selectedInputPorts[inp]) {
        midi.selectedInputPorts[inp] = { ...def, id: inp };
        delete midi.selectedInputPorts[id];
      }
    }
    zones.selectedInputPorts = midi.selectedInputPorts;

    const clockIn = resolve(localStorage.getItem('midiInClockId'), 'in');
    if (clockIn) {
      localStorage.setItem('midiInClockId', clockIn);
      // standing in with the internal clock: followClockSource() switches back
      if (midi.deviceIdInClock !== MIDI.INTERNAL_PORT_ID) midi.selectDevices(clockIn);
    }
    const mackieIn = resolve(localStorage.getItem('mackieControlPortId'), 'in');
    if (mackieIn) localStorage.setItem('mackieControlPortId', mackieIn);
    const mackieOut = resolve(localStorage.getItem('mackieControlOutputPortId'), 'out');
    if (mackieOut) localStorage.setItem('mackieControlOutputPortId', mackieOut);
    const metronomeOut = resolve(metronomeSettings.midiPortId, 'out');
    if (metronomeOut) updateMetronome({ midiPortId: metronomeOut });

    if (remapped.size > 0) syncZoneInputPorts(midi);
    return [...remapped];
  }

  function visiblePorts(ports: PortDescriptor[], dir: 'in' | 'out'): PortDescriptor[] {
    const used = portsInUse()[dir];
    return ports.filter((p) => !midi.isPortHidden(p) || used.has(p.id));
  }

  /** Rebuild every port list after a visibility change (no toast, no program changes) */
  function refreshPortLists(): void {
    const inputs = visiblePorts(allPorts.inputs, 'in');
    const outputs = visiblePorts(allPorts.outputs, 'out');
    rebuildPortSelectors(inputs, outputs);
    midi.selectDevices(midi.deviceIdInClock);
    midi.updateUsedPorts(view.updateOutputPortsForAllZone(outputs));
    view.updateInputPortsForAllZones(inputs);
    updateClockReceivers(outputs);
    updateInputSelection(inputs);
    renderPortVisibilityList();
  }

  function renderPortVisibilityList(): void {
    const container = DOM.get('#portVisibilityList') as HTMLElement;
    DOM.empty(container);
    const used = portsInUse();
    const groups: [string, PortDescriptor[], 'in' | 'out'][] = [
      ['Inputs', allPorts.inputs, 'in'],
      ['Outputs', allPorts.outputs, 'out']
    ];
    groups.forEach(([title, ports, dir]) => {
      DOM.addHTML(container, 'beforeend', `<p class="portGroupTitle">${title}</p>`);
      ports.forEach((port) => {
        const hidden = midi.isPortHidden(port);
        const locked = used[dir].has(port.id);
        DOM.addHTML(
          container,
          'beforeend',
          `<div class="clockOutOption portVis${hidden ? ' hiddenPort' : ''}${locked ? ' locked' : ''}" data-portid="${esc(port.id)}" data-dir="${dir}"
            title="${locked ? 'In use – cannot be hidden' : hidden ? 'Show this port' : 'Hide this port'}">
            <span>${esc(port.fullName)}</span>
            <span class="material-icons">${hidden ? 'visibility_off' : 'visibility'}</span>
          </div>`
        );
      });
    });
    DOM.all('#portVisibilityList .portVis').forEach((row) => {
      row.addEventListener('click', () => {
        const id = row.getAttribute('data-portid')!;
        const dir = row.getAttribute('data-dir') as 'in' | 'out';
        if (portsInUse()[dir].has(id)) return;
        const port = (dir === 'in' ? allPorts.inputs : allPorts.outputs).find((p) => p.id === id);
        if (!port) return;
        midi.setPortHidden(port, !midi.isPortHidden(port));
        refreshPortLists();
      });
    });
  }

  /** The clock source chosen in the selector (per machine); it stays chosen while its port is missing */
  function chosenClockSource(): string {
    return localStorage.getItem('midiInClockId') || MIDI.INTERNAL_PORT_ID;
  }
  /** The chosen clock port came back while the internal clock was playing: it takes over at Stop */
  let clockReturnPending = false;
  /**
   * The internal clock stands in while the chosen clock port is missing, and the
   * port takes over again when it reconnects (at once when stopped, else at Stop).
   * Returns a line for the ports toast, or ''.
   */
  function followClockSource(): string {
    const chosen = chosenClockSource();
    const current = midi.deviceIdInClock;
    const present = (id: string | null): boolean => !!id && midi.knownPorts[id] != null;
    const nameOf = (id: string): string =>
      midi.knownPorts[id]?.name || zones.knownPortNames[id] || 'clock source';
    clockReturnPending = false;
    if (current !== MIDI.INTERNAL_PORT_ID && !present(current)) {
      console.log('app: Clock in port', current, 'not available. Internal clock until it is back.');
      midi.selectDevices(MIDI.INTERNAL_PORT_ID);
      return chosen !== MIDI.INTERNAL_PORT_ID
        ? `Clock: ${esc(nameOf(chosen))} missing, internal clock until it's back`
        : '';
    }
    if (chosen === MIDI.INTERNAL_PORT_ID || chosen === current || !present(chosen)) return '';
    if (current === MIDI.INTERNAL_PORT_ID && midi.isClockRunning) {
      clockReturnPending = true;
      return `Clock: ${esc(nameOf(chosen))} is back, takes over at Stop`;
    }
    midi.selectDevices(chosen);
    return `Clock: back to ${esc(nameOf(chosen))}`;
  }

  function rebuildPortSelectors(inputs: PortDescriptor[], outputs: PortDescriptor[]): void {
    // rebuild clock source selector
    DOM.empty(select_in_clock);
    DOM.addHTML(
      select_in_clock,
      'beforeend',
      /*html*/ `<option value="*">midi-zoner internal</option>`
    );
    inputs.forEach((input) => {
      DOM.addHTML(
        select_in_clock,
        'beforeend',
        `<option value="${esc(input.id)}" ${
          input.id === midi.deviceIdInClock ? 'selected' : ''
        }>${esc(input.name)}</option>`
      );
    });
    // a chosen clock port that is missing stays listed (and shown), so picking internal forgets it
    const chosenClock = chosenClockSource();
    if (chosenClock !== MIDI.INTERNAL_PORT_ID && !inputs.some((p) => p.id === chosenClock)) {
      const name = zones.knownPortNames[chosenClock] || 'Clock source';
      DOM.addHTML(
        select_in_clock,
        'beforeend',
        `<option value="${esc(chosenClock)}" selected>⚠ ${esc(name)} (missing, internal clock)</option>`
      );
    } else if (inputs.length === 0) {
      DOM.addHTML(select_in_clock, 'beforeend', optionNoDevice);
    }
    updateSetupSummary();
    // rebuild Mackie Control selector
    const savedMackieId = localStorage.getItem('mackieControlPortId') ?? '';
    DOM.empty(select_mackie);
    DOM.addHTML(select_mackie, 'beforeend', '<option value="">(None)</option>');
    inputs.forEach((input) => {
      DOM.addHTML(
        select_mackie,
        'beforeend',
        `<option value="${esc(input.id)}" ${input.id === savedMackieId ? 'selected' : ''}>${esc(input.name)}</option>`
      );
    });
    midi.deviceIdMackieControl = savedMackieId || null;
    // rebuild Mackie Output selector
    const savedMackieOutId = localStorage.getItem('mackieControlOutputPortId') ?? '';
    DOM.empty(select_mackie_out);
    DOM.addHTML(select_mackie_out, 'beforeend', '<option value="">(None)</option>');
    outputs.forEach((output) => {
      DOM.addHTML(
        select_mackie_out,
        'beforeend',
        `<option value="${esc(output.id)}" ${output.id === savedMackieOutId ? 'selected' : ''}>${esc(output.name)}</option>`
      );
    });
    midi.deviceIdMackieOutput = savedMackieOutId || null;
    updateMetronomePorts(outputs);
  }

  let activeUpdateTimer: ReturnType<typeof setTimeout> | null = null;
  let portsFirstUpdateDone = false;
  let initialized = false;
  let mackieSelectedZone: number | null = null;
  let sendMackieLeds: () => void = () => {};
  const midi = new MIDI({
    eventHandler: (event: MIDIMessage) => {
      const data = event.data;
      if (!data) return;
      if (midi.deviceIdInClock == MIDI.INTERNAL_PORT_ID) {
        // handle start/stop messages with internal clock active
        if (
          data[0] == MIDI.MESSAGE.SYSTEM_EXCLUSIVE &&
          data[1] == MIDI.MESSAGE.SYSTEM_EXCLUSIVE_REAL_TIME &&
          data[3] == 6
        ) {
          if (data[4] == 2) {
            // MMC PLAY
            if (!midi.isClockRunning) startTransport();
          } else if (data[4] == 1) {
            // MMC STOP
            midi.stopClock();
          }
        } else if (data[0] == MIDI.MESSAGE.START) {
          if (!midi.isClockRunning) startTransport();
          else midi.startClock();
        } else if (data[0] == MIDI.MESSAGE.CONTINUE) {
          midi.startClock();
        } else if (data[0] == MIDI.MESSAGE.STOP) {
          midi.stopClock();
        }
      }

      let msgtype = data[0] & 0xf0;
      const sourcePortId = event.target
        ? (event.target as MIDIInput).id
        : MIDI.INTERNAL_PORT_ID;
      const isMackiePort = !!(midi.deviceIdMackieControl && sourcePortId === midi.deviceIdMackieControl);
      if (
        !isMackiePort &&
        zones.keySwitchEnabled &&
        msgtype === MIDI.MESSAGE.NOTE_ON &&
        data[1] < 20 &&
        data[2] > 0
      ) {
        // handle key switches
        if (data[1] < 8) {
          // toggle mute
          view.toggleZoneMute(data[1]);
        } else if (data[1] < 16) {
          // toggle sequencer
          view.toggleSequencerOnZone(data[1] - 8);
        } else {
          // select arrangement A/B/C/D (notes 16-19)
          view.selectArrangement(data[1] - 16);
        }
        // do nothing else
        return;
      }
      if (msgtype === MIDI.MESSAGE.NOTE_ON && data[2] === 0) {
        msgtype = MIDI.MESSAGE.NOTE_OFF;
      }
      const sourceChannel = data[0] & 0x0f;
      if (isMackiePort) {
        if (
          (data[0] & 0xf0) === MIDI.MESSAGE.NOTE_ON &&
          (data[0] & 0x0f) === 0 &&
          data[2] > 0
        ) {
          const note = data[1];
          // Transport (internal clock only)
          if (midi.deviceIdInClock === MIDI.INTERNAL_PORT_ID) {
            if (note === 94 && !midi.isClockRunning && !midi.isCountingIn) {
              startTransport();
            } else if (note === 93 && (midi.isClockRunning || midi.isCountingIn)) {
              midi.stopClock();
            }
          }
          // Channel strip (zones 0–7)
          const zoneIndex = note % 8;
          if (note < 32 && zoneIndex < zones.list.length) {
            const zone = zones.list[zoneIndex];
            if (note < 8) {
              view.toggleSequencerOnZone(zoneIndex); // Rec arm → seq enable
            } else if (note < 16) {
              view.toggleZoneSolo(zoneIndex);
            } else if (note < 24) {
              view.toggleZoneMute(zoneIndex);
            } else {
              mackieSelectedZone = zoneIndex;
            }
          }
          // F1–F4 → arrangements A–D
          if (note >= 54 && note <= 57) {
            view.selectArrangement(note - 54);
          }
          sendMackieLeds();
        }
        // Jog encoder → BPM (internal clock only)
        if (
          (data[0] & 0xf0) === MIDI.MESSAGE.CONTROLLER &&
          data[1] === 60 &&
          midi.deviceIdInClock === MIDI.INTERNAL_PORT_ID
        ) {
          const raw = data[2];
          const cw = raw < 64;
          const speed = cw ? raw : raw - 64;
          const step = speed <= 3 ? 1 : speed <= 10 ? 2 : 5;
          zones.tempo = Math.min(240, Math.max(30, zones.tempo + (cw ? step : -step)));
          midi.setInternalBPM(zones.tempo);
          bpmInput.value = String(zones.tempo);
          saveZones();
        }
        return;
      }
      zones.list.forEach((zone, index) => {
        // An MPE zone takes every channel of its input: the In channel is its master channel
        const mpe = zone.mpe !== MpeMode.OFF;
        if (zone.inputPortId !== null) {
          if (zone.inputPortId !== sourcePortId) return;
          if (!mpe && zone.inputChannel !== null && zone.inputChannel !== sourceChannel) return;
          zone.mpeMaster = zone.inputChannel ?? 0;
        } else if (midi.zoneInputPorts.has(sourcePortId) || midi.zoneAllChannels) {
          const portDef = midi.selectedInputPorts[sourcePortId];
          if (!portDef?.isSelected) return;
          if (!mpe && !portDef.allChannels && portDef.ch !== sourceChannel) return;
          zone.mpeMaster = portDef.allChannels ? 0 : portDef.ch;
        }
        if (
          msgtype === MIDI.MESSAGE.CONTROLLER &&
          zone.sequence.hasSelection &&
          zone.cc_controllers.some((c) => c.number_in == data[1] && !isLayoutEntry(c.type))
        ) {
          // Hardware knobs may write parameter locks: one undo entry per burst of turning
          if (hardwareLockTimer === null) {
            undoHistory.startGesture(JSON.stringify(zones), labelForZone(zone, index, 'Parameter Lock'));
          } else {
            clearTimeout(hardwareLockTimer);
          }
          hardwareLockTimer = setTimeout(() => {
            hardwareLockTimer = null;
            undoHistory.endGesture(JSON.stringify(zones));
          }, 700);
        }
        const recording = zone.sequence.isLiveRecording || zone.sequence.isHotRecordingNotes;
        if (recording && msgtype === MIDI.MESSAGE.NOTE_ON && data[2] > 0) {
          if (recordTakeTimer === null) {
            const label = zone.sequence.isLiveRecording ? 'Live Recording' : 'Record Notes';
            undoHistory.startGesture(JSON.stringify(zones), labelForZone(zone, index, label));
          } else {
            clearTimeout(recordTakeTimer);
          }
          recordTakeTimer = setTimeout(() => {
            recordTakeTimer = null;
            undoHistory.endGesture(JSON.stringify(zones));
          }, 1000);
        }
        const resultMessage = zone.handleMidi(msgtype, data);
        // Notes recorded into the sequence (live or into the selected step) change the
        // scene without an action, so save here (debounced) or they'd be lost on quit
        if (recording && (msgtype === MIDI.MESSAGE.NOTE_ON || msgtype === MIDI.MESSAGE.NOTE_OFF)) {
          saveZones();
        }
        if (resultMessage == 'lockCC') {
          requestAnimationFrame(() => view.updateValuesForZone(index));
          saveZones();
        } else if (resultMessage && /^(updateCC|midiLearn)/.test(resultMessage)) {
          const colonPos = resultMessage.indexOf(':');
          const isLearn = resultMessage.startsWith('midiLearn');
          // A learned mapping changes the editor's list too, not just one knob
          const onlyIndex = colonPos > -1 && !isLearn ? parseInt(resultMessage.slice(colonPos + 1)) : undefined;
          requestAnimationFrame(() => {
            view.updateControllerValues(zone, index, onlyIndex);
            if (isLearn) {
              const ccInInput = document.querySelector('#ccEditor .cce-in') as HTMLInputElement;
              if (ccInInput) {
                ccInInput.classList.add('midi-learn-flash');
                setTimeout(() => ccInInput.classList.remove('midi-learn-flash'), 300);
              }
            }
          });
        } else if (resultMessage == 'updateDrumLaneNote') {
          requestAnimationFrame(() => {
            view.updateValuesForZone(index);
            // Flash the input to show MIDI learn was successful
            const input = document.querySelector(`#zone${index} input.midi-learn-active`) as HTMLInputElement;
            if (input) {
              input.classList.add('midi-learn-flash');
              setTimeout(() => input.classList.remove('midi-learn-flash'), 300);
            }
          });
        }
      });
    },
    clockHandler: (pos: number, tickIntervalMs: number, atMs: number) => {
      timelineLoop(activeLoop());
      timelineMeter(activeMeter());
      timelineClock(pos, tickIntervalMs);
      if (zones.nextArrangementIndex !== zones.arrangementIndex) {
        if (isSwitchPoint(pos)) {
          const newIndex = zones.nextArrangementIndex;
          view.switchZonesToArrangement(newIndex);
          // after the outgoing section's takes ended (in stopped(), in its meter), before
          // this tick plays; the new arrangement's song starts at bar 1 or its loop's start
          timelineLoop(activeLoop());
          timelineMeter(activeMeter());
          timelineSection(pos);
          view.selectArrangement(newIndex);
          sendMackieLeds();
          saveZones();
        }
      }
      // waiting mutes and Seq/Arp switches land on this tick (after a switch: in the new arrangement)
      if (view.hasPendingToggles() && isSwitchPoint(pos, zones.toggleQuantIndex)) {
        view.applyPendingToggles();
        sendMackieLeds();
      }
      for (let i = 0; i < zones.list.length; i++) {
        zones.list[i].clock(pos, tickIntervalMs);
      }
      metronomeTick(pos, atMs, tickIntervalMs, (p) => metronomeBeatAt(p, pos, true), () => metronomeSettings.click);
    },
    transportHandler: (started: boolean) => {
      timelineMeter(activeMeter());
      timelineTransport(started);
      // after a count-in the first beats are already scheduled
      if (!countingIn) resetMetronome();
      showCountIn(null);
      if (started) {
        zones.list.forEach((z) => z.started());
        startClockButton.classList.add('selected');
        DOM.addClass(document.body, 'running');
        document.querySelectorAll('.zone.lanes-expanded').forEach((el) => {
          el.classList.remove('lanes-expanded');
        });
      } else {
        startClockButton.classList.remove('selected');
        DOM.removeClass(document.body, 'running');
        zones.list.forEach((z) => {
          z.stopped(true);
        });
        // nothing to wait for any more
        view.applyPendingToggles();
        if (clockReturnPending) {
          const clockMsg = followClockSource();
          refreshPortLists();
          updateBpmInput();
          if (clockMsg) view.toast(clockMsg);
        }
      }
      sendMackieLeds();
    },
    clockPausedHandler: () => {
      zones.list.forEach((z) => z.paused());
    },
    panicHandler: () => {
      zones.list.forEach((z) => z.panic());
      console.log('app: distributed panic to all zones');
      setTimeout(() => {
        view.toast(
          'Sent "notes off" and CC 120, 121, 123 to all channels and used ports!'
        );
      }, 1);
    },
    portsChangedHandler: (available: boolean, allInputs: PortDescriptor[], allOutputs: PortDescriptor[], msg?: string) => {
      if (!initialized) {
        initialized = true;
        if (available) {
          console.log('app: MIDI available');
          DOM.get('#midiPanic')!.addEventListener('click', () => {
            midi.panic();
          });
          loadZones(midi);
          view.renderZones();
        function updateUndoRedoButtons(): void {
          const undoBtn = DOM.get('#undoBtn') as HTMLButtonElement | null;
          const redoBtn = DOM.get('#redoBtn') as HTMLButtonElement | null;
          if (undoBtn) {
            undoBtn.disabled = !undoHistory.canUndo;
            undoBtn.title = undoHistory.undoLabel ? `Undo ${undoHistory.undoLabel} (⌘Z)` : 'Undo (⌘Z)';
          }
          if (redoBtn) {
            redoBtn.disabled = !undoHistory.canRedo;
            redoBtn.title = undoHistory.redoLabel ? `Redo ${undoHistory.redoLabel} (⇧⌘Z)` : 'Redo (⇧⌘Z)';
          }
          updateSheetHistory(undoHistory);
        }

        function applyUndoRedoSnapshot(snapshot: string): void {
          const previous = zones.list.slice();
          applyStoredZones(JSON.parse(snapshot), midi);
          carryOverNoteHistory(previous, zones.list);
          syncZoneInputPorts(midi);
          view.renderZones();
          view.selectArrangement(zones.arrangementIndex);
          updateBpmInput();
          midi.setInternalBPM(zones.tempo);
          saveZones();
          updateUndoRedoButtons();
          sendMackieLeds();
        }

        // A focused field holds an open gesture (typing); blurring commits it as its own
        // entry first, otherwise ending it after the undo would clear the redo stack.
        function commitFocusedField(): void {
          const active = document.activeElement as HTMLElement | null;
          if (!active?.matches('input, select, textarea')) return;
          active.blur();
          // A panel (controller editor) keeps the keyboard, so Esc etc. still reach it
          active.closest<HTMLElement>('[role="dialog"][tabindex]')?.focus();
        }
        DOM.get('#undoBtn')!.addEventListener('click', () => {
          commitFocusedField();
          const snapshot = undoHistory.undo(JSON.stringify(zones));
          if (snapshot) applyUndoRedoSnapshot(snapshot);
        });
        DOM.get('#redoBtn')!.addEventListener('click', () => {
          commitFocusedField();
          const snapshot = undoHistory.redo(JSON.stringify(zones));
          if (snapshot) applyUndoRedoSnapshot(snapshot);
        });
        // ⌘Z / ⇧⌘Z everywhere, also in the editor panels (they let these keys through).
        // The field commits first: typing may be the only undo entry, the button still disabled.
        document.addEventListener('keydown', (ev) => {
          if (!(ev.metaKey || ev.ctrlKey) || ev.code !== 'KeyZ' || ev.altKey) return;
          ev.preventDefault();
          commitFocusedField();
          (DOM.get(ev.shiftKey ? '#redoBtn' : '#undoBtn') as HTMLElement).click();
        });

        undoHistory.onChange = updateUndoRedoButtons;
        updateUndoRedoButtons();

        function createNewZone(): void {
          undoHistory.push(JSON.stringify(zones), 'Add Zone');
          let colorIndex = 0;
          if (zones.list.length > 0) {
            colorIndex = zones.list[zones.list.length - 1].colorIndex + 1;
          }
          const newZone = new Zone(midi, colorIndex);
          if (zones.list.length > 0) {
            newZone.preferredOutputPortId = newZone.outputPortId =
              zones.list[zones.list.length - 1].outputPortId;
          }
          zones.list.push(newZone);
          saveZones();
          view.renderLastZone();
          DOM.get(`#zone${zones.list.length - 1}`)!.scrollIntoView();
        }
        window.addEventListener('resize', () => {
          requestAnimationFrame(view.renderMarkersForAllZones);
        });
        // The "+ Add zone" link is re-rendered with the zones, so listen on the list
        DOM.get('#zones')!.addEventListener('click', (ev) => {
          if ((ev.target as HTMLElement).closest('.addnewzone a')) createNewZone();
        });
        DOM.get('#deleteallzones')!.addEventListener('click', async () => {
          await ipcRenderer
            .invoke(
              'open-confirm',
              'Delete all zones',
              'Delete all zones in this scene?'
            )
            .then((result: boolean) => {
              if (result == true) {
                view.deleteAllZones();
              }
            });
        });
        let colorOffset = 0;
        DOM.get('#shuffleColors')!.addEventListener('click', () => {
          colorOffset++;
          zones.list.forEach((zone: ZoneType, index: number) => {
            zone.randomizeColor(colorOffset + index);
          });
          view.updateValuesForAllZones();
          saveZones();
        });
        startClockButton.addEventListener('click', () => {
          // transportHandler updates the button, zones and Mackie LEDs
          if (midi.deviceIdInClock === MIDI.INTERNAL_PORT_ID) {
            if (midi.isClockRunning || midi.isCountingIn) {
              midi.stopClock();
            } else {
              startTransport();
            }
          }
        });
        let bpmDebounceTimer: ReturnType<typeof setTimeout> | null = null;
        const commitBpmGesture = (): void => {
          if (bpmDebounceTimer) { clearTimeout(bpmDebounceTimer); bpmDebounceTimer = null; }
          const currentJSON = JSON.stringify(zones);
          undoHistory.endGesture(currentJSON);
          if (document.activeElement === bpmInput) undoHistory.startGesture(currentJSON, 'Tempo (BPM)');
        };
        bpmInput.addEventListener('focus', () => {
          bpmInput.select();
          undoHistory.startGesture(JSON.stringify(zones), 'Tempo (BPM)');
        });
        bpmInput.addEventListener('input', (e) => {
          const parsed = parseInt((e.target as HTMLInputElement).value);
          if (isNaN(parsed)) return;
          const bpm = Math.min(Math.max(parsed, 30), 240);
          zones.tempo = bpm;
          midi.setInternalBPM(bpm);
          saveZones();
          if (bpmDebounceTimer) clearTimeout(bpmDebounceTimer);
          bpmDebounceTimer = setTimeout(commitBpmGesture, 1000);
        });
        bpmInput.addEventListener('blur', () => {
          commitBpmGesture();
        });
        updateBpmInput();
        midi.bpmDetectedHandler = (bpm: number | null) => {
          if (midi.deviceIdInClock !== MIDI.INTERNAL_PORT_ID) {
            bpmInput.value = bpm !== null ? bpm.toFixed(1) : '';
            bpmInput.classList.toggle('hasClock', bpm !== null);
          }
        };
        updateClockOutputCount();
        midi.setInternalBPM(zones.tempo);
        view.selectArrangement(zones.arrangementIndex || 0);
        (DOM.get('#seqquant') as HTMLSelectElement).value = String(
          zones.arrangementQuantIndex ?? 2
        );
        showToggleQuant();
        (DOM.get('#keySwitchEnabled') as HTMLInputElement).checked =
          zones.keySwitchEnabled !== false;
        (DOM.get('#mackieOutlineEnabled') as HTMLInputElement).checked =
          zones.mackieOutlineEnabled !== false;
        document.body.addEventListener('keydown', (ev) => {
          if ((document.activeElement as HTMLElement).tagName != 'INPUT') {
            if (ev.key == ' ') {
              ev.preventDefault();
            }
          }
        });
        document.body.addEventListener('keydown', (ev) => {
          if (ev.metaKey || ev.ctrlKey || ev.altKey) return; // ⌘Z, ⌘C… aren't Z / C
          if ((document.activeElement as HTMLElement).tagName != 'INPUT') {
            if (ev.code == 'Space') {
              startClockButton.click();
            }
            if (ev.code.indexOf('Digit') == 0) {
              const numIndex = '1234567890'.indexOf(ev.code.charAt(5));
              if (numIndex > -1 && !ev.shiftKey) {
                view.toggleZoneMute(numIndex);
              } else if (numIndex > -1 && ev.shiftKey) {
                view.toggleSequencerOnZone(numIndex);
              }
            } else if (ev.code.indexOf('Key') == 0) {
              const letterIndex = 'QWERTYUIOP'.indexOf(ev.code.charAt(3));
              if (letterIndex > -1) {
                view.toggleSequencerOnZone(letterIndex);
              } else {
                const arrIndex = 'ZXCV'.indexOf(ev.code.charAt(3));
                if (arrIndex > -1) {
                  view.selectArrangement(arrIndex);
                }
              }
            }
          }
        });
        DOM.get('#save')!.addEventListener('click', async (e) => {
          await ipcRenderer
            .invoke('open-save', JSON.stringify(zones))
            .then(
              (result: {
                canceled: boolean;
                message: string;
                warning?: boolean;
              }) => {
                if (!result.canceled) {
                  view.toast(result.message, { warning: result.warning });
                }
              }
            );
        });
        DOM.get('#load')!.addEventListener('click', async (e) => {
          await ipcRenderer
            .invoke('open-load')
            .then((result: string | null) => {
              if (result) {
                try {
                  undoHistory.push(JSON.stringify(zones), 'Load Scene File');
                  applyStoredZones(JSON.parse(result), midi, true);
                  syncZoneInputPorts(midi);
                  view.renderZones();
                  saveZones();
                  updateUndoRedoButtons();
                  zones.list.forEach((zone) => zone.sendProgramChange());
                } catch (ex) {
                  console.log('app: Error loading file', ex);
                  view.toast(
                    'Error loading file! The selected file is possibly no midi-zoner scene...',
                    { warning: true }
                  );
                }
              }
            });
        });
        sendMackieLeds = (): void => {
          zones.list.forEach((_, i) => {
            const el = DOM.get(`#zone${i}`);
            if (el) DOM.switchClass(el, zones.mackieOutlineEnabled !== false && i === mackieSelectedZone, 'mackie-selected');
          });
          for (let i = 0; i < 8; i++) {
            const zone = zones.list[i];
            const active = i < zones.list.length;
            midi.sendMackie(i,      active && zone.sequence.active ? 127 : 0);
            midi.sendMackie(i + 8,  active && zone.solo ? 127 : 0);
            midi.sendMackie(i + 16, active && !zone.enabled ? 127 : 0);
            midi.sendMackie(i + 24, i === mackieSelectedZone ? 127 : 0);
          }
          for (let a = 0; a < 4; a++) {
            midi.sendMackie(54 + a, zones.arrangementIndex === a ? 127 : 0);
          }
          midi.sendMackie(94, midi.isClockRunning ? 127 : 0);
          midi.sendMackie(93, midi.isClockRunning ? 0 : 127);
        };
        view.setStateChangeCallback(sendMackieLeds);
        } else {
          console.log('app:', msg);
        }
      }
      // port update — debounced to coalesce rapid statechange events
      if (activeUpdateTimer) clearTimeout(activeUpdateTimer);
      activeUpdateTimer = setTimeout(() => {
        if (!available) return;
        console.log('app: MIDI port update');
        allPorts = { inputs: allInputs, outputs: allOutputs };
        const remappedPorts = remapChangedPortIds(allInputs, allOutputs);
        if (remappedPorts.length > 0) {
          msg = (msg ?? '') + remappedPorts
            .map((n) => `<div class="toast-row on"><span class="toast-name">${esc(n)}</span><span class="toast-meta">reconnected</span></div>`)
            .join('');
        }
        const clockMsg = followClockSource();
        if (clockMsg) msg = `${msg ?? ''}<div class="toast-note">${clockMsg}</div>`;
        const inputs = visiblePorts(allInputs, 'in');
        const outputs = visiblePorts(allOutputs, 'out');
        rebuildPortSelectors(inputs, outputs);
        midi.selectDevices(midi.deviceIdInClock);
        if (!portsFirstUpdateDone && midi.deviceIdMackieControl && zones.list.length > 0) {
          mackieSelectedZone = 0;
        }
        sendMackieLeds();
        // remember port names so missing devices can be labelled
        allOutputs.forEach((p) => { zones.knownPortNames[p.id] = p.fullName; });
        allInputs.forEach((p) => { zones.knownPortNames[p.id] = p.fullName; });
        saveZones();
        // update zone port selectors and send program changes for reconnected ports
        const prevPortIds = zones.list.map((z) => z.outputPortId);
        midi.updateUsedPorts(view.updateOutputPortsForAllZone(outputs));
        view.updateInputPortsForAllZones(inputs);
        zones.list.forEach((zone, i) => {
          if (
            zone.pgm_no != null &&
            zone.preferredOutputPortId !== MIDI.INTERNAL_PORT_ID &&
            zone.outputPortId === zone.preferredOutputPortId &&
            (prevPortIds[i] !== zone.outputPortId || !portsFirstUpdateDone)
          ) {
            zone.sendProgramChange();
          }
        });
        portsFirstUpdateDone = true;
        updateBpmInput();
        updateClockReceivers(outputs);
        updateInputSelection(inputs);
        renderPortVisibilityList();
        DOM.addClass(document.body, 'updated');
        setTimeout(() => {
          DOM.removeClass(document.body, 'updated');
        }, 1000);
        // only when a device came, went or was reconnected, not on every re-scan
        if (msg) view.toast(`<div class="toast-title">MIDI devices</div>${msg}`);
      }, 100);
    }
  });
  select_in_clock.addEventListener('change', () => {
    const inClockId = (
      DOM.find(select_in_clock, 'option:checked')[0] as HTMLOptionElement
    ).value;
    localStorage.setItem('midiInClockId', inClockId);
    clockReturnPending = false;
    midi.selectDevices(inClockId);
    updateBpmInput();
    refreshPortLists();
  });
  select_mackie.addEventListener('change', () => {
    const portId = (select_mackie.querySelector('option:checked') as HTMLOptionElement).value;
    midi.deviceIdMackieControl = portId || null;
    midi.selectDevices(midi.deviceIdInClock);
    localStorage.setItem('mackieControlPortId', portId);
    if (!portId) {
      mackieSelectedZone = null;
    }
    sendMackieLeds();
  });
  select_mackie_out.addEventListener('change', () => {
    const portId = (select_mackie_out.querySelector('option:checked') as HTMLOptionElement).value;
    midi.deviceIdMackieOutput = portId || null;
    localStorage.setItem('mackieControlOutputPortId', portId);
    sendMackieLeds();
  });
  DOM.get('#clockSendButton')!.addEventListener('click', (e) => {
    const clockoutcontainer = DOM.get('#clockOutPortWindow') as HTMLElement;
    const isVisible = clockoutcontainer.style.display == 'block';
    clockoutcontainer.style.display = isVisible ? 'none' : 'block';
    if (!isVisible) anchorBelow(clockoutcontainer, e.currentTarget as HTMLElement);
  });
  DOM.get('#midiInputSelector')!.addEventListener('click', (ev) => {
    const container = DOM.get('#inputPortWindow') as HTMLElement;
    const isVisible = container.style.display == 'block';
    container.style.display = isVisible ? 'none' : 'block';
    if (!isVisible) anchorBelow(container, ev.currentTarget as HTMLElement);
  });
  onBackgroundClick(() => {
    (DOM.get('#clockOutPortWindow') as HTMLElement).style.display = 'none';
  }, '#clockOutPortWindow', '#clockSendButton');
  onBackgroundClick(() => {
    (DOM.get('#inputPortWindow') as HTMLElement).style.display = 'none';
  }, '#inputPortWindow', '#midiInputSelector');
  DOM.on('#clockOutPortWindow input[name="sendinternal"]', 'change', () => {
    midi.sendClockIfPlaying = zones.sendInternalClockIfPlaying =
      (
        document.querySelector(
          'input[name="sendinternal"]:checked'
        ) as HTMLInputElement
      ).value == '1';
    saveZones();
  });
  DOM.on('*[data-select-arrangement]', 'click', (ev) => {
    const el = ev.target as HTMLElement;
    const selectedArr = parseInt(el.dataset.selectArrangement!);
    view.selectArrangement(selectedArr);
  });
  DOM.on('*[data-select-arrangement][data-contextmenu]', 'contextmenu', (ev) => {
    view.showContextMenuFor(ev as MouseEvent);
  });
  DOM.on('#seqquant', 'change', (ev) => {
    const quantDiv = parseInt((ev.target as HTMLSelectElement).value);
    zones.arrangementQuantIndex = quantDiv;
    saveZones();
  });
  DOM.on('#togglequant', 'change', (ev) => {
    zones.toggleQuantIndex = parseInt((ev.target as HTMLSelectElement).value);
    showToggleQuant();
    saveZones();
  });
  DOM.on('#toggleQuantChip', 'click', () => {
    zones.toggleQuantOn = !zones.toggleQuantOn;
    showToggleQuant();
    saveZones();
  });
  DOM.on('#aboutBtn', 'click', () => ipcRenderer.invoke('open-about'));
  const SETUP_OPEN_KEY = 'setupDrawerOpen';
  function setSetupOpen(open: boolean): void {
    document.body.classList.toggle('setup-open', open);
    DOM.get('#setupToggle')!.setAttribute('aria-expanded', String(open));
    localStorage.setItem(SETUP_OPEN_KEY, open ? '1' : '0');
  }
  setSetupOpen(localStorage.getItem(SETUP_OPEN_KEY) === '1');
  DOM.get('#setupToggle')!.addEventListener('click', () =>
    setSetupOpen(!document.body.classList.contains('setup-open'))
  );
  // The external clock name in the transport leads to where the clock source is chosen
  DOM.on('.transport .ext-badge', 'click', () => setSetupOpen(true));
  // Keep the zones below the top bar, including the drawer when it is open (and when it wraps to two rows).
  const topBar = DOM.get('#midisettings') as HTMLElement;
  const setupDrawer = DOM.get('#setupDrawer') as HTMLElement;
  const syncTopBarHeight = (): void => {
    const drawerOpen = document.body.classList.contains('setup-open');
    const bottom = Math.max(
      topBar.getBoundingClientRect().bottom,
      drawerOpen ? setupDrawer.getBoundingClientRect().bottom : 0
    );
    document.documentElement.style.setProperty('--topbar-h', `${Math.ceil(bottom)}px`);
  };
  new ResizeObserver(syncTopBarHeight).observe(topBar);
  new ResizeObserver(syncTopBarHeight).observe(setupDrawer);
  syncTopBarHeight();
  DOM.on('#keySwitchEnabled', 'change', (ev) => {
    zones.keySwitchEnabled = (ev.target as HTMLInputElement).checked;
    saveZones();
  });
  const foldSoloedOutBox = DOM.get('#foldSoloedOut') as HTMLInputElement;
  foldSoloedOutBox.checked = view.isFoldSoloedOut();
  foldSoloedOutBox.addEventListener('change', () => view.setFoldSoloedOut(foldSoloedOutBox.checked));
  DOM.on('#mackieOutlineEnabled', 'change', (ev) => {
    zones.mackieOutlineEnabled = (ev.target as HTMLInputElement).checked;
    saveZones();
    sendMackieLeds();
  });
  view.initController({ saveData: saveZones, data: zones, midi, history: undoHistory });
  initMetronome(
    (msg, portId, timestamp) => midi.send(msg, portId, timestamp),
    flashBeat,
    (reason) => view.toast(`The click's audio output isn't available (${esc(reason)}); it plays on the system output`, { warning: true })
  );
  initMetronomeControls();
  midi.countInHandler = (pos, tickIntervalMs, atMs) => {
    timelineCountIn(pos, tickIntervalMs);
    if (pos === null) {
      resetMetronome();
      showCountIn(null);
      return;
    }
    showCountIn(pos);
    // the count-in always clicks; from Start on only with Click
    metronomeTick(pos, atMs, tickIntervalMs, (p) => metronomeBeatAt(p, pos, false), (p) => p < 0 || metronomeSettings.click);
  };
  loadDevicePresets()
    .then((broken) => {
      if (broken.length > 0) {
        view.toast(`Skipped unreadable device presets: ${broken.map(esc).join(', ')}`, { warning: true });
      }
    })
    .catch((e) => console.log(e));

  contextMenuElement.addEventListener('mouseleave', function () {
    hideOnLeaveContextMenuTimeout = setTimeout(() => {
      closeContextMenu();
    }, 1333);
  });
  contextMenuElement.addEventListener('mousemove', function () {
    resetHideOnLeaveContextMenuTimeout();
  });
  window.addEventListener('closeContextMenu', closeContextMenu);
  window.addEventListener(
    'resetHideOnLeaveContextMenuTimeout',
    resetHideOnLeaveContextMenuTimeout
  );
  onBackgroundClick(() => {
    if (contextMenuElement.style.display !== 'none') closeContextMenu();
  }, '#contextmenu');
});
