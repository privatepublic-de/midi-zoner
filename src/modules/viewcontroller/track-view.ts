import { Zone } from '../zone/zone-class';
import { ZONES_CHANGED_EVENT, UPDATE_ZONE_VIEW_EVENT } from '../zone/interfaces';
import type { NoteCurveJSON, CurveSeries } from '../zone/interfaces';
import { CurveCursor } from '../zone/note-curve';
import { timeline, sessionNow, songNow, nowTick, timelineMeter, countInNow, NoteHistory } from '../timeline';
import { Meter, DEFAULT_METER, barTicks, beatLines, snapToBeat, positionLabel, meterLabel, sameMeter } from '../meter';
import { Take } from '../zone/take';
import { loopFromNotes, pickupStart, recutLoop, EARLY, MAX_LOOP_BARS } from '../zone/looper';
import { takeStore } from '../take-store';
import { DIV_TICKS, PPQ } from '../zone/seq-layer';
import { analyse, quantize, quantizeStarts, applyToSequence, swingFor, stepPos, DIV_NAMES, PlayedNote, Quantized } from '../zone/take-quantize';
import { toast } from './toast';
import { pendingOf, toggleBoundary } from './pending-toggles';
import { initTakeEditor, drawTakeEditor, refitTakeEditor, TakeTarget } from './take-editor';

/** The one sentence on how takes come about (lane strip, the notes editor's tab) */
const TAKE_HINT = 'Everything you play from Start to Stop becomes a take';

/**
 * Track view: each zone is a row with its header on the left and a lane that scrolls
 * under a fixed playhead. Behind the playhead the lane shows what the zone sent
 * (Zone.noteHistory), ahead of it the sequence as it will repeat. The selected
 * track's sequencer, arp, controllers and zone settings show in the dock below;
 * they stay in the zone element and are only placed there by CSS (body[data-dock]).
 */

type DockTab = 'seq' | 'arp' | 'cc' | 'zone' | 'notes';

const VIEW_KEY = 'viewMode';
const TAB_KEY = 'trackDockTab';
const DOCK_OPEN_KEY = 'trackDockOpen';
const ZOOM_KEY = 'trackZoom';
const DOCK_HEIGHT_KEY = 'trackDockHeight';
const DOCK_MIN_H = 120;
const ZOOMS = [0.5, 1, 2, 4]; // px per clock tick; at 2 a 1/16 step is 12px, a bar 192px
const PLAYHEAD_AT = 0.3; // share of the lane width behind the playhead
// The cards' mini lanes: a fixed view of a few bars around the playhead
const MINI_PLAYHEAD_AT = 0.22;
const MINI_BARS = 3.5;
const LANE_PAD = 6;
const STRIP_H = 28; // the selected track's strip over its notes, as --strip-h in styles.css
const TAKE_LANE_H = 48; // takes above the song: the shown take, while running the one being recorded
const TAKE_PAD = 4;
const DIM_TEXT = '#8b95a3';
const STOPPED_REDRAW_MS = 500;
// a recording loop's wash
const LOOP_REC = '#e5484d';

let getZones: () => Zone[] = () => [];
let trackView = localStorage.getItem(VIEW_KEY) === 'tracks';
let selected = 0;
// The selected zone's note history: undo hands it to the zone object that replaces
// it (Zone.adoptHistory), so the selection stays with that zone wherever it is now
let selectedHistory: NoteHistory | null = null;
let tab: DockTab = (['seq', 'arp', 'cc', 'zone', 'notes'] as DockTab[]).includes(
  localStorage.getItem(TAB_KEY) as DockTab
)
  ? (localStorage.getItem(TAB_KEY) as DockTab)
  : 'seq';
let dockOpen = localStorage.getItem(DOCK_OPEN_KEY) !== '0';
let zoomIndex = ZOOMS.indexOf(Number(localStorage.getItem(ZOOM_KEY)));
if (zoomIndex < 0) zoomIndex = 2;
let dirty = true;
let frame = 0;
// the shown arrangement's meter
let currentMeter: () => Meter = () => DEFAULT_METER;

/** Bar length in the arrangement's meter */
function barLen(): number {
  return barTicks(timeline.meter);
}

/** The bar a song position is in, from 1 */
function barNumber(t: number): number {
  return Math.floor(t / barLen()) + 1;
}

/**
 * Snap a position in a take: its bars (in the section it was played in), its beats with
 * Alt/Option
 */
function snapInTake(take: Take, t: number, e: { altKey: boolean }, how: 'round' | 'floor' | 'ceil' = 'round'): number {
  if (!e.altKey) return take.barLine(t, how);
  const sec = take.sectionAt(t);
  return sec.t + snapToBeat(sec.meter, t - sec.t, false, how);
}
// Changes to a zone that are undo steps (set by the controller)
let commit: (zoneIndex: number, label: string, change: () => void) => void = (_i, _l, change) => change();
// Changes to a take (not scene data): undo steps of their own
let commitTake: (zoneIndex: number, take: Take, label: string, change: () => void) => void = (_i, _t, _l, change) => change();
// Deleting a take (undo puts it back)
let deleteTake: (zoneIndex: number, take: Take) => void = () => {};
// The last frame's view, to turn a mouse position on a lane into a song position
const view = { head: 0, ppt: 1, scrollPx: 0 };
// Following the playhead, or scrolled through the song: then this song position
// stays where the playhead normally is (a wheel or trackpad scrolls, Follow returns)
let follow = true;
let pinnedAt = 0;
// Bars of the shown take picked (dragged over), positions in the take
let capture: { zone: Zone; from: number; to: number } | null = null;
let captureButton: HTMLElement;
let takeChip: HTMLElement;
let loopChip: HTMLElement;
// each track's loop block as last drawn (lane canvas px): picking it, dragging its edges
const loopBlocks = new WeakMap<Zone, { x0: number; x1: number; top: number; barPx: number }>();
// an edge of the loop being dragged, by whole bars (applied on release)
let loopDrag: { zone: Zone; edge: 'start' | 'end'; bars: number } | null = null;
// "where you are" (styles.css --select): the picked take or loop
let amber = '';
// What the Notes tab edits: the zone's loop or one of its takes (by zone id: undo keeps it)
let editing: { zoneId: string; kind: 'loop' } | { zoneId: string; kind: 'take'; take: Take } | null = null;
// Turning a take (or bars of it) into steps, or quantizing it: the preview, set in the dock panel
let conv: {
  zone: Zone;
  take: Take;
  target: 'steps' | 'take';
  strength: number; // 0.1–1, quantizing the take
  starts: number[]; // the notes' new starts, quantizing the take
  from: number;
  to: number;
  notes: PlayedNote[];
  suggested: number; // the detected grid
  grid: number;
  swing: number; // detected for the grid: places late off-beats, and is offered for the zone
  useSwing: boolean;
  drums: boolean;
  q: Quantized;
} | null = null;
const CONVERT_GRIDS = [5, 8, 10, 11, 12, 13, 14, 15, 16, 17]; // 1/2 … 1/32t
let lastDraw = 0;
// zone colours, read from CSS when something changed rather than every frame
const zoneColours = new WeakMap<Element, string>();

function isActive(): boolean {
  return trackView && !document.body.classList.contains('minimized');
}

function isTrackView(): boolean {
  return trackView;
}

function setTrackView(on: boolean): void {
  trackView = on;
  localStorage.setItem(VIEW_KEY, on ? 'tracks' : 'cards');
  applyBodyState();
  // canvases of blocks hidden in the other view had no size
  getZones().forEach((z) => {
    z.renderNotes();
    z.renderPattern();
  });
}

function applyBodyState(): void {
  const body = document.body;
  body.classList.toggle('track-view', trackView);
  body.classList.toggle('dock-closed', !dockOpen);
  body.dataset['dock'] = tab;
  document.getElementById('viewCards')?.classList.toggle('active', !trackView);
  document.getElementById('viewTracks')?.classList.toggle('active', trackView);
  invalidate();
}

/** The cards (not the mini view) show their mini lanes */
function cardsActive(): boolean {
  return !trackView && !document.body.classList.contains('minimized');
}

/** Something changed: redraw on the next frame (also restarts the loop) */
function invalidate(): void {
  dirty = true;
  if (!frame && (isActive() || cardsActive())) frame = requestAnimationFrame(loop);
}

function loop(now: number): void {
  frame = 0;
  const tracks = isActive();
  if (!tracks && !cardsActive()) return;
  if (timeline.running || timeline.countIn !== null || dirty || now - lastDraw > STOPPED_REDRAW_MS) {
    updateLoopChips();
    if (tracks) draw();
    else drawCards();
    lastDraw = now;
  }
  frame = requestAnimationFrame(loop);
}

/** The Loop chips: "Loop 4", "Rec 2" (recording), "Dub 4" (overdubbing), blinking while they wait */
function updateLoopChips(): void {
  for (const zone of getZones()) {
    const chip = zone.elements.zoneElement?.querySelector('.showloop');
    if (!chip) continue;
    const { label, state } = zone.loopChip;
    if (chip.textContent !== label) chip.textContent = label;
    for (const s of ['wait', 'rec', 'closing']) chip.classList.toggle(`loop-${s}`, s === state);
    const title = loopChipTitle(zone, state);
    if ((chip as HTMLElement).title !== title) (chip as HTMLElement).title = title;
    // the loop's switch beside it: its length, lit while it plays
    const sw = zone.elements.zoneElement?.querySelector('.showloopsw') as HTMLElement | null;
    if (!sw) continue;
    const loop = zone.loop;
    const length = loop ? Take.lengthLabel(loop.length, currentMeter()) : '';
    const swLabel = loop ? `Loop ${length.split(' ')[0]}` : 'Loop';
    if (sw.textContent !== swLabel) sw.textContent = swLabel;
    sw.classList.toggle('loop-none', !loop);
    sw.classList.toggle('loop-on', !!loop && zone.loopOn);
    const swTitle = !loop
      ? 'No loop yet: record one with Rec'
      : zone.loopOn
        ? `Loop (${length}) on: it plays, also on a muted zone. Click: off, kept`
        : `Loop (${length}) off: kept, silent. Click: on`;
    if (sw.title !== swTitle) sw.title = swTitle;
  }
}

/** What the Loop chip does next, in its tooltip */
function loopChipTitle(zone: Zone, state: string): string {
  const mode = zone.looper.mode === 'dub' ? 'Overdubbing' : 'Recording';
  const length = zone.loop ? Take.lengthLabel(zone.loop.length, currentMeter()) : '';
  switch (state) {
    case 'wait':
      return `${mode} starts on the next 1 (press again: cancel)`;
    case 'rec':
      return zone.looper.mode === 'dub'
        ? 'Overdubbing: press on a 1 to end it'
        : `Recording: a press now makes a loop of ${Take.lengthLabel(zone.loopPressLength(), currentMeter())} (it counts for the nearest 1)`;
    case 'closing':
      return `${mode} ends on the next 1 (pressed too late? Press again: it ends at the 1 just passed)`;
    default:
      return zone.loop
        ? `Dub: press on a 1 to overdub the ${length} loop, on a later 1 to end it; twice quickly clears the loop`
        : 'Rec: press on a 1 to record a loop, on a later 1 to close it; it plays at once. A little late is fine: the bar before counts as its pick-up';
  }
}

/** Whether a sequence has notes to show, even while it's off */
function seqHasNotes(seq: Zone['sequence']): boolean {
  const has = (steps: ({ notesArray: unknown[] } | null | undefined)[]): boolean =>
    steps.some((st) => !!st && st.notesArray.length > 0);
  return seq.isDrumSequence
    ? seq.drum_lanes.slice(0, seq.drumLanes).some((l) => !!l && has(l.steps))
    : has(seq.steps.slice(0, seq.length));
}

/**
 * The cards: a mini lane under each header that has something to play (sequence notes,
 * the loop, the arp) or was played into, or an enabled zone's sequencer on (even with
 * an empty sequence), on the same song as the track view
 */
function drawCards(): void {
  const zones = getZones();
  if (dirty) {
    dirty = false;
    zones.forEach((z) => {
      const el = z.elements.zoneElement;
      if (el) zoneColours.set(el, getComputedStyle(el).getPropertyValue('--zone-color').trim());
    });
  }
  timelineMeter(currentMeter());
  const songHead = songNow();
  const runToSong = (timeline.running ? nowTick() : 0) - songHead;
  zones.forEach((z) => {
    const el = z.elements.zoneElement;
    if (!el) return;
    const show =
      (z.enabled && z.sequence.active) ||
      seqHasNotes(z.sequence) ||
      z.arp_enabled ||
      // played into while running: what was played shows behind the playhead
      z.hasRecorded ||
      z.loop !== null ||
      z.looper.mode !== 'idle';
    if (el.classList.contains('has-mini-lane') !== show) el.classList.toggle('has-mini-lane', show);
    const canvas = el.querySelector('.mini-lane canvas') as HTMLCanvasElement | null;
    if (show && canvas) drawLane(z, false, songHead, runToSong, 0, 0, canvas);
    updateCardTakes(z, el);
  });
}

// what each card's takes strip shows, so it's rebuilt only when that changes
const cardTakesKeys = new WeakMap<HTMLElement, string>();

// Discard on a card's strip puts it away until the zone's next take (zone id → its newest
// take's id then; per machine, so a restart doesn't bring it back)
const DISMISSED_KEY = 'dismissedTakes';
const dismissedTakes: Record<string, string> = (() => {
  try {
    const v = JSON.parse(localStorage.getItem(DISMISSED_KEY) || '{}');
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
})();

function dismissCardTakes(zone: Zone): void {
  const takes = takeStore.of(zone.id);
  if (takes.length === 0) return;
  dismissedTakes[zone.id] = takes[takes.length - 1].id;
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(dismissedTakes));
  } catch {
    // (not kept: it shows again after a restart)
  }
  invalidate();
}

/** The card's loop strip: its length, a bar less or more, Clear; the take one click away */
function updateCardLoop(zone: Zone, el: HTMLElement): void {
  const strip = el.querySelector('.card-loop');
  const loop = zone.loop;
  if (!strip || !loop) return;
  const label = `Loop · ${Take.lengthLabel(loop.length, currentMeter())}`;
  const labelEl = strip.querySelector('.cl-label')!;
  if (labelEl.textContent !== label) labelEl.textContent = label;
  const note = zone.looper.lastRun === 'dub' ? 'overdubbed in this run' : 'recorded in this run';
  const noteEl = strip.querySelector('.cl-note')!;
  if (noteEl.textContent !== note) noteEl.textContent = note;
  const bar = barLen();
  strip.querySelector('[data-cl=less]')!.classList.toggle('disabled', loop.length <= bar);
  strip.querySelector('[data-cl=more]')!.classList.toggle('disabled', loop.length + bar > MAX_LOOP_BARS * bar);
}

/** The card's takes strip (stopped, with takes): ‹ Take n/m ›, a preview, Loop n bars */
function updateCardTakes(zone: Zone, el: HTMLElement): void {
  // after a run that recorded or overdubbed the zone's loop: the loop's bars, not the take
  const loopShown = !timeline.running && zone.loop !== null && zone.looper.lastRun !== null;
  if (el.classList.contains('has-card-loop') !== loopShown) el.classList.toggle('has-card-loop', loopShown);
  if (loopShown) updateCardLoop(zone, el);
  const takes = takeStore.of(zone.id);
  const show = !loopShown && !timeline.running && takes.length > 0 && dismissedTakes[zone.id] !== takes[takes.length - 1].id;
  if (el.classList.contains('has-card-takes') !== show) el.classList.toggle('has-card-takes', show);
  const take = show ? takeStore.shownTake(zone.id) : null;
  const strip = el.querySelector('.card-takes') as HTMLElement | null;
  if (!take || !strip) return;
  const index = takes.length - takeStore.shownIndex(zone.id);
  const preview = strip.querySelector('.ct-preview') as HTMLCanvasElement;
  const key = [take.id, takeStore.version, index, takes.length, preview.clientWidth, zoneColours.get(el)].join('|');
  if (cardTakesKeys.get(el) === key) return;
  cardTakesKeys.set(el, key);
  strip.querySelector('.ct-label')!.textContent = `Take ${index}/${takes.length}`;
  strip.querySelector('[data-ct=keep]')!.textContent = keepLabel(take);
  strip.querySelector('[data-ct=prev]')!.classList.toggle('disabled', index <= 1);
  strip.querySelector('[data-ct=next]')!.classList.toggle('disabled', index >= takes.length);
  drawTakePreview(preview, take, 1, zoneColours.get(el) || '#8fa3b8');
}

/** Song position where a waiting toggle lands: the next bar, beat or 16th after `head` */
function landingAt(head: number, quant = toggleBoundary()): number {
  if (quant === 14) return (Math.floor(head / 6) + 1) * 6;
  for (const { t, bar } of beatLines(timeline.meter, head + 0.001, head + 2 * barLen() + 1)) {
    if (t > head && (quant === 8 || bar)) return t;
  }
  return head;
}

function setTab(next: DockTab): void {
  tab = next;
  dockOpen = true;
  localStorage.setItem(TAB_KEY, tab);
  localStorage.setItem(DOCK_OPEN_KEY, '1');
  applyBodyState();
}

function setDockOpen(open: boolean): void {
  dockOpen = open;
  localStorage.setItem(DOCK_OPEN_KEY, open ? '1' : '0');
  applyBodyState();
}

function setDockHeight(px: number | null): void {
  if (px === null) {
    document.body.style.removeProperty('--dock-open-h');
    localStorage.removeItem(DOCK_HEIGHT_KEY);
  } else {
    document.body.style.setProperty('--dock-open-h', `${Math.round(px)}px`);
    localStorage.setItem(DOCK_HEIGHT_KEY, String(Math.round(px)));
  }
  invalidate();
}

/** Drag the dock's top edge; a folded dock opens */
function startDockResize(ev: MouseEvent): void {
  ev.preventDefault();
  const dock = document.getElementById('trackDock')!;
  const startY = ev.clientY;
  // the room the dock takes from the window's bottom (it floats a gap above it)
  const startH = dockOpen ? window.innerHeight - dock.getBoundingClientRect().top : DOCK_MIN_H;
  if (!dockOpen) setDockOpen(true);
  const topbar = document.getElementById('midisettings')!.getBoundingClientRect().bottom;
  const maxH = window.innerHeight - topbar - 120;
  document.body.classList.add('dock-resizing');
  const move = (e: MouseEvent): void => {
    setDockHeight(Math.max(DOCK_MIN_H, Math.min(maxH, startH + startY - e.clientY)));
  };
  const up = (): void => {
    document.body.classList.remove('dock-resizing');
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

function select(index: number): void {
  if (index === selected) return;
  selected = index;
  selectedHistory = getZones()[index]?.noteHistory ?? null;
  invalidate();
}

/** Keep a track selected where it went (zones reordered) */
function followTrack(zone: Zone): void {
  const index = getZones().indexOf(zone);
  if (index >= 0) select(index);
}

function zoneIndexOf(el: Element | null): number {
  const zoneEl = el?.closest('#zones > .zone[id^="zone"]');
  return zoneEl ? parseInt(zoneEl.id.slice(4)) : -1;
}

// ---------------------------------------------------------------------------
// Dock

function updateDock(zones: Zone[]): void {
  const dock = document.getElementById('trackDock')!;
  document.body.classList.toggle('no-tracks', zones.length === 0);
  if (zones.length === 0) return;
  const zone = zones[selected];
  const zoneEl = zone.elements.zoneElement;
  dock.querySelector('.td-name')!.textContent = zone.label || `Zone ${selected + 1}`;
  if (zoneEl) {
    const style = getComputedStyle(zoneEl);
    dock.style.setProperty('--zone-color', style.getPropertyValue('--zone-color'));
    dock.style.setProperty('--zone-surface', style.getPropertyValue('--zone-surface'));
  }
  const off: Partial<Record<DockTab, boolean>> = { seq: !zone.sequence.active, arp: !zone.arp_enabled };
  dock.querySelectorAll('.td-tab').forEach((t) => {
    const name = (t as HTMLElement).dataset['tab'] as DockTab;
    t.classList.toggle('active', dockOpen && name === tab);
    // a feature that is off for this track: the tab is dim (it says so when opened)
    t.classList.toggle('off', !!off[name]);
  });
  // An off feature: say so, with a button that switches it on in the track header
  let empty = '';
  let turnOn = '';
  if (tab === 'seq' && !zone.sequence.active) {
    empty = 'The sequencer of this zone is off.';
    turnOn = 'Turn on';
  } else if (tab === 'arp' && !zone.arp_enabled) {
    empty = 'The arpeggiator of this zone is off.';
    turnOn = 'Turn on';
  } else if (tab === 'notes' && !editedTake()) {
    empty = zone.hasRecorded
      ? 'Click a take or the loop in the lanes to edit its notes here.'
      : `No loop and no takes yet. ${TAKE_HINT}.`;
  }
  // nothing to show: the dock keeps its height and says so in its place
  dock.classList.toggle('empty', empty !== '');
  dock.querySelector('.td-empty-text')!.textContent = empty;
  dock.querySelector('.td-turn-on')!.textContent = turnOn;
}

function turnOnFeature(): void {
  const zoneEl = getZones()[selected]?.elements.zoneElement;
  const chip = zoneEl?.querySelector(tab === 'arp' ? '.channels .showarp' : '.channels .showseq');
  (chip as HTMLElement | null)?.click();
}

// ---------------------------------------------------------------------------
// Drawing

function prepare(canvas: HTMLCanvasElement | null): [CanvasRenderingContext2D, number, number] | null {
  if (!canvas) return null;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return null;
  const dpr = window.devicePixelRatio || 1;
  const cw = Math.round(w * dpr);
  const ch = Math.round(h * dpr);
  if (canvas.width !== cw || canvas.height !== ch) {
    canvas.width = cw;
    canvas.height = ch;
  }
  const g = canvas.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  return [g, w, h];
}

function laneHeight(zone: Zone): number {
  const seq = zone.sequence;
  if (seq.active && seq.isDrumSequence) return Math.max(56, seq.drumLanes * 10 + 2 * LANE_PAD);
  if (seq.active || zone.loop) return 80;
  return 56;
}

/** The track's take lane above the song, once it has takes or one is being recorded */
function hasTakeLane(zone: Zone): boolean {
  return zone.hasRecorded;
}

/** Whether a mouse y on a lane is in its take lane (presses there pick bars) */
function inTakeLane(zone: Zone, lane: Element, clientY: number): boolean {
  if (!hasTakeLane(zone)) return false;
  return clientY < lane.querySelector('canvas')!.getBoundingClientRect().top + TAKE_LANE_H;
}

/** Where the step `cur` of a sequence started; stopped (cur -1), one step before the playhead */
function stepStart(cur: number, ticks: number, head: number): number {
  if (timeline.running && cur >= 0) return Math.floor(Math.max(0, timeline.pos) / ticks) * ticks;
  return head - ticks;
}

/** Follows the notes the arp plays from (held keys, or the hold list with Hold) */
function syncHeld(zone: Zone): NoteHistory {
  const held = zone.heldHistory;
  if (!zone.arp_enabled) {
    held.closeAll();
    return held;
  }
  const source = zone.arp_hold ? zone.arp_holdlist : zone.arp.orderlist;
  const pitches = new Set(source.map((n) => n.number));
  const sounding = new Set(held.notes.filter((n) => n.end === null).map((n) => n.pitch));
  sounding.forEach((p) => {
    if (!pitches.has(p)) held.noteOff(p);
  });
  source.forEach((n) => {
    if (!sounding.has(n.number)) held.noteOn(n.number, n.velo);
  });
  return held;
}

function divisionName(zone: Zone): string {
  const select = zone.elements.zoneElement?.querySelector('.seq_division') as HTMLSelectElement | null;
  return select?.options[zone.sequence.division]?.text ?? '';
}

function draw(): void {
  const zones = getZones();
  const moved = zones.findIndex((z) => z.noteHistory === selectedHistory);
  if (moved >= 0 && moved !== selected) {
    selected = moved;
    dirty = true;
  }
  if (selected >= zones.length) selected = Math.max(0, zones.length - 1);
  selectedHistory = zones[selected]?.noteHistory ?? null;
  zones.forEach((z, i) => z.elements.zoneElement?.classList.toggle('track-selected', i === selected));
  if (conv && (timeline.running || !zones.includes(conv.zone) || !takeStore.of(conv.zone.id).includes(conv.take))) endConvert();
  if (capture && (timeline.running || !zones.includes(capture.zone))) clearCapture();
  const refresh = dirty;
  dirty = false;
  if (refresh) {
    updateDock(zones);
    // the key range strip had no size while hidden
    if (tab === 'zone' && dockOpen) zones[selected]?.renderNotes();
    zones.forEach((z) => {
      const el = z.elements.zoneElement;
      if (el) zoneColours.set(el, getComputedStyle(el).getPropertyValue('--zone-color').trim());
    });
  }
  const ppt = ZOOMS[zoomIndex];
  // The lanes show the current arrangement's song (bar 1 = where it started); the
  // sequencer counts run positions, which are the song's plus the section's start.
  // Stopped, the playhead waits at bar 1, where the shown takes start too.
  timelineMeter(currentMeter());
  const songHead = songNow();
  // the sequencer counts run positions: from Start, which plays the song from songHead
  const runToSong = (timeline.running ? nowTick() : 0) - songHead;
  if (follow) pinnedAt = songHead;
  // counting in: the song (and the playhead waiting at its start) comes in from the right
  const countIn = follow ? countInNow() : null;
  const scrollPx = (songHead - pinnedAt - (countIn ?? 0)) * ppt;
  view.head = songHead;
  view.ppt = ppt;
  view.scrollPx = scrollPx;
  document.querySelector('#trackRuler .tr-follow')?.classList.toggle('active', follow);
  drawRuler(songHead, ppt, scrollPx);
  zones.forEach((z, i) => drawLane(z, i === selected, songHead, runToSong, ppt, scrollPx));
  if (tab === 'notes' && dockOpen && !conv) drawTakeEditor();
  if (!zones[selected]) {
    takeChip.remove();
    loopChip.remove();
  }
  // the editor's tab is named after what it edits
  const zone = zones[selected];
  const kind = zone ? picked(zone) : null;
  const target = kind === 'take' ? editedTake() : null;
  const name = kind === 'take' && target ? target.label.split('/')[0] : 'Loop';
  const notesTab = document.querySelector('#trackDock [data-tab=notes]');
  if (notesTab && notesTab.textContent !== name) notesTab.textContent = name;
}

/** The take the lane shows: the newest, or the one browsed back to; numbered by recording order */
function shownTake(zone: Zone): { take: Take; number: number; count: number } | null {
  const take = takeStore.shownTake(zone.id);
  if (!take) return null;
  const list = takeStore.of(zone.id);
  return { take, number: list.indexOf(take) + 1, count: list.length };
}

/** The bars of a take, by its first section's meter (sections later in the run may differ) */
function takeMeter(take: Take): Meter {
  return take.sectionAt(0).meter;
}

/**
 * What is picked on a track: the loop or a take (amber; the strip's chip and the dock's
 * editor follow it). Unless one was clicked: the loop after a run that recorded or
 * overdubbed it, else (stopped) the shown take, else the loop.
 */
function picked(zone: Zone): 'loop' | 'take' | null {
  if (editing?.zoneId === zone.id) {
    if (editing.kind === 'loop' && zone.loop) return 'loop';
    if (editing.kind === 'take' && takeStore.of(zone.id).includes(editing.take)) return 'take';
  }
  if (timeline.running) return zone.loop ? 'loop' : null;
  // after a run that recorded or overdubbed the loop, that's what to look at
  if (zone.loop && zone.looper.lastRun) return 'loop';
  return takeStore.shownTake(zone.id) ? 'take' : zone.loop ? 'loop' : null;
}

/** Pick a track's loop or its shown take: the dock's editor follows (when the dock is open) */
function pick(zone: Zone, kind: 'loop' | 'take'): void {
  clearCapture();
  const take = takeStore.shownTake(zone.id);
  if (kind === 'take' && take) editing = { zoneId: zone.id, kind: 'take', take };
  else if (kind === 'loop' && zone.loop) editing = { zoneId: zone.id, kind: 'loop' };
  else return;
  select(getZones().indexOf(zone));
  refitTakeEditor();
  if (dockOpen && !conv) setTab('notes');
  invalidate();
}

/** What the Notes tab edits: what is picked on the selected track */
function editedTake(): TakeTarget | null {
  const zone = getZones()[selected];
  if (!zone) return null;
  const loopTarget = (): TakeTarget | null =>
    zone.loop
      ? {
          zone,
          take: zone.loop,
          kind: 'loop',
          label: `Loop in ${'ABCD'[zone.currentArrangementIndex] ?? ''}`,
          meter: timeline.meter,
          playhead: () => {
            const loop = zone.loop;
            if (!loop || !timeline.running) return null;
            const len = loop.length;
            const e = nowTick() - timeline.sectionStart - zone.looper.anchor;
            return e < 0 ? null : ((e % len) + len) % len;
          }
        }
      : null;
  const takeTarget = (take: Take): TakeTarget => {
    const list = takeStore.of(zone.id);
    return {
      zone,
      take,
      kind: 'take',
      label: `Take ${list.indexOf(take) + 1}/${list.length}`,
      meter: takeMeter(take),
      playhead: () => null
    };
  };
  const kind = picked(zone);
  if (kind === 'loop') return loopTarget();
  if (kind !== 'take') return null;
  const take =
    editing?.zoneId === zone.id && editing.kind === 'take' && takeStore.of(zone.id).includes(editing.take)
      ? editing.take
      : takeStore.shownTake(zone.id);
  return take ? takeTarget(take) : null;
}

/** Show a take (null: the loop) in the Notes tab */
function editTake(zone: Zone, take: Take | null): void {
  clearCapture();
  if (take) {
    takeStore.show(zone.id, take);
    editing = { zoneId: zone.id, kind: 'take', take };
  } else {
    editing = { zoneId: zone.id, kind: 'loop' };
  }
  select(getZones().indexOf(zone));
  refitTakeEditor();
  setTab('notes');
}

/** The song's extent: up to the end of the longest shown take, at least where the playhead is */
function songExtent(): number {
  let end = view.head;
  for (const z of getZones()) {
    const shown = takeStore.shownTake(z.id);
    if (shown) end = Math.max(end, shown.end);
  }
  return end;
}

/** Scroll through the song, back to bar 1 or on to its end (Follow returns to the playhead) */
function scrollBy(px: number): void {
  pinnedAt = Math.max(0, Math.min(songExtent(), (follow ? view.head : pinnedAt) + px / view.ppt));
  follow = false;
  invalidate();
}

function drawRuler(songHead: number, ppt: number, scrollPx: number): void {
  const ruler = document.getElementById('trackRuler');
  const pos = ruler?.querySelector('.tr-pos');
  if (pos) {
    const t = Math.max(0, Math.floor(songHead));
    const state = timeline.running ? positionLabel(timeline.meter, t) : timeline.countIn !== null ? 'Count-in' : 'Stopped';
    pos.textContent = sameMeter(timeline.meter, DEFAULT_METER) ? state : `${state} · ${meterLabel(timeline.meter)}`;
  }
  const p = prepare(ruler?.querySelector('canvas') ?? null);
  if (!p) return;
  const [g, w, h] = p;
  const headX = Math.round(w * PLAYHEAD_AT) + scrollPx;
  g.font = '11px "Barlow Semi Condensed", sans-serif';
  // bars apart, so numbers don't touch
  const labelEvery = Math.max(1, Math.ceil(60 / (barLen() * ppt)));
  for (const { t: s, bar } of beatLines(timeline.meter, Math.max(0, songHead - headX / ppt), songHead + (w - headX) / ppt)) {
    const x = Math.round(headX + (s - songHead) * ppt);
    const barNo = Math.round(s / barLen());
    g.fillStyle = s === 0 ? '#e7eaee' : bar ? DIM_TEXT : '#4a525d';
    g.fillRect(x, bar ? h - 14 : h - 6, 1, bar ? 14 : 6);
    // on the playhead mark: just after it
    const labelX = Math.abs(x - headX) > 8 ? x + 4 : headX + 9;
    if (bar && barNo % labelEvery === 0) g.fillText(String(barNo + 1), labelX, h - 5);
  }
  if (headX < -6 || headX > w + 6) return;
  g.fillStyle = '#e7eaee';
  g.beginPath();
  g.moveTo(headX - 5, h - 10);
  g.lineTo(headX + 6, h - 10);
  g.lineTo(headX + 0.5, h - 1);
  g.fill();
}

function drawLane(
  zone: Zone,
  isSelected: boolean,
  songHead: number,
  runToSong: number,
  ppt: number,
  scrollPx: number,
  // a card's mini lane: its own zoom, no take lane, nothing to edit
  mini: HTMLCanvasElement | null = null
): void {
  const el = zone.elements.zoneElement;
  if (!el) return;
  const takeLane = !mini && hasTakeLane(zone);
  if (!mini) {
    const height = `${laneHeight(zone) + (takeLane ? TAKE_LANE_H : 0) + (isSelected ? STRIP_H : 0)}px`;
    if (el.style.getPropertyValue('--track-h') !== height) el.style.setProperty('--track-h', height);
  }
  const p = prepare(mini ?? el.querySelector('.track-lane canvas'));
  if (!p) return;
  const [g, w, fullH] = p;
  if (mini) ppt = w / (MINI_BARS * barLen());
  // takes on top (0 … TAKE_LANE_H), the song below it (songY … fullH, h high)
  const takeY = 0;
  const songY = takeLane ? TAKE_LANE_H : 0;
  const h = fullH - songY;
  // where the playhead is: its place, or elsewhere while scrolled
  const headX = mini ? Math.round(w * MINI_PLAYHEAD_AT) : Math.round(w * PLAYHEAD_AT) + scrollPx;
  const x = (s: number): number => headX + (s - songHead) * ppt; // song positions
  const runHead = songHead + runToSong; // the sequencer's position
  let colour = zoneColours.get(el);
  if (!colour) {
    // a zone element rebuilt without an event (scene load, undo)
    colour = getComputedStyle(el).getPropertyValue('--zone-color').trim() || '#8fa3b8';
    zoneColours.set(el, colour);
    dirty = true;
  }
  const silent = el.classList.contains('disabled') || el.classList.contains('soloed-out');
  const seq = zone.sequence;
  // a mini lane also shows a sequence that's off (dashed: it won't sound)
  const seqShown = seq.active || (!!mini && seqHasNotes(seq));
  const drums = seqShown && seq.isDrumSequence;
  const running = timeline.running;
  // waiting toggles (mini lanes): where they land; a waiting Seq switch flips the sequence there
  const waiting = mini && running ? pendingOf(zone) : [];
  const landAt = waiting.length > 0 ? landingAt(songHead) : Infinity;
  const marks = new Map<number, string[]>();
  if (waiting.length > 0) marks.set(landAt, waiting.map((p) => p.tag));
  const seqFlips = waiting.some((p) => p.action === 'toggle_seq');
  const seqSounds = (s: number): boolean => seq.active !== (seqFlips && s >= landAt);

  // beats and bars of the song
  for (const { t: s, bar } of beatLines(timeline.meter, Math.max(0, songHead - headX / ppt), songHead + (w - headX) / ppt)) {
    const gx = Math.round(x(s));
    g.fillStyle = s === 0 ? '#ffffff40' : bar ? '#ffffff1c' : '#ffffff0a';
    g.fillRect(gx, 0, 1, fullH);
    if (mini && bar) {
      // bar numbers, as there's no ruler above
      g.font = '9px "Barlow Semi Condensed", sans-serif';
      g.fillStyle = DIM_TEXT;
      g.globalAlpha = 0.8;
      g.fillText(String(barNumber(s)), gx + 3, 9);
      g.globalAlpha = 1;
    }
  }
  if (takeLane) {
    // the takes: a shade darker, over a line
    g.fillStyle = '#0000002e';
    g.fillRect(0, takeY, w, TAKE_LANE_H);
    g.fillStyle = '#ffffff14';
    g.fillRect(0, songY - 1, w, 1);
  }


  // what this section sent while running (session positions → song)
  const sectionAt = timeline.runStart + timeline.sectionStart;
  const elapsedNow = running ? nowTick() - timeline.sectionStart : 0;
  const songOf = (session: number): number => session - sectionAt;
  const inPass = (n: { start: number }): boolean => n.start >= sectionAt;
  // the section began this long ago (session positions), at most the view's width back
  const passFrom = sessionNow() - Math.min(elapsedNow, (headX + 8) / ppt);
  const heldHistory = drums ? null : syncHeld(zone);
  // notes played through from the input show only in the take being recorded
  const history = running
    ? zone.noteHistory.between(passFrom, sessionNow() + 1).filter((n) => inPass(n) && !(takeLane && n.live))
    : [];
  const held = running && heldHistory ? heldHistory.between(passFrom, sessionNow() + 1).filter(inPass) : [];
  const shown = shownTake(zone);
  const latest = shown?.take ?? null;
  // the take being recorded (run positions) while running
  // (from the view's left edge on: a long run isn't copied every frame)
  const recording = running && takeLane ? takeStore.recordingOf(zone.id, nowTick(), songHead - headX / ppt + runToSong) : null;

  // pitch rows: drum lanes, or the span of everything the lane can show
  let rowOf: (pitch: number) => number;
  let rows: number;
  if (drums) {
    rows = seq.drumLanes;
    const laneNotes = seq.drum_lanes.slice(0, rows).map((l) => l?.note);
    rowOf = (pitch) => laneNotes.indexOf(pitch);
  } else {
    let lo = 128;
    let hi = -1;
    const take = (p: number): void => {
      if (p < lo) lo = p;
      if (p > hi) hi = p;
    };
    if (seqShown) {
      for (let s = 0; s < seq.length; s++) seq.steps[s]?.notesArray.forEach((n) => take(n.number));
    }
    zone.loop?.notes.forEach((n) => take(n.n));
    if (takeLane) latest?.notes.forEach((n) => take(n.n));
    recording?.forEach((n) => take(n.n));
    // the span of everything played this session, so rows don't jump while scrolling
    for (const span of [zone.noteHistory, heldHistory]) {
      if (span && span.high >= 0) {
        take(span.low);
        take(span.high);
      }
    }
    if (hi < 0) {
      lo = 60;
      hi = 71;
    } else if (hi - lo < 11) {
      lo = Math.max(0, Math.round((lo + hi) / 2) - 6);
      hi = lo + 11;
    }
    rows = hi - lo + 1;
    rowOf = (pitch) => hi - pitch;
  }
  const rowH = (h - 2 * LANE_PAD) / rows;
  const noteH = Math.max(3, Math.min(drums ? 8 : 6, rowH - (drums ? 2 : 0)));
  const rowY = (row: number): number => songY + LANE_PAD + row * rowH + (rowH - noteH) / 2;
  // the take lane's rows: the same pitches, pressed into it
  const takeRowH = (TAKE_LANE_H - 2 * TAKE_PAD) / rows;
  const takeNoteH = Math.max(2, Math.min(4, takeRowH));
  const songRows = { y: rowY, h: noteH };
  const takeRows = {
    y: (row: number): number => takeY + TAKE_PAD + row * takeRowH + (takeRowH - takeNoteH) / 2,
    h: takeNoteH
  };

  // a small label at the lane's top right
  const cornerLabel = (label: string, top: number): void => {
    if (!label) return;
    g.font = '10px "Barlow Semi Condensed", sans-serif';
    const labelW = g.measureText(label).width;
    g.globalAlpha = 0.85;
    g.fillStyle = '#15171a';
    g.fillRect(w - labelW - 10, top + 1, labelW + 8, 13);
    g.fillStyle = DIM_TEXT;
    g.fillText(label, w - labelW - 6, top + 11);
  };

  // with the arp on, the sequence and the loop only feed it: they show as the band of
  // the notes it plays from (as held keys do), what it sends shows behind the playhead
  let feedsArp = false;
  // the loop's notes: a light fill with an edge, so they read apart from the sequence's
  let asLoop = false;
  // where the loop and the sequence begin their next cycle: a tag at the line ("Loop 4 bars", "Seq")
  const lineTags: { x: number; text: string; row: number }[] = [];
  const bandH = Math.max(noteH + 2, Math.min(rowH, noteH + 4));
  const inputBand = (x0: number, x1: number, y: number, ghost: boolean, nh: number): void => {
    const bh = nh === noteH ? bandH : nh + 2;
    const top = y - (bh - nh) / 2;
    g.fillStyle = colour;
    g.strokeStyle = colour;
    if (ghost) {
      g.globalAlpha = 0.35;
      g.setLineDash([2, 2]);
      g.strokeRect(x0 + 0.5, top + 0.5, Math.max(1, x1 - x0 - 1), bh - 1);
      g.setLineDash([]);
      return;
    }
    g.globalAlpha = silent && !mini ? 0.08 : 0.22;
    g.fillRect(x0, top, Math.max(1, x1 - x0 - 1), bh);
  };

  // a note at song positions; ghost: dashed (won't play), faint: a take; curve: its MPE
  const note = (
    s0: number,
    s1: number,
    row: number,
    velo: number,
    ghost: boolean,
    alpha = 1,
    place = songRows,
    curve?: NoteCurveJSON
  ): void => {
    if (row < 0) return;
    const x0 = x(s0);
    const x1 = x(s1);
    if (x1 < 0 || x0 > w) return;
    const y = place.y(row);
    const noteH = place.h;
    const width = Math.max(2, x1 - x0 - 1);
    if (feedsArp && place !== takeRows) {
      inputBand(x0, x1, y, ghost, noteH);
      return;
    }
    // mini lanes draw a silent zone as it is: mute and solo are for the input, its
    // sequence still sounds
    g.globalAlpha = (silent && !mini ? 0.3 : 0.45 + (0.55 * velo) / 127) * alpha;
    if (ghost) {
      // a step that won't play this time (condition, chance, muted lane)
      g.globalAlpha *= 0.6;
      g.strokeStyle = colour;
      g.setLineDash([2, 2]);
      g.strokeRect(x0 + 0.5, y + 0.5, width - 1, noteH - 1);
      g.setLineDash([]);
    } else if (curve?.press) {
      // played with MPE: brighter where the key was pressed harder
      const a = g.globalAlpha;
      g.fillStyle = colour;
      fillByPressure(g, x0, y, width, noteH, s1 - s0, curve.press, zone.mpe_at_from, a);
      g.globalAlpha = a;
      // a loop's edge where the note is tall enough to show the fill inside it
      if (asLoop && noteH > 4) {
        g.strokeStyle = colour;
        g.lineWidth = 1;
        g.strokeRect(x0 + 0.5, y + 0.5, width - 1, noteH - 1);
      }
    } else if (asLoop) {
      const a = g.globalAlpha;
      g.globalAlpha = a * 0.4;
      g.fillStyle = colour;
      g.fillRect(x0, y, width, noteH);
      g.globalAlpha = a;
      g.strokeStyle = colour;
      g.lineWidth = 1;
      g.strokeRect(x0 + 0.5, y + 0.5, width - 1, noteH - 1);
    } else {
      g.fillStyle = colour;
      g.fillRect(x0, y, width, noteH);
    }
    if (running && s0 <= songHead && songHead < s1) {
      g.globalAlpha = 0.8;
      g.fillStyle = '#ffffff';
      g.fillRect(Math.max(x0, headX - 2), y, 2, noteH);
    }
  };

  // the shown take in the take lane after Stop, in a dashed frame; positions in it are
  // run positions (bar 1 = Start), the song's while stopped
  const toSong = (run: number): number => run - runToSong;
  const drawTake = (take: Take): void => {
    const x0 = x(toSong(take.start));
    const x1 = x(toSong(take.end));
    if (x1 < 0 || x0 > w) return;
    g.globalAlpha = 1;
    // picked: amber, as everything "where you are"
    const isPicked = isSelected && picked(zone) === 'take';
    if (!amber) amber = getComputedStyle(document.body).getPropertyValue('--select').trim() || '#f0b429';
    g.fillStyle = isPicked ? '#ffffff12' : '#ffffff08';
    g.fillRect(x0, takeY + 1, x1 - x0, TAKE_LANE_H - 2);
    g.strokeStyle = isPicked ? amber : '#e7eaee66';
    g.lineWidth = isPicked ? 1.5 : 1;
    if (!isPicked) g.setLineDash([3, 3]);
    g.strokeRect(Math.round(x0) + 0.75, takeY + 1.75, Math.round(x1 - x0) - 1.5, TAKE_LANE_H - 3.5);
    g.setLineDash([]);
    g.lineWidth = 1;
    for (const n of take.visibleNotes()) {
      if (x(toSong(n.s)) > w) break;
      note(toSong(n.s), toSong(n.s + n.d), rowOf(n.n), n.v, false, 0.7, takeRows, n.x);
    }
  };
  feedsArp = zone.arp_enabled;
  // the loop, cycle by cycle from the playhead on (ticks since the section began → song);
  // dashed while the zone is silent (muted or soloed out: the loop doesn't sound)
  const elapsedToSong = (e: number): number => songHead + (e - elapsedNow);
  const loopTake = zone.loop;
  // the loop sounds while its switch is on (mute is for what you play): dashed when off
  const loopOff = !zone.loopOn;
  let block: { x0: number; x1: number } | null = null;
  if (loopTake) {
    const len = loopTake.length;
    const anchor = zone.looper.anchor;
    const until = elapsedNow + (w - headX) / ppt;
    // before it comes in (switched on, or from a take, while running) it starts at its first 1
    const first = elapsedNow < anchor ? anchor : anchor + Math.floor((elapsedNow - anchor) / len) * len;
    asLoop = true;
    for (let c = first; c < until; c += len) {
      const cx = Math.round(x(elapsedToSong(c)));
      if (mini) {
        if (c > elapsedNow && cx >= 0 && cx <= w) {
          g.globalAlpha = 0.5;
          g.fillStyle = colour;
          g.fillRect(cx, songY + 1, 1, h - 2);
        }
        // tagged at its next start in view, else at the playhead (the cycle playing now)
        if (!lineTags.some((t) => t.row === 0) && (c > elapsedNow ? cx <= w : c + len > until)) {
          lineTags.push({ x: c > elapsedNow ? cx : headX, text: `Loop ${Take.lengthLabel(len, currentMeter())}`, row: 0 });
        }
      } else {
        // the cycle playing (stopped: the first) is the loop's block, the ones after it repeat
        const cx1 = Math.round(x(elapsedToSong(c + len)));
        if (c === first) {
          block = { x0: cx, x1: cx1 };
          g.globalAlpha = loopOff ? 0.05 : 0.1;
          g.fillStyle = colour;
          g.fillRect(cx, songY + 2, cx1 - cx, h - 4);
        } else {
          g.globalAlpha = 0.4;
          g.strokeStyle = colour;
          g.lineWidth = 1;
          g.setLineDash([3, 3]);
          g.strokeRect(cx + 0.5, songY + 2.5, cx1 - cx - 1, h - 5);
          g.setLineDash([]);
          if (cx1 - cx > 40 && cx + 4 < w) {
            g.globalAlpha = 1;
            g.font = '9px "Barlow Semi Condensed", sans-serif';
            g.fillStyle = DIM_TEXT;
            g.fillText('again', cx + 4, songY + 13);
          }
        }
      }
      for (const n of loopTake.notes) {
        if (c + n.t + n.d < elapsedNow) continue;
        note(elapsedToSong(c + n.t), elapsedToSong(c + n.t + n.d), rowOf(n.n), n.v, loopOff, 1, songRows, n.x);
      }
    }
    asLoop = false;
  }
  if (!mini) {
    if (block) loopBlocks.set(zone, { x0: block.x0, x1: block.x1, top: songY, barPx: barLen() * ppt });
    else loopBlocks.delete(zone);
  }
  if (block && loopTake) drawLoopBlock(g, zone, loopTake, block.x0, block.x1, songY, h, colour, loopOff, isSelected && picked(zone) === 'loop', w);
  feedsArp = false;
  // recording or overdubbing: a red wash from its first 1 to the playhead; waiting for
  // its 1 or its end, a mark there
  const lp = zone.looper;
  if (lp.mode !== 'idle') {
    const word = lp.mode === 'dub' ? 'Dub' : 'Rec';
    if (lp.from > elapsedNow) {
      marks.set(elapsedToSong(lp.from), [...(marks.get(elapsedToSong(lp.from)) ?? []), word]);
    } else {
      const rx0 = Math.max(0, x(elapsedToSong(lp.from)));
      if (rx0 < headX) {
        g.globalAlpha = 0.14;
        g.fillStyle = LOOP_REC;
        g.fillRect(rx0, songY, headX - rx0, h);
        g.globalAlpha = 0.9;
        g.fillRect(rx0, songY, headX - rx0, 2);
      }
      if (lp.to !== null) {
        const tag = lp.mode === 'dub' ? 'Dub end' : `Loop ${Take.lengthLabel(lp.to - lp.from, timeline.meter)}`;
        marks.set(elapsedToSong(lp.to), [...(marks.get(elapsedToSong(lp.to)) ?? []), tag]);
      } else if (lp.mode === 'rec') {
        // where a press now would close it (the nearest 1), and how long the loop would be
        const length = zone.loopPressLength();
        const at = elapsedToSong(lp.from + length);
        marks.set(at, [...(marks.get(at) ?? []), `Press: ${Take.lengthLabel(length, timeline.meter)}`]);
      }
    }
  }
  if (latest && !running && takeLane) {
    drawTake(latest);
    // the bars the loop was cut from, when it came from this take's run
    const origin = zone.loop?.origin;
    const from = origin && origin.at === latest.at ? origin.run - latest.runOffset : NaN;
    if (zone.loop && from >= 0 && from < latest.length) {
      const bx0 = Math.round(x(toSong(latest.start + from)));
      const bx1 = Math.round(x(toSong(latest.start + Math.min(latest.length, from + zone.loop.length))));
      if (bx1 > 0 && bx0 < w) {
        g.globalAlpha = 1;
        g.fillStyle = colour;
        g.fillRect(bx0, takeY + 2, bx1 - bx0, 2);
        g.fillRect(bx0, takeY + 2, 2, 7);
        g.fillRect(bx1 - 2, takeY + 2, 2, 7);
        g.font = '600 9px "Barlow Semi Condensed", sans-serif';
        const label = 'Loop';
        const lw = g.measureText(label).width + 6;
        if (bx1 - bx0 > lw + 6) {
          g.fillRect(bx0 + 4, takeY + 4, lw, 11);
          g.fillStyle = '#15171a';
          g.fillText(label, bx0 + 7, takeY + 12.5);
        }
      }
    }
  }
  // while running, the take lane shows the take being recorded
  if (recording) {
    for (const n of recording) note(toSong(n.t), toSong(n.t + n.d), rowOf(n.n), n.v, false, 0.85, takeRows);
  }

  // the notes the arp plays from: a band behind its notes, fading out ahead while still held
  for (const n of held) {
    const x0 = x(songOf(n.start));
    const x1 = n.end === null ? headX : x(songOf(n.end));
    if (x1 < 0 || x0 > w) continue;
    const y = rowY(rowOf(n.pitch)) - (bandH - noteH) / 2;
    g.globalAlpha = silent ? 0.08 : 0.22;
    g.fillStyle = colour;
    g.fillRect(x0, y, Math.max(1, x1 - x0), bandH);
    if (n.end === null) {
      const fade = barLen() * ppt * 0.5;
      const gradient = g.createLinearGradient(headX, 0, headX + fade, 0);
      gradient.addColorStop(0, colour);
      gradient.addColorStop(1, 'transparent');
      g.fillStyle = gradient;
      g.fillRect(headX, y, fade, bandH);
    }
  }

  // behind the playhead while running: what was sent
  for (const n of history) {
    const s0 = songOf(n.start);
    const s1 = songOf(n.end ?? sessionNow());
    note(s0, Math.max(s1, s0 + 1 / ppt), rowOf(n.pitch), n.velo, false);
  }

  // ahead of it: the sequence step by step, as playback will decide each step
  // (Sequence.upcoming()); dashed where a condition or chance skips it
  if (seqShown) {
    feedsArp = zone.arp_enabled;
    const ticks = seq.ticks;
    const MAX_STEPS_AHEAD = 4096;
    const ahead = (lane: number, cur: number, each: (s: number, step: number, plays: boolean) => void): void => {
      const base = stepStart(cur, ticks, runHead);
      let k = 1;
      // a sequence that's off: what it would play, dashed until a waiting Seq on lands
      for (const next of seq.upcoming(lane, !!mini)) {
        const t = base + k * ticks;
        if (x(t - runToSong) > w || k++ > MAX_STEPS_AHEAD) break;
        if (t >= runHead) each(t - runToSong, next.step, next.plays);
      }
    };
    if (drums) {
      for (let ln = 0; ln < rows; ln++) {
        const lane = seq.drum_lanes[ln];
        if (!lane) continue;
        ahead(ln, lane.currentStep, (s, st, plays) => {
          const step = lane.steps[st];
          if (!step || step.notesArray.length === 0) return;
          const velo = step.notesArray[0].velo;
          const hits = Math.max(1, step.ratchetCount);
          for (let r = 0; r < hits; r++) {
            const rs = s + (hits > 1 ? r * step.ratchetResolution : 0);
            note(rs, rs + Math.max(1, (hits > 1 ? step.ratchetResolution : ticks) * 0.6), ln, velo, !plays || !seqSounds(rs));
          }
        });
      }
    } else if (seq.length > 0) {
      ahead(-1, seq.currentStepNumber, (s, st, plays) => {
        if (st === 0) {
          // where each repeat begins (tagged when a loop plays too, so the two read apart)
          g.globalAlpha = silent ? 0.2 : 0.45;
          g.fillStyle = colour;
          g.fillRect(Math.round(x(s)), songY, 1, h);
          if (loopTake && s >= songHead - 0.5 && !lineTags.some((t) => t.row === 1)) {
            lineTags.push({ x: Math.round(x(s)), text: 'Seq', row: 1 });
          }
        }
        const step = seq.steps[st];
        if (!step || step.notesArray.length === 0) return;
        const dur =
          (Math.max(1, step.length) - 1) * ticks + Math.max(1, Math.min(ticks * step.gateLength, ticks - 1));
        const hits = Math.max(1, step.ratchetCount);
        for (const n of step.notesArray) {
          if (hits > 1) {
            for (let r = 0; r < hits; r++) {
              const rs = s + r * step.ratchetResolution;
              note(rs, rs + Math.max(1, step.ratchetResolution - 1), rowOf(n.number), n.velo, !plays || !seqSounds(rs));
            }
          } else {
            note(s, s + dur, rowOf(n.number), n.velo, !plays || !seqSounds(s));
          }
        }
      });
    }
    feedsArp = false;
    if (!mini) {
      cornerLabel(
        drums ? `${rows} lanes · ${seq.length} × ${divisionName(zone)}` : `${seq.length} × ${divisionName(zone)}`,
        songY
      );
    }
  }
  if (takeLane) {
    cornerLabel(recording ? 'Recording' : running ? '' : shown ? `Take ${shown.number}/${shown.count}` : '', takeY);
  }

  // the past a shade darker while running, then the playhead
  g.globalAlpha = 1;
  if (running) {
    g.fillStyle = '#0000002e';
    g.fillRect(0, 0, Math.max(0, Math.min(w, headX)), fullH);
  }
  g.fillStyle = '#e7eaeecc';
  if (headX >= 0 && headX <= w) g.fillRect(headX, 0, 1, fullH);
  // the lanes' names: what you played above, what repeats below
  if (takeLane) {
    const songName = [zone.loop ? 'Loop' : '', seqShown ? 'Seq' : ''].filter(Boolean).join(' · ');
    g.font = '600 10px "Barlow Semi Condensed", sans-serif';
    for (const [name, top] of [['Takes', takeY], [songName, songY]] as [string, number][]) {
      if (!name) continue;
      const nw = g.measureText(name).width + 8;
      g.globalAlpha = 0.85;
      g.fillStyle = '#15171a';
      g.fillRect(3, top + 3, nw, 13);
      g.globalAlpha = 1;
      g.fillStyle = DIM_TEXT;
      g.fillText(name, 7, top + 13);
    }
  }

  // waiting toggles: a light line where they land, tagged with what they'll do
  g.font = '9px "Barlow Semi Condensed", sans-serif';
  for (const t of lineTags) {
    if (t.x < headX || t.x > w) continue;
    const tw = Math.ceil(g.measureText(t.text).width) + 6;
    const ty = songY + h - 13 - t.row * 12;
    // right of its line, or left of it where it would run off the lane
    const tx = t.x + 1 + tw > w - 2 ? t.x - tw - 1 : t.x + 1;
    g.globalAlpha = 0.85;
    g.fillStyle = '#15171a';
    g.fillRect(tx, ty, tw, 11);
    g.globalAlpha = 1;
    g.fillStyle = colour;
    g.fillText(t.text, tx + 3, ty + 9);
  }
  for (const [at, tags] of marks) {
    const lx = Math.round(x(at));
    const tag = tags.join(' · ');
    g.globalAlpha = 1;
    g.fillStyle = '#cfd6df';
    g.fillRect(lx, 0, 2, fullH);
    g.font = '600 9px "Barlow Semi Condensed", sans-serif';
    const tw = Math.ceil(g.measureText(tag).width) + 6;
    // left of the line, unless that runs into the playhead
    const tx = lx - tw - 1 > headX + 2 ? lx - tw - 1 : lx + 3;
    g.fillRect(tx, 1, tw, 11);
    g.fillStyle = '#15171a';
    g.fillText(tag, tx + 3, 10);
  }
  if (mini) return;

  // the take converts (or is quantized) in the take lane
  if (conv?.zone === zone && takeLane) {
    drawConversion(g, (t) => x(toSong(t)), rowOf, takeRows, w, takeY, TAKE_LANE_H);
  }
  if (capture?.zone === zone) drawCapture(g, el, x(toSong(capture.from)), x(toSong(capture.to)), w, takeY, TAKE_LANE_H);
  if (isSelected) {
    // one chip in the strip: picked bars, else the shown take
    const stretch = capture?.zone === zone;
    const kind = picked(zone);
    placeTakeChip(el, shown, kind === 'take' && latest && !running && !conv && !stretch ? x(toSong(latest.start)) : null, w);
    const block = loopBlocks.get(zone);
    // while running the take lane shows the recording: the strip is the loop's
    const loopChipShown = (kind === 'loop' || (running && zone.loop !== null)) && !conv && !stretch;
    placeLoopChip(el, zone, loopChipShown && block ? block.x0 : null, w);
    const hint = !running && !latest && !zone.loop ? TAKE_HINT : '';
    const hintEl = el.querySelector('.track-hint')!;
    if (hintEl.textContent !== hint) hintEl.textContent = hint;
  }
}

/** The steps a conversion would make: boxes on the grid, a line from each played note to its step */
function drawConversion(
  g: CanvasRenderingContext2D,
  x: (s: number) => number,
  rowOf: (pitch: number) => number,
  place: { y: (row: number) => number; h: number },
  w: number,
  top: number,
  h: number
): void {
  const c = conv!;
  const rowY = place.y;
  const noteH = place.h;
  const ticks = DIV_TICKS[c.grid];
  g.globalAlpha = 1;
  // outside the stretch, darker
  g.fillStyle = '#00000059';
  g.fillRect(0, top, Math.max(0, x(c.from)), h);
  g.fillRect(Math.min(w, x(c.to)), top, w, h);
  // the grid's steps
  g.fillStyle = '#e7eaee14';
  for (let i = 0; i < c.q.steps && i < c.q.max; i++) {
    const sx = x(c.from + stepPos(i, ticks, c.swing));
    if (sx > w) break;
    if (sx >= 0) g.fillRect(Math.round(sx), top, 1, h);
  }
  g.strokeStyle = '#e7eaee';
  if (c.target === 'take') {
    // where each note will start, a line from where it was played
    c.notes.forEach((n, k) => {
      const row = rowOf(n.n);
      if (row < 0) return;
      const y = rowY(row);
      const to = c.starts[k];
      g.globalAlpha = 0.7;
      g.beginPath();
      g.moveTo(x(n.s), y + noteH / 2);
      g.lineTo(x(to), y + noteH / 2);
      g.stroke();
      g.globalAlpha = 1;
      g.strokeRect(Math.round(x(to)) + 0.5, y - 1.5, Math.max(2, x(to + n.d) - x(to) - 1), noteH + 2);
    });
    return;
  }
  for (const m of c.q.moves) {
    const row = rowOf(m.n);
    if (row < 0) continue;
    const y = rowY(row) + noteH / 2;
    g.globalAlpha = 0.7;
    g.beginPath();
    g.moveTo(x(m.from), y);
    g.lineTo(x(m.to), y);
    g.stroke();
  }
  c.q.cells.forEach((cell, i) => {
    if (!cell) return;
    const s0 = c.from + stepPos(i, ticks, c.swing);
    const x0 = x(s0);
    const x1 = x(s0 + ((cell.length - 1) + cell.gate) * ticks);
    if (x1 < 0 || x0 > w) return;
    for (const n of cell.notes) {
      const row = rowOf(n.n);
      if (row < 0) continue;
      g.globalAlpha = 1;
      g.strokeRect(Math.round(x0) + 0.5, rowY(row) - 1.5, Math.max(2, x1 - x0 - 1), noteH + 2);
    }
  });
}

/** On the selected track: browse its takes (‹ ›), and what can be done with the one shown */
/** The loop's block: framed and named; picked: amber, with handles on its edges; an edge being dragged */
function drawLoopBlock(
  g: CanvasRenderingContext2D,
  zone: Zone,
  loop: Take,
  x0: number,
  x1: number,
  top: number,
  h: number,
  colour: string,
  silent: boolean,
  isPicked: boolean,
  w: number
): void {
  if (!amber) amber = getComputedStyle(document.body).getPropertyValue('--select').trim() || '#f0b429';
  const drag = loopDrag?.zone === zone ? loopDrag : null;
  const barPx = barLen() * view.ppt;
  g.globalAlpha = 1;
  if (drag && drag.bars !== 0) {
    // where the dragged edge lands: bars it leaves hatched, bars it takes in dashed
    const at = (drag.edge === 'end' ? x1 : x0) + drag.bars * barPx;
    const [a, b] = at < (drag.edge === 'end' ? x1 : x0) ? [at, drag.edge === 'end' ? x1 : x0] : [drag.edge === 'end' ? x1 : x0, at];
    const leaving = drag.edge === 'end' ? drag.bars < 0 : drag.bars > 0;
    g.save();
    g.beginPath();
    g.rect(a, top + 2, b - a, h - 4);
    g.clip();
    if (leaving) {
      g.fillStyle = '#00000059';
      g.fillRect(a, top + 2, b - a, h - 4);
      g.strokeStyle = '#ffffff1f';
      g.lineWidth = 1;
      for (let k = -h; k < b - a; k += 6) {
        g.beginPath();
        g.moveTo(a + k, top + h);
        g.lineTo(a + k + h, top);
        g.stroke();
      }
    } else {
      g.fillStyle = colour;
      g.globalAlpha = 0.08;
      g.fillRect(a, top + 2, b - a, h - 4);
    }
    g.restore();
    g.globalAlpha = 1;
    g.strokeStyle = amber;
    g.setLineDash([3, 3]);
    g.strokeRect(a + 0.5, top + 2.5, b - a - 1, h - 5);
    g.setLineDash([]);
    g.fillStyle = amber;
    g.fillRect(Math.round(at) - 1, top + 2, 2, h - 4);
    const bars = Math.round(loop.length / barLen()) + (drag.edge === 'end' ? drag.bars : -drag.bars);
    const tip = `${bars} bar${bars === 1 ? '' : 's'}${leaving ? ' · the rest set aside' : ''}`;
    g.font = '600 10px "Barlow Semi Condensed", sans-serif';
    const tw = g.measureText(tip).width + 10;
    const tx = Math.max(2, Math.min(w - tw - 2, at + 6));
    g.fillRect(tx, top + h - 18, tw, 14);
    g.fillStyle = '#15171a';
    g.fillText(tip, tx + 5, top + h - 7.5);
  }
  // its frame and name, set into it like the zone's name box
  g.strokeStyle = isPicked ? amber : colour;
  g.lineWidth = isPicked ? 1.5 : 1;
  if (silent) g.setLineDash([3, 3]);
  g.strokeRect(x0 + 0.75, top + 2.75, x1 - x0 - 1.5, h - 5.5);
  g.setLineDash([]);
  g.lineWidth = 1;
  const label = `Loop · ${Take.lengthLabel(loop.length, currentMeter())}`;
  g.font = '600 10px "Barlow Semi Condensed", sans-serif';
  const lw = Math.min(x1 - x0 - 2, g.measureText(label).width + 10);
  if (lw > 20) {
    g.fillStyle = colour;
    g.fillRect(x0 + 1, top + 2, lw, 14);
    g.fillStyle = '#15171a';
    g.save();
    g.beginPath();
    g.rect(x0 + 1, top + 2, lw, 14);
    g.clip();
    g.fillText(label, x0 + 6, top + 13);
    g.restore();
  }
  if (isPicked) {
    for (const hx of [x0, x1]) {
      const hy = top + h / 2 - 11;
      g.fillStyle = amber;
      g.fillRect(hx - 3, hy, 6, 22);
      g.fillStyle = '#15171a';
      g.fillRect(hx - 1, hy + 6, 1, 10);
      g.fillRect(hx + 1, hy + 6, 1, 10);
    }
  }
}

function placeTakeChip(
  zoneEl: HTMLElement,
  shown: { take: Take; number: number; count: number } | null,
  takeX: number | null,
  w: number
): void {
  if (!shown || takeX === null) {
    takeChip.remove();
    return;
  }
  const strip = zoneEl.querySelector('.track-strip')!;
  if (takeChip.parentElement !== strip) {
    strip.appendChild(takeChip);
    invalidate(); // placed by its width, known from the next frame
  }
  const label = `Take ${shown.number}/${shown.count} · ${Take.lengthLabel(shown.take.length, takeMeter(shown.take))} ▾`;
  const labelEl = takeChip.querySelector('.tc-label')!;
  if (labelEl.textContent !== label) labelEl.textContent = label;
  const loopEl = takeChip.querySelector('.tc-keep')!;
  const loopText = keepLabel(shown.take);
  if (loopEl.textContent !== loopText) loopEl.textContent = loopText;
  takeChip.querySelector('.tc-prev')!.classList.toggle('off', shown.number <= 1);
  takeChip.querySelector('.tc-next')!.classList.toggle('off', shown.number >= shown.count);
  takeChip.style.left = `${Math.max(4, Math.min(w - takeChip.offsetWidth - 4, takeX + 4))}px`;
}

/**
 * A note played with MPE, filled in slices brighter where its key was pressed harder: its
 * pressure from the zone's threshold (`from`) up, as the zone hears it. `ticks`: its length.
 */
export function fillByPressure(
  g: CanvasRenderingContext2D,
  x0: number,
  y: number,
  width: number,
  h: number,
  ticks: number,
  press: CurveSeries,
  from: number,
  alpha: number
): void {
  const cursor = new CurveCursor({ press });
  const step = 2;
  for (let px = 0; px < width; px += step) {
    const p = cursor.at(((px + step / 2) / width) * ticks).press;
    g.globalAlpha = alpha * (0.12 + (0.88 * Math.max(0, p - from)) / Math.max(1, 127 - from));
    g.fillRect(x0 + px, y, Math.min(step, width - px), h);
  }
}

/** The loop's chip in the strip, at its block: its length, a bar less or more, Clear */
function placeLoopChip(zoneEl: HTMLElement, zone: Zone, loopX: number | null, w: number): void {
  const loop = zone.loop;
  if (!loop || loopX === null) {
    loopChip.remove();
    return;
  }
  const strip = zoneEl.querySelector('.track-strip')!;
  if (loopChip.parentElement !== strip) {
    strip.appendChild(loopChip);
    invalidate();
  }
  const bar = barLen();
  const label = `Loop · ${Take.lengthLabel(loop.length, currentMeter())}`;
  const labelEl = loopChip.querySelector('.lc-label')!;
  if (labelEl.textContent !== label) labelEl.textContent = label;
  const busy = zone.looper.mode !== 'idle';
  loopChip.querySelector('.lc-less')!.classList.toggle('off', busy || loop.length <= bar);
  loopChip.querySelector('.lc-more')!.classList.toggle('off', busy || loop.length + bar > MAX_LOOP_BARS * bar);
  loopChip.querySelector('.lc-clear')!.classList.toggle('off', busy);
  // only for a loop played with MPE expression; lit while it plays it
  const mpe = loopChip.querySelector('.lc-mpe') as HTMLElement;
  mpe.hidden = !loop.hasExpression;
  mpe.classList.toggle('lit', zone.loopMpe);
  loopChip.style.left = `${Math.max(4, Math.min(w - loopChip.offsetWidth - 4, loopX + 4))}px`;
}

/** The bars picked, and what can be done with them at their end */
function drawCapture(
  g: CanvasRenderingContext2D,
  zoneEl: HTMLElement,
  x0: number,
  x1: number,
  w: number,
  top: number,
  h: number
): void {
  const strip = zoneEl.querySelector('.track-strip')!;
  if (x1 < 0 || x0 > w) {
    captureButton.remove(); // scrolled out of view; still picked
    return;
  }
  g.globalAlpha = 1;
  g.fillStyle = '#e7eaee1a';
  g.fillRect(x0, top, x1 - x0, h);
  g.fillStyle = '#e7eaeeb3';
  g.fillRect(Math.round(x0), top, 1, h);
  g.fillRect(Math.round(x1) - 1, top, 1, h);
  if (captureButton.parentElement !== strip) {
    strip.appendChild(captureButton);
    invalidate(); // placed by its width, known from the next frame
  }
  const take = shownTake(capture!.zone)?.take;
  const text = `Loop ${Take.lengthLabel(capture!.to - capture!.from, take ? takeMeter(take) : timeline.meter)}`;
  const keepLink = captureButton.querySelector('.cb-loop')!;
  if (keepLink.textContent !== text) keepLink.textContent = text;
  captureButton.style.left = `${Math.max(4, Math.min(w - captureButton.offsetWidth - 4, x1 - captureButton.offsetWidth - 4))}px`;
}

function clearCapture(): void {
  capture = null;
  captureButton?.remove();
  invalidate();
}

/** Song position under a mouse x on a lane (stopped: a position in the shown take too) */
function laneTick(lane: Element, clientX: number): number {
  const rect = lane.getBoundingClientRect();
  const headX = Math.round(rect.width * PLAYHEAD_AT) + view.scrollPx;
  return view.head + (clientX - rect.left - headX) / view.ppt;
}

/**
 * The loop's bars from `a` to `b` (ticks from its start: an edge dragged out reaches into
 * what it was cut from, dragged in the bars are set aside); one undo step
 */
function setLoopBars(zone: Zone, a: number, b: number, label: string): void {
  const index = getZones().indexOf(zone);
  const loop = zone.loop;
  if (index < 0 || !loop) return;
  if (zone.looper.mode !== 'idle') {
    toast('The loop is being recorded or overdubbed: finish that first');
    return;
  }
  const bar = barLen();
  if (b - a < bar || b - a > MAX_LOOP_BARS * bar) return;
  const next = recutLoop(loop, a, b, bar);
  if (!next) return;
  commit(index, label, () => {
    zone.loop = next;
    zone.loopPlayer.release(true);
  });
  invalidate();
}

function clearLoop(zone: Zone): void {
  const index = getZones().indexOf(zone);
  if (index < 0 || !zone.loop || zone.looper.mode !== 'idle') return;
  commit(index, 'Clear Loop', () => {
    zone.loop = null;
    zone.loopPlayer.release(true);
  });
  editing = null;
  invalidate();
}

/** Drag an edge of the loop's block by whole bars: applied on release */
function startLoopEdgeDrag(ev: MouseEvent, zone: Zone, edge: 'start' | 'end', barPx: number): void {
  const loop = zone.loop;
  if (!loop) return;
  pick(zone, 'loop');
  const startX = ev.clientX;
  const bar = barLen();
  const len = loop.length;
  // the loop's length stays from a bar to MAX_LOOP_BARS
  const most = Math.floor((MAX_LOOP_BARS * bar - len) / bar);
  const least = -Math.floor((len - bar) / bar);
  loopDrag = { zone, edge, bars: 0 };
  document.body.classList.add('loop-edge-dragging');
  const move = (e: MouseEvent): void => {
    let bars = Math.round((e.clientX - startX) / barPx);
    // the end grows to the right, the start to the left
    bars = edge === 'end' ? Math.max(least, Math.min(most, bars)) : Math.max(-most, Math.min(-least, bars));
    if (loopDrag && loopDrag.bars !== bars) {
      loopDrag.bars = bars;
      invalidate();
    }
  };
  const up = (): void => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    document.body.classList.remove('loop-edge-dragging');
    const bars = loopDrag?.bars ?? 0;
    loopDrag = null;
    if (bars === 0) {
      invalidate();
      return;
    }
    if (edge === 'end') setLoopBars(zone, 0, len + bars * bar, 'Loop Length');
    else setLoopBars(zone, bars * bar, len, 'Loop Start');
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

/** Which edge of the loop's block is under a mouse x on its lane (null: none) */
function loopEdgeAt(zone: Zone, lane: Element, clientX: number, clientY: number): 'start' | 'end' | null {
  const block = loopBlocks.get(zone);
  const canvas = lane.querySelector('canvas');
  if (!block || !canvas || !zone.loop) return null;
  const rect = canvas.getBoundingClientRect();
  if (clientY < rect.top + block.top) return null;
  const cx = clientX - rect.left;
  if (Math.abs(cx - block.x0) <= 6) return 'start';
  if (Math.abs(cx - block.x1) <= 6) return 'end';
  return null;
}

/** When a take was recorded: the time of day today, else the date */
function recordedWhen(take: Take): string {
  if (!take.at) return '';
  const at = new Date(take.at);
  const today = new Date().toDateString() === at.toDateString();
  return today
    ? at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : at.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

/** The take menu: every take of the zone, newest first; a click shows it */
function openTakeMenu(zone: Zone, anchor: HTMLElement): void {
  const menu = document.getElementById('contextmenu');
  if (!menu) return;
  const list = takeStore.of(zone.id);
  const shown = takeStore.shownTake(zone.id);
  menu.classList.remove('cc-presets-menu');
  menu.innerHTML =
    '<li class="heading">Takes</li>' +
    list
      .map((take, i) => ({ take, i }))
      .reverse()
      .map(
        ({ take, i }) =>
          `<li data-take-index="${i}"><i class="material-icons">${take === shown ? 'check' : ''}</i> ` +
          `Take ${i + 1} · ${Take.lengthLabel(take.length, takeMeter(take))}` +
          `${take.at ? ` · ${recordedWhen(take)}` : ''}</li>`
      )
      .join('');
  menu.querySelectorAll('[data-take-index]').forEach((li) =>
    li.addEventListener('click', (e) => {
      e.stopPropagation();
      const take = list[Number((li as HTMLElement).dataset['takeIndex'])];
      if (take) {
        takeStore.show(zone.id, take);
        followShownTake(zone);
        clearCapture();
        invalidate();
      }
      window.dispatchEvent(new CustomEvent('closeContextMenu'));
    })
  );
  menu.style.display = 'block';
  const r = anchor.getBoundingClientRect();
  const m = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(r.left, window.innerWidth - m.width)}px`;
  menu.style.top = `${r.bottom + m.height > window.innerHeight ? Math.max(0, r.top - m.height) : r.bottom}px`;
}

/** After Stop, drag over the shown take: bars of it to loop (or turn into steps) */
function startCaptureDrag(ev: MouseEvent, lane: Element, zone: Zone): void {
  const startX = ev.clientX;
  const start = laneTick(lane, startX);
  let dragging = false;
  const move = (e: MouseEvent): void => {
    if (!dragging && Math.abs(e.clientX - startX) < 4) return;
    dragging = true;
    const take = shownTake(zone)?.take;
    if (!take) return;
    const end = laneTick(lane, e.clientX);
    // the take's bars, beats with Alt/Option; within the take
    const from = Math.max(take.start, snapInTake(take, Math.min(start, end), e, 'floor'));
    let to = Math.min(take.end, snapInTake(take, Math.max(start, end), e, 'ceil'));
    if (to <= from) to = Math.min(take.end, snapInTake(take, from + 1, e, 'ceil'));
    if (to <= from) return;
    capture = { zone, from, to };
    invalidate();
  };
  const up = (): void => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    if (dragging) return;
    // a click on the shown take picks it; elsewhere in the lane it just lets go of picked bars
    const take = shownTake(zone)?.take;
    if (take && start >= take.start && start < take.end) pick(zone, 'take');
    else clearCapture();
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

/** Open the conversion of a take (or bars of it) into steps, or its quantizing, with a preview */
function startConvert(zone: Zone, take: Take, from: number, to: number, target: 'steps' | 'take' = 'steps'): void {
  const notes = take.visibleNotes().filter((n) => n.s >= from && n.s < to);
  if (notes.length === 0) {
    toast('Nothing was played there');
    return;
  }
  const analysis = analyse(notes, from);
  conv = {
    zone,
    take,
    target,
    strength: 1,
    starts: [],
    from,
    to,
    notes,
    suggested: analysis.grid,
    grid: analysis.grid,
    swing: analysis.swing,
    useSwing: analysis.swing > 0,
    drums: zone.sequence.isDrumSequence,
    q: quantize(notes, from, to, analysis.grid, analysis.swing, zone.sequence.isDrumSequence)
  };
  conv.starts = quantizeStarts(notes, from, conv.grid, conv.swing, conv.strength, conv.useSwing);
  clearCapture();
  const index = getZones().indexOf(zone);
  if (index >= 0) select(index);
  setDockOpen(true);
  document.body.classList.add('converting');
  updateConvertPanel();
}

function recompute(): void {
  if (!conv) return;
  conv.q = quantize(conv.notes, conv.from, conv.to, conv.grid, conv.swing, conv.drums);
  conv.starts = quantizeStarts(conv.notes, conv.from, conv.grid, conv.swing, conv.strength, conv.useSwing);
  updateConvertPanel();
  invalidate();
}

function updateConvertPanel(): void {
  const panel = document.querySelector('#trackDock .td-convert');
  if (!panel || !conv) return;
  const c = conv;
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
  const meter = takeMeter(c.take);
  panel.querySelector('.tdc-what')!.textContent =
    ` · ${Take.lengthLabel(c.to - c.from, meter)} from bar ${Math.floor(c.from / barTicks(meter)) + 1} · ${plural(c.notes.length, 'note')}`;
  const select = panel.querySelector('.tdc-grid') as HTMLSelectElement;
  if (select.options.length === 0) {
    CONVERT_GRIDS.forEach((g) => select.add(new Option(DIV_NAMES[g], String(g))));
  }
  CONVERT_GRIDS.forEach((g, i) => {
    select.options[i].text = DIV_NAMES[g] + (g === c.suggested ? ' (detected)' : '');
  });
  select.value = String(c.grid);
  const intoTake = c.target === 'take';
  panel.querySelector('.tdc-title')!.textContent = intoTake ? 'Quantize the take' : 'Take to steps';
  panel.querySelectorAll('.tdc-target [data-target]').forEach((m) => {
    m.classList.toggle('on', (m as HTMLElement).dataset['target'] === c.target);
  });
  panel.querySelectorAll('.tdc-for-take').forEach((r) => ((r as HTMLElement).style.display = intoTake ? '' : 'none'));
  panel.querySelectorAll('.tdc-for-steps').forEach((r) => ((r as HTMLElement).style.display = intoTake ? 'none' : ''));
  const strength = panel.querySelector('.tdc-strength') as HTMLInputElement;
  strength.value = String(Math.round(c.strength * 100));
  // the filled part of the track, as the zones' sliders show it
  strength.style.setProperty('--fill', `${((c.strength * 100 - 10) / 90) * 100}%`);
  panel.querySelector('.tdc-strength-value')!.textContent = `${Math.round(c.strength * 100)}%`;
  panel.querySelectorAll('.tdc-mode [data-mode]').forEach((m) => {
    m.classList.toggle('on', ((m as HTMLElement).dataset['mode'] === 'drums') === c.drums);
  });
  const swingRow = panel.querySelector('.tdc-swing') as HTMLElement;
  swingRow.style.display = c.swing > 0 ? '' : 'none';
  (swingRow.querySelector('input') as HTMLInputElement).checked = c.useSwing;
  const swing = Math.round(c.swing * 100);
  swingRow.querySelector('.tdc-swing-text')!.textContent = `${intoTake ? 'Keep' : 'Set'} ${swing}%`;
  swingRow.querySelector('.tdc-swing-note')!.textContent = intoTake
    ? c.useSwing
      ? 'The off-beats were played late and stay late'
      : 'Off: the off-beats move to the straight grid'
    : c.useSwing
      ? "The zone's Swing, as the off-beats were played late"
      : "Off: the zone's Swing stays as it is";
  const q = c.q;
  const filled = q.cells.filter(Boolean).length;
  const seq = c.zone.sequence;
  const current = seq.isDrumSequence
    ? seq.drum_lanes.some((l) => l?.steps.some((st) => st && !st.isBlank()))
    : seq.steps.some((st, i) => i < seq.length && st && !st.isBlank());
  const parts = [
    `${plural(Math.min(q.steps, q.max), 'step')} of ${DIV_NAMES[c.grid]}`,
    c.drums ? plural(q.lanes.length, 'lane') : `notes on ${plural(filled, 'step')}`
  ];
  if (q.chords) parts.push(plural(q.chords, 'chord'));
  if (q.merged) parts.push(`${q.merged} merged (same pitch on one step)`);
  let text = parts.join(' · ') + '.';
  if (current) text += ` Replaces the current ${seq.length}-step sequence.`;
  text += ' The sequencer plays them; the take stays.';
  if (!q.fits) {
    text =
      q.steps > q.max
        ? `${q.steps} steps don't fit (at most ${q.max}${c.drums ? ' in drum mode' : ''}): pick a coarser grid or drag over a shorter stretch.`
        : `${q.lanes.length} pitches don't fit into ${12} drum lanes.`;
  }
  if (intoTake) {
    // how far the notes move, in ms at the current tempo
    const msPerTick = timeline.intervalMs > 0 ? timeline.intervalMs : 20.83;
    const moves = c.notes.map((n, k) => Math.abs(c.starts[k] - n.s) * msPerTick);
    const most = Math.round(Math.max(0, ...moves));
    const mean = Math.round(moves.reduce((a, b) => a + b, 0) / Math.max(1, moves.length));
    text =
      `${plural(c.notes.length, 'note')} move ${Math.round(c.strength * 100)}% toward ${DIV_NAMES[c.grid]}: ` +
      `${mean} ms on average, at most ${most} ms. Lengths stay. The take changes (undo goes back).`;
  }
  const result = panel.querySelector('.tdc-result') as HTMLElement;
  result.textContent = text;
  result.classList.toggle('warn', !intoTake && !q.fits);
  panel.querySelector('.tdc-fit')!.textContent = c.grid === c.suggested ? '' : 'not the detected grid';
  const action = panel.querySelector('.tdc-convert')!;
  action.textContent = intoTake ? 'Quantize' : 'Convert';
  action.classList.toggle('off', !intoTake && !q.fits);
}

function convert(): void {
  if (!conv) return;
  if (conv.target === 'take') {
    quantizeTake();
    return;
  }
  if (!conv.q.fits) return;
  const c = conv;
  const index = getZones().indexOf(c.zone);
  if (index < 0) return;
  commit(index, 'Take to Steps', () => {
    applyToSequence(c.zone.sequence, c.q);
    if (c.useSwing && c.swing > 0) c.zone.swingAmount = c.swing;
  });
  endConvert();
  setTab('seq');
  toast(`${Math.min(c.q.steps, c.q.max)} steps of ${DIV_NAMES[c.grid]} made from the take`);
}

/** Quantize the take (or the picked bars of it) in place */
function quantizeTake(): void {
  const c = conv!;
  const index = getZones().indexOf(c.zone);
  if (index < 0) return;
  const moves = new Map<number, number>();
  c.notes.forEach((n, k) => moves.set(n.s, c.starts[k]));
  commitTake(index, c.take, 'Quantize Take', () => c.take.moveNotes(moves, c.take.start));
  endConvert();
  toast(`Quantized ${c.notes.length} notes toward ${DIV_NAMES[c.grid]} (${Math.round(c.strength * 100)}%)`);
}

function endConvert(): void {
  conv = null;
  document.body.classList.remove('converting');
  invalidate();
}

// ---------------------------------------------------------------------------
// Takes: browsed with the take chip (‹ ›, its menu), previews for the cards' strips



function drawTakePreview(canvas: HTMLCanvasElement, take: Take, share: number, colour: string): void {
  const dpr = window.devicePixelRatio || 1;
  const full = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!full || !h) return;
  canvas.width = full * dpr;
  canvas.height = h * dpr;
  const g = canvas.getContext('2d')!;
  g.scale(dpr, dpr);
  const w = Math.max(4, full * share);
  g.fillStyle = '#ffffff0d';
  g.fillRect(0, 0, w, h);
  const notes = take.visibleNotes();
  if (notes.length === 0) return;
  let lo = 127;
  let hi = 0;
  for (const n of notes) {
    lo = Math.min(lo, n.n);
    hi = Math.max(hi, n.n);
  }
  const span = Math.max(1, hi - lo);
  const px = w / take.length;
  g.fillStyle = colour;
  for (const n of notes) {
    g.globalAlpha = 0.45 + (0.55 * n.v) / 127;
    const y = 2 + ((hi - n.n) / span) * (h - 6);
    g.fillRect((n.s - take.start) * px, y, Math.max(1.5, n.d * px - 0.5), 2);
  }
}


/**
 * Bars from…to of a take become the zone's loop in this arrangement (the pick-up from the
 * bar before them at its end). While running it lines up with the bars: its first 1 is the
 * next bar line.
 */
function loopFromTake(zone: Zone, take: Take, from: number, to: number, label = 'Loop from Take'): boolean {
  const index = getZones().indexOf(zone);
  if (index < 0) return false;
  if (zone.looper.mode !== 'idle') {
    toast('The loop is being recorded or overdubbed: finish that first');
    return false;
  }
  const bar = barTicks(take.sectionAt(from).meter);
  const loop = loopFromNotes(take.visibleNotes(), from, to, bar);
  if (!loop) {
    toast('Nothing was played there');
    return false;
  }
  if (take.at) loop.origin = { at: take.at, run: from + take.runOffset };
  commit(index, label, () => {
    zone.loop = loop;
    zone.loopOn = true;
    zone.loopMpe = true;
    zone.loopPlayer.release(true);
    const elapsed = timeline.running ? nowTick() - timeline.sectionStart : 0;
    const zoneBar = barLen();
    zone.looper.anchor = timeline.running ? Math.ceil(elapsed / zoneBar) * zoneBar : 0;
  });
  clearCapture();
  toast(`${zone.label || `Zone ${index + 1}`}: looping ${Take.lengthLabel(loop.length, takeMeter(take))}`);
  return true;
}

/**
 * The bars a whole take loops: from the bar of its first note to the bar line after its
 * last one. A first bar holding only a pick-up (a phrase into the next 1) isn't a bar of
 * the loop: the loop starts at that 1 and the pick-up goes at its end.
 */
function keepRange(take: Take): { from: number; to: number } | null {
  const notes = take.visibleNotes();
  if (notes.length === 0) return null;
  let from = take.barLine(notes[0].s + EARLY, 'floor');
  const next = from + barTicks(take.sectionAt(from).meter);
  const later = notes.some((n) => n.s >= next - EARLY);
  if (later && pickupStart(notes, next, next - from) <= notes[0].s) from = next;
  // the end: the bar line after the last note (a release just past a bar line adds no bar)
  let last = 0;
  for (const n of notes) last = Math.max(last, n.s + EARLY, n.s + n.d - PPQ / 4);
  const to = Math.max(take.barLine(last, 'ceil'), from + barTicks(take.sectionAt(from).meter));
  return { from, to };
}

/** The button that loops a whole take says how long the loop will be: "Loop 4 bars" */
function keepLabel(take: Take): string {
  // (asked every frame for the shown take: worked out again only when takes change)
  const cached = keepLabels.get(take);
  if (cached && cached.version === takeStore.version) return cached.label;
  const range = keepRange(take);
  const label = range ? `Loop ${Take.lengthLabel(range.to - range.from, take.sectionAt(range.from).meter)}` : 'Loop';
  keepLabels.set(take, { version: takeStore.version, label });
  return label;
}
const keepLabels = new WeakMap<Take, { version: number; label: string }>();

/** A whole take becomes the zone's loop in this arrangement (replacing the loop there) */
function keepTake(zone: Zone, take: Take): boolean {
  const range = keepRange(take);
  if (!range) {
    toast('This take has no notes');
    return false;
  }
  const bar = barTicks(take.sectionAt(range.from).meter);
  if (range.to - range.from > MAX_LOOP_BARS * bar) {
    toast(`Longer than ${MAX_LOOP_BARS} bars: in the Tracks view, drag over the bars to loop`);
    return false;
  }
  return loopFromTake(zone, take, range.from, range.to);
}

/** Loop the picked bars of the shown take */
function loopStretch(): void {
  if (!capture) return;
  const { zone, from, to } = capture;
  const take = shownTake(zone)?.take;
  if (take) loopFromTake(zone, take, from, to);
}

/** Browse the selected track's takes: -1 an older one, +1 a newer one */
function browseTakes(step: number): void {
  const zone = getZones()[selected];
  if (!zone) return;
  takeStore.browse(zone.id, -step);
  followShownTake(zone);
  clearCapture();
  invalidate();
}

/** A picked take follows the take browsed to */
function followShownTake(zone: Zone): void {
  const take = takeStore.shownTake(zone.id);
  if (editing?.zoneId === zone.id && editing.kind === 'take' && take) {
    editing = { zoneId: zone.id, kind: 'take', take };
    refitTakeEditor();
  }
}

// ---------------------------------------------------------------------------

function initTrackView(
  zones: () => Zone[],
  commitChange: (zoneIndex: number, label: string, change: () => void) => void,
  takeHooks: {
    commit: (zoneIndex: number, take: Take, label: string, change: () => void) => void;
    remove: (zoneIndex: number, take: Take) => void;
  },
  meter: () => Meter
): void {
  getZones = zones;
  commit = commitChange;
  commitTake = takeHooks.commit;
  deleteTake = takeHooks.remove;
  currentMeter = meter;
  const zonesEl = document.getElementById('zones')!;
  captureButton = document.createElement('div');
  captureButton.className = 'track-capture track-chip';
  captureButton.innerHTML =
    '<a class="cb-loop lightButton" title="These bars become the zone’s loop in this arrangement, with the pick-up before them (Esc: let go)"></a>' +
    '<a class="cb-quantize lightButton" title="Quantize these bars of the take">Quantize</a>' +
    '<a class="cb-steps lightButton" title="Turn these bars into steps">To steps</a>';
  captureButton.addEventListener('mousedown', (ev) => ev.stopPropagation());
  captureButton.querySelector('.cb-loop')!.addEventListener('click', loopStretch);
  const fromStretch = (target: 'steps' | 'take') => (): void => {
    const take = capture && shownTake(capture.zone)?.take;
    if (capture && take) startConvert(capture.zone, take, capture.from, capture.to, target);
  };
  captureButton.querySelector('.cb-steps')!.addEventListener('click', fromStretch('steps'));
  captureButton.querySelector('.cb-quantize')!.addEventListener('click', fromStretch('take'));
  const panel = document.querySelector('#trackDock .td-convert')!;
  panel.querySelector('.tdc-grid')!.addEventListener('change', (ev) => {
    if (!conv) return;
    conv.grid = Number((ev.target as HTMLSelectElement).value);
    conv.swing = swingFor(conv.notes, conv.from, conv.grid);
    conv.useSwing = conv.swing > 0;
    recompute();
  });
  panel.querySelectorAll('.tdc-mode [data-mode]').forEach((m) =>
    m.addEventListener('click', () => {
      if (!conv) return;
      conv.drums = (m as HTMLElement).dataset['mode'] === 'drums';
      recompute();
    })
  );
  panel.querySelector('.tdc-swing input')!.addEventListener('change', (ev) => {
    if (!conv) return;
    conv.useSwing = (ev.target as HTMLInputElement).checked;
    recompute();
  });
  panel.querySelectorAll('.tdc-target [data-target]').forEach((m) =>
    m.addEventListener('click', () => {
      if (!conv) return;
      conv.target = (m as HTMLElement).dataset['target'] as 'steps' | 'take';
      recompute();
    })
  );
  panel.querySelector('.tdc-strength')!.addEventListener('input', (ev) => {
    if (!conv) return;
    conv.strength = Number((ev.target as HTMLInputElement).value) / 100;
    recompute();
  });
  panel.querySelector('.tdc-convert')!.addEventListener('click', convert);
  panel.querySelector('.tdc-cancel')!.addEventListener('click', endConvert);
  takeChip = document.createElement('div');
  takeChip.className = 'track-takes track-chip';
  takeChip.title = 'Drag over bars of the take to loop them or turn them into steps';
  takeChip.innerHTML =
    '<a class="tc-prev lightButton" title="An earlier take">‹</a>' +
    '<a class="tc-label lightButton" title="Choose from all takes"></a>' +
    '<a class="tc-next lightButton" title="A later take">›</a>' +
    '<a class="tc-keep lightButton" title="This take becomes the zone’s loop in this arrangement, replacing its loop">Loop</a>' +
    '<a class="tc-quantize lightButton" title="Quantize this take">Quantize</a>' +
    '<a class="tc-steps lightButton" title="Turn this take into steps">To steps</a>' +
    '<a class="tc-delete lightButton" title="Delete this take (⌘Z brings it back)">Delete</a>';
  const fromShown = (target: 'steps' | 'take') => (): void => {
    const zone = getZones()[selected];
    const take = zone && shownTake(zone)?.take;
    if (take) startConvert(zone, take, take.start, take.end, target);
  };
  takeChip.querySelector('.tc-steps')!.addEventListener('click', fromShown('steps'));
  takeChip.querySelector('.tc-quantize')!.addEventListener('click', fromShown('take'));
  takeChip.addEventListener('mousedown', (ev) => ev.stopPropagation());
  takeChip.querySelector('.tc-prev')!.addEventListener('click', () => browseTakes(-1));
  takeChip.querySelector('.tc-next')!.addEventListener('click', () => browseTakes(1));
  takeChip.querySelector('.tc-keep')!.addEventListener('click', () => {
    const zone = getZones()[selected];
    const shown = zone && shownTake(zone);
    if (shown) keepTake(zone, shown.take);
  });
  takeChip.querySelector('.tc-label')!.addEventListener('click', (ev) => {
    ev.stopPropagation();
    const zone = getZones()[selected];
    if (zone) openTakeMenu(zone, ev.currentTarget as HTMLElement);
  });
  takeChip.querySelector('.tc-delete')!.addEventListener('click', () => {
    const zone = getZones()[selected];
    const shown = zone && shownTake(zone);
    if (!shown || timeline.running) return;
    deleteTake(selected, shown.take);
    clearCapture();
    invalidate();
  });
  loopChip = document.createElement('div');
  loopChip.className = 'track-loop track-chip';
  loopChip.innerHTML =
    '<span class="lc-label"></span>' +
    '<a class="lc-less lightButton" title="One bar shorter: the last bar is set aside (+ bar brings it back)">− bar</a>' +
    '<a class="lc-more lightButton" title="One bar longer: brings back a bar set aside, else an empty one">+ bar</a>' +
    '<a class="lc-mpe lightButton" title="Play the MPE recorded with the loop (each note\'s bend, slide and pressure) on/off">MPE</a>' +
    '<a class="lc-clear lightButton" title="Clear the loop (⌘Z brings it back)">Clear</a>';
  loopChip.addEventListener('mousedown', (ev) => ev.stopPropagation());
  const onLoop = (f: (zone: Zone, loop: Take) => void) => (): void => {
    const zone = getZones()[selected];
    if (zone?.loop) f(zone, zone.loop);
  };
  loopChip.querySelector('.lc-less')!.addEventListener('click', onLoop((z, l) => setLoopBars(z, 0, l.length - barLen(), 'Loop Length')));
  loopChip.querySelector('.lc-more')!.addEventListener('click', onLoop((z, l) => setLoopBars(z, 0, l.length + barLen(), 'Loop Length')));
  loopChip.querySelector('.lc-clear')!.addEventListener('click', onLoop((z) => clearLoop(z)));
  loopChip.querySelector('.lc-mpe')!.addEventListener(
    'click',
    onLoop((z) => {
      const index = getZones().indexOf(z);
      if (index >= 0) commit(index, 'Loop MPE On/Off', () => (z.loopMpe = !z.loopMpe));
      invalidate();
    })
  );
  // the cards' loop strips
  zonesEl.addEventListener('click', (ev) => {
    const button = (ev.target as Element).closest('.card-loop [data-cl]') as HTMLElement | null;
    const zone = button && getZones()[zoneIndexOf(button)];
    if (!button || !zone?.loop || button.classList.contains('disabled')) return;
    const act = button.dataset['cl'];
    const len = zone.loop.length;
    if (act === 'less') setLoopBars(zone, 0, len - barLen(), 'Loop Length');
    else if (act === 'more') setLoopBars(zone, 0, len + barLen(), 'Loop Length');
    else if (act === 'clear') clearLoop(zone);
    else if (act === 'takes') zone.looper.lastRun = null;
    invalidate();
  });
  // the cards' takes strips
  zonesEl.addEventListener('click', (ev) => {
    const button = (ev.target as Element).closest('.card-takes [data-ct]') as HTMLElement | null;
    const zone = button && getZones()[zoneIndexOf(button)];
    if (!button || !zone || button.classList.contains('disabled')) return;
    const act = button.dataset['ct'];
    if (act === 'keep') {
      const take = takeStore.shownTake(zone.id);
      // done with it: the strip goes until the next take
      if (take && keepTake(zone, take)) dismissCardTakes(zone);
    } else if (act === 'discard') {
      dismissCardTakes(zone);
    } else {
      takeStore.browse(zone.id, act === 'prev' ? 1 : -1);
      clearCapture();
      invalidate();
    }
  });

  zonesEl.addEventListener('mousedown', (ev) => {
    if (!isActive() || ev.button !== 0) return;
    const lane = (ev.target as Element).closest('.track-lane');
    const zone = getZones()[zoneIndexOf(lane)];
    if (!lane || !zone || (ev.target as Element).closest('.track-strip')) return;
    // no text selection; a field being typed in still commits its value (on blur)
    ev.preventDefault();
    (document.activeElement as HTMLElement | null)?.blur();
    // the take lane: bars of the shown take (a click picks it)
    if (inTakeLane(zone, lane, ev.clientY)) {
      if (!timeline.running) startCaptureDrag(ev, lane, zone);
      return;
    }
    // the loop's block: its edges drag by bars, a click picks it
    const block = loopBlocks.get(zone);
    const edge = loopEdgeAt(zone, lane, ev.clientX, ev.clientY);
    if (edge && block) {
      startLoopEdgeDrag(ev, zone, edge, block.barPx);
      return;
    }
    const canvas = lane.querySelector('canvas');
    if (block && canvas && ev.clientX - canvas.getBoundingClientRect().left >= block.x0) {
      pick(zone, 'loop');
      return;
    }
    clearCapture();
  });
  // over the loop's edges the pointer says they drag
  zonesEl.addEventListener('mousemove', (ev) => {
    if (!isActive() || loopDrag) return;
    const lane = (ev.target as Element).closest('.track-lane');
    const canvas = lane?.querySelector('canvas');
    const zone = getZones()[zoneIndexOf(lane)];
    if (!lane || !canvas || !zone) return;
    const resize = !(ev.target as Element).closest('.track-strip') && loopEdgeAt(zone, lane, ev.clientX, ev.clientY) !== null;
    canvas.style.cursor = resize ? 'ew-resize' : '';
  });
  document.addEventListener('keydown', (ev) => {
    if (capture && ev.key === 'Escape') clearCapture();
    if (conv && ev.key === 'Escape') endConvert();
  });
  // Horizontal wheel or trackpad (or Shift + wheel) over the lanes or the ruler scrolls the song
  const scrollable = (target: EventTarget | null): boolean =>
    !!(target as Element | null)?.closest?.('.track-lane, #trackRuler canvas');
  document.addEventListener(
    'wheel',
    (ev) => {
      if (!isActive() || !scrollable(ev.target)) return;
      const dx = ev.deltaX !== 0 ? ev.deltaX : ev.shiftKey ? ev.deltaY : 0;
      if (dx === 0) return;
      ev.preventDefault();
      scrollBy(dx);
    },
    { passive: false }
  );
  document.querySelector('#trackRuler .tr-follow')?.addEventListener('click', () => {
    follow = true;
    invalidate();
  });
  // Any press on a track selects it
  zonesEl.addEventListener(
    'mousedown',
    (ev) => {
      if (!isActive()) return;
      const index = zoneIndexOf(ev.target as Element);
      if (index >= 0) select(index);
    },
    true
  );
  // Seq and Arp switch the feature and show it below; CC only shows the controllers
  zonesEl.addEventListener(
    'click',
    (ev) => {
      if (!isActive()) return;
      const chip = (ev.target as Element).closest('.channels .ch');
      if (!chip) return;
      if (chip.classList.contains('showccs')) {
        ev.stopPropagation();
        setTab('cc');
      } else if (chip.classList.contains('showseq')) {
        setTab('seq');
      } else if (chip.classList.contains('showarp')) {
        setTab('arp');
      }
    },
    true
  );
  zonesEl.addEventListener('dblclick', (ev) => {
    if (!isActive()) return;
    const lane = (ev.target as Element).closest('.track-lane');
    const index = zoneIndexOf(lane);
    if (index < 0 || (ev.target as Element).closest('.track-strip')) return;
    const zone = getZones()[index];
    // the take lane: the shown take's notes in the Notes tab
    if (zone && inTakeLane(zone, lane!, ev.clientY)) {
      const shown = shownTake(zone);
      if (shown) editTake(zone, shown.take);
      return;
    }
    // the song: the sequence (piano roll or the Sequencer tab), or the loop's notes
    const steps = zone?.sequence.active && !zone.sequence.isDrumSequence;
    const pianoRoll = zone?.elements.zoneElement?.querySelector(
      '[data-action$=":seq_open_piano_roll"]'
    ) as HTMLElement | null;
    if (steps && pianoRoll) pianoRoll.click();
    else if (zone?.loop && !zone.sequence.active) editTake(zone, null);
    else setTab('seq');
  });
  const dock = document.getElementById('trackDock')!;
  dock.querySelectorAll('.td-tab').forEach((t) => {
    // a tab only selects; folding is the chevron's (or a double-click on the bar)
    t.addEventListener('click', () => setTab((t as HTMLElement).dataset['tab'] as DockTab));
  });
  dock.querySelector('.td-collapse')!.addEventListener('click', () => setDockOpen(!dockOpen));
  const bar = dock.querySelector('.td-bar')!;
  bar.addEventListener('dblclick', (e) => {
    if (e.target === bar) setDockOpen(!dockOpen);
  });
  const resize = dock.querySelector('.td-resize') as HTMLElement;
  resize.addEventListener('mousedown', startDockResize);
  resize.addEventListener('dblclick', () => setDockHeight(null));
  const savedHeight = Number(localStorage.getItem(DOCK_HEIGHT_KEY));
  if (savedHeight >= DOCK_MIN_H) document.body.style.setProperty('--dock-open-h', `${savedHeight}px`);
  dock.querySelector('.td-turn-on')!.addEventListener('click', turnOnFeature);
  document.querySelectorAll('#trackRuler [data-zoom]').forEach((b) => {
    b.addEventListener('click', () => {
      zoomIndex = Math.max(0, Math.min(ZOOMS.length - 1, zoomIndex + Number((b as HTMLElement).dataset['zoom'])));
      localStorage.setItem(ZOOM_KEY, String(ZOOMS[zoomIndex]));
      invalidate();
    });
  });
  window.addEventListener(ZONES_CHANGED_EVENT, invalidate);
  window.addEventListener(UPDATE_ZONE_VIEW_EVENT, invalidate);
  window.addEventListener('resize', invalidate);
  // mini view on and off
  new MutationObserver(invalidate).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  initTakeEditor({
    zones: getZones,
    target: editedTake,
    commit: (index, label, change) => commit(index, label, change),
    commitTake: (index, take, label, change) => commitTake(index, take, label, change),
    loopFrom: loopFromTake,
    show: (kind) => {
      const zone = getZones()[selected];
      if (!zone) return;
      if (kind === 'loop') {
        if (zone.loop) editing = { zoneId: zone.id, kind: 'loop' };
        else toast('No loop in this arrangement yet: record one with Rec, or loop a take');
      } else {
        const shown = takeStore.shownTake(zone.id);
        if (shown) editing = { zoneId: zone.id, kind: 'take', take: shown };
        else toast(`No takes yet. ${TAKE_HINT}`);
      }
      invalidate();
    },
    invalidate
  });
  applyBodyState();
}

export { initTrackView, isTrackView, setTrackView, followTrack, invalidate as invalidateTrackView, updateLoopChips, keepTake };
