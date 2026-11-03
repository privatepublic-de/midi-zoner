import { Zone } from '../zone/zone-class';
import { ZONES_CHANGED_EVENT, UPDATE_ZONE_VIEW_EVENT } from '../zone/interfaces';
import { timeline, sessionNow, songNow, songAt, passAt, nowTick, timelineLoop, timelineMeter, countInNow, NoteHistory } from '../timeline';
import { Meter, DEFAULT_METER, barTicks, beatOffsets, beatLines, snapToBeat, positionLabel, meterLabel, sameMeter } from '../meter';
import type { SceneLoop } from './types';
import { Take } from '../zone/take';
import { DIV_TICKS } from '../zone/seq-layer';
import { analyse, quantize, quantizeStarts, applyToSequence, swingFor, stepPos, DIV_NAMES, PlayedNote, Quantized } from '../zone/take-quantize';
import { toast } from './toast';

/**
 * Track view: each zone is a row with its header on the left and a lane that scrolls
 * under a fixed playhead. Behind the playhead the lane shows what the zone sent
 * (Zone.noteHistory), ahead of it the sequence as it will repeat. The selected
 * track's sequencer, arp, controllers and zone settings show in the dock below;
 * they stay in the zone element and are only placed there by CSS (body[data-dock]).
 */

type DockTab = 'seq' | 'arp' | 'cc' | 'zone';

const VIEW_KEY = 'viewMode';
const TAB_KEY = 'trackDockTab';
const DOCK_OPEN_KEY = 'trackDockOpen';
const ZOOM_KEY = 'trackZoom';
const DOCK_HEIGHT_KEY = 'trackDockHeight';
const DOCK_MIN_H = 120;
const ZOOMS = [0.5, 1, 2, 4]; // px per clock tick; at 2 a 1/16 step is 12px, a bar 192px
const PLAYHEAD_AT = 0.3; // share of the lane width behind the playhead
const LANE_PAD = 6;
const DIM_TEXT = '#8b95a3';
const STOPPED_REDRAW_MS = 500;

let getZones: () => Zone[] = () => [];
let trackView = localStorage.getItem(VIEW_KEY) === 'tracks';
let selected = 0;
// The selected zone's note history: undo hands it to the zone object that replaces
// it (Zone.adoptHistory), so the selection stays with that zone wherever it is now
let selectedHistory: NoteHistory | null = null;
let tab: DockTab = (['seq', 'arp', 'cc', 'zone'] as DockTab[]).includes(
  localStorage.getItem(TAB_KEY) as DockTab
)
  ? (localStorage.getItem(TAB_KEY) as DockTab)
  : 'seq';
let dockOpen = localStorage.getItem(DOCK_OPEN_KEY) !== '0';
let zoomIndex = ZOOMS.indexOf(Number(localStorage.getItem(ZOOM_KEY)));
if (zoomIndex < 0) zoomIndex = 2;
let dirty = true;
let frame = 0;
// The current arrangement's loop range (set by the controller), and one being dragged on the ruler
let loops: { get: () => SceneLoop | null; set: (loop: SceneLoop | null, label: string) => void } = {
  get: () => null,
  set: () => {}
};
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

/** The shortest beat of the meter (a quarter in x/4) */
function shortestBeat(): number {
  const lines = [...beatOffsets(timeline.meter), barLen()];
  return Math.min(...lines.slice(1).map((l, i) => l - lines[i]));
}

/** Snap a song position: beats, whole bars with Shift, free with Alt/Option */
function snapWith(t: number, e: { shiftKey: boolean; altKey: boolean }, how: 'round' | 'floor' | 'ceil' = 'round'): number {
  if (e.altKey) return Math[how](t);
  return snapToBeat(timeline.meter, t, e.shiftKey, how);
}

/** The shortest length a drag can give: a tick, a bar with Shift, else the shortest beat */
function snapMin(e: { shiftKey: boolean; altKey: boolean }): number {
  return e.altKey ? 1 : e.shiftKey ? barLen() : shortestBeat();
}
let loopDrag: { from: number; to: number } | null = null;
// Changes to a zone that are undo steps (set by the controller)
let commit: (zoneIndex: number, label: string, change: () => void) => void = (_i, _l, change) => change();
// The last frame's view, to turn a mouse position on a lane into a song position
const view = { head: 0, ppt: 1, scrollPx: 0 };
// Following the playhead, or scrolled through the song: then this song position
// stays where the playhead normally is (a wheel or trackpad scrolls, Follow returns)
let follow = true;
let pinnedAt = 0;
// A stretch of the shown take to keep, in song positions
let capture: { zone: Zone; from: number; to: number } | null = null;
let captureButton: HTMLElement;
let takeChip: HTMLElement;
// After Stop, kept takes are edited in the lanes: the selected one, and one being dragged
// (moved, also onto another zone's lane, or trimmed at an edge), shown as a preview
let takeSel: { zone: Zone; take: Take } | null = null;
let takeDrag: {
  zone: Zone;
  take: Take;
  mode: 'move' | 'start' | 'end';
  start: number;
  length: number;
  offset: number;
  target: Zone;
} | null = null;
const EDGE_PX = 6;
let keptChip: HTMLElement;
// Turning a take (or a stretch of it) into steps: the preview, set in the dock panel
let conv: {
  zone: Zone;
  take: Take;
  kept: boolean; // a kept take is quantized in place, otherwise the result is kept
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

/** Something changed: redraw on the next frame (also restarts the loop) */
function invalidate(): void {
  dirty = true;
  if (!frame && isActive()) frame = requestAnimationFrame(loop);
}

function loop(now: number): void {
  frame = 0;
  if (!isActive()) return;
  if (timeline.running || timeline.countIn !== null || dirty || now - lastDraw > STOPPED_REDRAW_MS) {
    draw();
    lastDraw = now;
  }
  frame = requestAnimationFrame(loop);
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
  const startH = dockOpen ? dock.getBoundingClientRect().height : DOCK_MIN_H;
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
  dock.querySelectorAll('.td-tab').forEach((t) => {
    t.classList.toggle('active', dockOpen && (t as HTMLElement).dataset['tab'] === tab);
  });
  // An off feature: say so, with a button that switches it on in the track header
  let empty = '';
  let turnOn = '';
  if (tab === 'seq' && !zone.sequence.active) {
    empty = 'The sequencer of this track is off.';
    turnOn = 'Turn on';
  } else if (tab === 'arp' && !zone.arp_enabled) {
    empty = 'The arpeggiator of this track is off.';
    turnOn = 'Turn on';
  }
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
  if (seq.active || zone.takes.length > 0 || zone.takeList.length > 0) return 80;
  return 56;
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
  validateTakeSelection(zones);
  if (conv && (timeline.running || !zones.includes(conv.zone))) endConvert();
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
  // Stopped, the playhead waits at bar 1.
  // the loop of the arrangement shown (also while stopped: Start begins at its start)
  const loop = loops.get();
  timelineLoop(loop?.on ? { from: loop.from, to: loop.to } : null);
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
  drawRuler(songHead, ppt, scrollPx, loop);
  document.querySelector('#trackRuler .tr-loop')?.classList.toggle('active', !!loop?.on);
  zones.forEach((z, i) => drawLane(z, i === selected, songHead, runToSong, ppt, scrollPx));
  if (!zones[selected]) takeChip.remove();
}

/** The latest take of the zone's arrangement, or the one browsed back to */
function shownTake(zone: Zone): { take: Take; number: number; count: number } | null {
  const list = zone.arrangementTakes;
  if (list.length === 0) return null;
  const back = Math.min(zone.shownTake, list.length - 1);
  return { take: list[list.length - 1 - back], number: list.length - back, count: list.length };
}

/** The song's extent: up to the end of the last take of any zone, at least where the playhead is */
function songExtent(): number {
  let end = view.head;
  for (const z of getZones()) {
    for (const t of z.takes) end = Math.max(end, t.end);
    const shown = shownTake(z);
    if (shown) end = Math.max(end, shown.take.end);
  }
  return end;
}

/** Scroll through the song, back to bar 1 or on to its end (Follow returns to the playhead) */
function scrollBy(px: number): void {
  pinnedAt = Math.max(0, Math.min(songExtent(), (follow ? view.head : pinnedAt) + px / view.ppt));
  follow = false;
  invalidate();
}

function drawRuler(songHead: number, ppt: number, scrollPx: number, loop: SceneLoop | null): void {
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
  // the loop range: a bar along the top, lit while on (dragged: the new range)
  const range = loopDrag ?? loop;
  if (range) {
    const x0 = headX + (range.from - songHead) * ppt;
    const x1 = headX + (range.to - songHead) * ppt;
    g.globalAlpha = loopDrag || loop?.on ? 1 : 0.35;
    g.fillStyle = '#cfd6df';
    g.fillRect(x0, 0, x1 - x0, 5);
    g.fillRect(x0, 0, 1, h);
    g.fillRect(x1 - 1, 0, 1, h);
    g.globalAlpha = 1;
  }
  g.font = '11px "Barlow Semi Condensed", sans-serif';
  // bars apart, so numbers don't touch
  const labelEvery = Math.max(1, Math.ceil(60 / (barLen() * ppt)));
  for (const { t: s, bar } of beatLines(timeline.meter, Math.max(0, songHead - headX / ppt), songHead + (w - headX) / ppt)) {
    const x = Math.round(headX + (s - songHead) * ppt);
    const barNo = Math.round(s / barLen());
    g.fillStyle = s === 0 ? '#e7eaee' : bar ? DIM_TEXT : '#4a525d';
    g.fillRect(x, bar ? h - 14 : h - 6, 1, bar ? 14 : 6);
    // clear of the playhead mark
    if (bar && barNo % labelEvery === 0 && Math.abs(x - headX) > 8) g.fillText(String(barNo + 1), x + 4, h - 5);
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
  scrollPx: number
): void {
  const el = zone.elements.zoneElement;
  if (!el) return;
  const height = `${laneHeight(zone)}px`;
  if (el.style.getPropertyValue('--track-h') !== height) el.style.setProperty('--track-h', height);
  const p = prepare(el.querySelector('.track-lane canvas'));
  if (!p) return;
  const [g, w, h] = p;
  // where the playhead is: its place, or elsewhere while scrolled
  const headX = Math.round(w * PLAYHEAD_AT) + scrollPx;
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
  const drums = seq.active && seq.isDrumSequence;
  const running = timeline.running;

  // beats and bars of the song
  for (const { t: s, bar } of beatLines(timeline.meter, Math.max(0, songHead - headX / ppt), songHead + (w - headX) / ppt)) {
    const gx = Math.round(x(s));
    g.fillStyle = s === 0 ? '#ffffff40' : bar ? '#ffffff1c' : '#ffffff0a';
    g.fillRect(gx, 0, 1, h);
  }

  // the loop range while on: outside it a shade darker
  const loop = timeline.loop;
  if (loop) {
    g.globalAlpha = 1;
    g.fillStyle = '#00000038';
    g.fillRect(0, 0, Math.max(0, x(loop.from)), h);
    g.fillRect(Math.min(w, x(loop.to)), 0, w, h);
  }

  // what this section sent while running, in this pass of the loop (session positions → song)
  const sectionAt = timeline.runStart + timeline.sectionStart;
  const elapsedNow = running ? nowTick() - timeline.sectionStart : 0;
  const passNow = passAt(elapsedNow);
  const songOf = (session: number): number => songAt(session - sectionAt);
  const inPass = (n: { start: number }): boolean => n.start >= sectionAt && passAt(n.start - sectionAt) === passNow;
  // the pass began this long ago (session positions), at most the view's width back
  const passFrom = sessionNow() - Math.min(elapsedNow, (headX + 8) / ppt);
  const heldHistory = drums ? null : syncHeld(zone);
  const history = running ? zone.noteHistory.between(passFrom, sessionNow() + 1).filter(inPass) : [];
  const held = running && heldHistory ? heldHistory.between(passFrom, sessionNow() + 1).filter(inPass) : [];
  const shown = shownTake(zone);
  const latest = shown?.take ?? null;

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
    if (seq.active) {
      for (let s = 0; s < seq.length; s++) seq.steps[s]?.notesArray.forEach((n) => take(n.number));
    }
    for (const t of zone.takes) t.notes.forEach((n) => take(n.n));
    latest?.notes.forEach((n) => take(n.n));
    if (takeDrag?.target === zone) takeDrag.take.notes.forEach((n) => take(n.n));
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
  const rowY = (row: number): number => LANE_PAD + row * rowH + (rowH - noteH) / 2;

  // a note at song positions; ghost: dashed (won't play), faint: an unkept take
  const note = (s0: number, s1: number, row: number, velo: number, ghost: boolean, alpha = 1): void => {
    if (row < 0) return;
    const x0 = x(s0);
    const x1 = x(s1);
    if (x1 < 0 || x0 > w) return;
    const y = rowY(row);
    const width = Math.max(2, x1 - x0 - 1);
    g.globalAlpha = (silent ? 0.3 : 0.45 + (0.55 * velo) / 127) * alpha;
    if (ghost) {
      // a step that won't play this time (condition, chance, muted lane)
      g.globalAlpha *= 0.6;
      g.strokeStyle = colour;
      g.setLineDash([2, 2]);
      g.strokeRect(x0 + 0.5, y + 0.5, width - 1, noteH - 1);
      g.setLineDash([]);
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

  // takes: kept ones are the song (solid), the latest unkept one faint in a dashed frame;
  // a selected kept take has a light frame, one being dragged stays as a ghost
  const drawTake = (take: Take, kept: boolean, state: 'normal' | 'selected' | 'ghost' = 'normal'): void => {
    const x0 = x(take.start);
    const x1 = x(take.end);
    if (x1 < 0 || x0 > w) return;
    // a ghost while dragged; kept takes of a zone whose Tk is off are faded (silent)
    const ghost = state === 'ghost' ? 0.3 : kept && !zone.takes_on ? 0.4 : 1;
    g.globalAlpha = (kept ? 0.12 : 1) * ghost;
    g.fillStyle = kept ? colour : '#ffffff08';
    g.fillRect(x0, 1, x1 - x0, h - 2);
    g.strokeStyle = state === 'selected' ? '#e7eaee' : kept ? colour : '#e7eaee66';
    g.lineWidth = state === 'selected' ? 2 : 1;
    g.globalAlpha = (state === 'selected' ? 1 : kept ? 0.6 : 1) * ghost;
    if (!kept) g.setLineDash([3, 3]);
    g.strokeRect(Math.round(x0) + 0.5, 1.5, Math.round(x1 - x0) - 1, h - 3);
    g.setLineDash([]);
    g.lineWidth = 1;
    for (const n of take.visibleNotes()) {
      if (x(n.s) > w) break;
      note(n.s, n.s + n.d, rowOf(n.n), n.v, false, (kept ? 1 : 0.45) * ghost);
    }
  };
  for (const t of zone.takes) {
    drawTake(t, true, takeDrag?.take === t ? 'ghost' : takeSel?.take === t ? 'selected' : 'normal');
  }
  if (latest && !running) drawTake(latest, false);
  if (takeDrag?.target === zone) drawTake(dragPreview(takeDrag), true, 'selected');

  // the notes the arp plays from: a band behind its notes, fading out ahead while still held
  const bandH = Math.max(noteH + 2, Math.min(rowH, noteH + 4));
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
  if (seq.active) {
    const ticks = seq.ticks;
    const MAX_STEPS_AHEAD = 4096;
    const ahead = (lane: number, cur: number, each: (s: number, step: number, plays: boolean) => void): void => {
      const base = stepStart(cur, ticks, runHead);
      let k = 1;
      for (const next of seq.upcoming(lane)) {
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
            note(rs, rs + Math.max(1, (hits > 1 ? step.ratchetResolution : ticks) * 0.6), ln, velo, !plays);
          }
        });
      }
    } else if (seq.length > 0) {
      ahead(-1, seq.currentStepNumber, (s, st, plays) => {
        if (st === 0) {
          // where each repeat begins
          g.globalAlpha = silent ? 0.2 : 0.45;
          g.fillStyle = colour;
          g.fillRect(Math.round(x(s)), 0, 1, h);
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
              note(rs, rs + Math.max(1, step.ratchetResolution - 1), rowOf(n.number), n.velo, !plays);
            }
          } else {
            note(s, s + dur, rowOf(n.number), n.velo, !plays);
          }
        }
      });
    }
    const label = drums
      ? `${rows} lanes · ${seq.length} × ${divisionName(zone)}`
      : `${seq.length} × ${divisionName(zone)}`;
    g.font = '10px "Barlow Semi Condensed", sans-serif';
    const labelW = g.measureText(label).width;
    g.globalAlpha = 0.85;
    g.fillStyle = '#15171a';
    g.fillRect(w - labelW - 10, 1, labelW + 8, 13);
    g.fillStyle = DIM_TEXT;
    g.fillText(label, w - labelW - 6, 11);
  }

  // the past a shade darker while running, then the playhead
  g.globalAlpha = 1;
  if (running) {
    g.fillStyle = '#0000002e';
    g.fillRect(0, 0, Math.max(0, Math.min(w, headX)), h);
  }
  g.fillStyle = '#e7eaeecc';
  if (headX >= 0 && headX <= w) g.fillRect(headX, 0, 1, h);

  if (conv?.zone === zone) drawConversion(g, x, rowOf, rowY, noteH, w, h);
  if (capture?.zone === zone) drawCapture(g, el, x(capture.from), x(capture.to), w, h);
  if (isSelected) placeTakeChip(el, shown, latest && !running && !conv ? x(latest.start) : null, w);
  if (isSelected) {
    const kept = takeSel?.zone === zone && !running && !takeDrag && !conv ? takeSel.take : null;
    placeChip(keptChip, el, kept ? x(kept.start) + 4 : null, w, 4);
  }
}

/** The steps a conversion would make: boxes on the grid, a line from each played note to its step */
function drawConversion(
  g: CanvasRenderingContext2D,
  x: (s: number) => number,
  rowOf: (pitch: number) => number,
  rowY: (row: number) => number,
  noteH: number,
  w: number,
  h: number
): void {
  const c = conv!;
  const ticks = DIV_TICKS[c.grid];
  g.globalAlpha = 1;
  // outside the stretch, darker
  g.fillStyle = '#00000059';
  g.fillRect(0, 0, Math.max(0, x(c.from)), h);
  g.fillRect(Math.min(w, x(c.to)), 0, w, h);
  // the grid's steps
  g.fillStyle = '#e7eaee14';
  for (let i = 0; i < c.q.steps && i < c.q.max; i++) {
    const sx = x(c.from + stepPos(i, ticks, c.swing));
    if (sx > w) break;
    if (sx >= 0) g.fillRect(Math.round(sx), 0, 1, h);
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

/** A floating chip on a lane at x (hidden with null) */
function placeChip(chip: HTMLElement, zoneEl: HTMLElement, at: number | null, w: number, top: number): void {
  if (at === null) {
    chip.remove();
    return;
  }
  const lane = zoneEl.querySelector('.track-lane')!;
  if (chip.parentElement !== lane) {
    lane.appendChild(chip);
    invalidate(); // placed by its width, known from the next frame
  }
  chip.style.left = `${Math.max(4, Math.min(w - chip.offsetWidth - 4, at))}px`;
  chip.style.top = `${top}px`;
}

/** On the selected track: browse its unkept takes (‹ ›) and keep the one shown */
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
  const lane = zoneEl.querySelector('.track-lane')!;
  if (takeChip.parentElement !== lane) {
    lane.appendChild(takeChip);
    invalidate(); // placed by its width, known from the next frame
  }
  const label = `Take ${shown.number}/${shown.count} · ${Take.lengthLabel(shown.take.length, timeline.meter)}`;
  const labelEl = takeChip.querySelector('.tc-label')!;
  if (labelEl.textContent !== label) labelEl.textContent = label;
  takeChip.querySelector('.tc-prev')!.classList.toggle('off', shown.number <= 1);
  takeChip.querySelector('.tc-next')!.classList.toggle('off', shown.number >= shown.count);
  takeChip.style.left = `${Math.max(4, Math.min(w - takeChip.offsetWidth - 4, takeX + 4))}px`;
}

/** The stretch picked for keeping, and its Keep button at its end */
function drawCapture(g: CanvasRenderingContext2D, zoneEl: HTMLElement, x0: number, x1: number, w: number, h: number): void {
  const lane = zoneEl.querySelector('.track-lane')!;
  if (x1 < 0 || x0 > w) {
    captureButton.remove(); // scrolled out of view; still picked
    return;
  }
  g.globalAlpha = 1;
  g.fillStyle = '#e7eaee1a';
  g.fillRect(x0, 0, x1 - x0, h);
  g.fillStyle = '#e7eaeeb3';
  g.fillRect(Math.round(x0), 0, 1, h);
  g.fillRect(Math.round(x1) - 1, 0, 1, h);
  if (captureButton.parentElement !== lane) {
    lane.appendChild(captureButton);
    invalidate(); // placed by its width, known from the next frame
  }
  const text = `Keep · ${Take.lengthLabel(capture!.to - capture!.from, timeline.meter)}`;
  const keepLink = captureButton.querySelector('.cb-keep')!;
  if (keepLink.textContent !== text) keepLink.textContent = text;
  captureButton.style.left = `${Math.max(4, Math.min(w - captureButton.offsetWidth - 4, x1 - captureButton.offsetWidth - 4))}px`;
  captureButton.style.top = '28px';
}

function clearCapture(): void {
  capture = null;
  captureButton?.remove();
  invalidate();
}

/** Song position under a mouse x on a lane */
function laneTick(lane: Element, clientX: number): number {
  const rect = lane.getBoundingClientRect();
  const headX = Math.round(rect.width * PLAYHEAD_AT) + view.scrollPx;
  return view.head + (clientX - rect.left - headX) / view.ppt;
}

/** After Stop, drag over the shown take: a stretch of it to keep */
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
    // beats, whole bars with Shift, free (to the tick) with Alt/Option; within the take
    const from = Math.max(take.start, snapWith(Math.min(start, end), e, 'floor'));
    const to = Math.min(take.end, Math.max(from + snapMin(e), snapWith(Math.max(start, end), e, 'ceil')));
    if (to <= from) return;
    capture = { zone, from, to };
    invalidate();
  };
  const up = (): void => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    if (!dragging) clearCapture();
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

/** The dragged take as it would be dropped */
function dragPreview(drag: NonNullable<typeof takeDrag>): Take {
  const preview = drag.take.copy();
  preview.start = drag.start;
  preview.length = drag.length;
  preview.offset = drag.offset;
  return preview;
}

/** Undo replaces zones and takes: keep the selection on the take with the same id */
function validateTakeSelection(zones: Zone[]): void {
  if (!takeSel) return;
  if (timeline.running) {
    takeSel = null;
    return;
  }
  if (zones.includes(takeSel.zone) && takeSel.zone.takes.includes(takeSel.take)) return;
  const id = takeSel.take.id;
  takeSel = null;
  for (const zone of zones) {
    const take = zone.takes.find((t) => t.id === id);
    if (take) takeSel = { zone, take };
  }
}

/** The kept take under a mouse x on a lane (the last drawn wins), and whether at an edge */
function takeAt(zone: Zone, lane: Element, clientX: number): { take: Take; edge: 'start' | 'end' | null } | null {
  const s = laneTick(lane, clientX);
  const edge = EDGE_PX / view.ppt;
  for (let i = zone.takes.length - 1; i >= 0; i--) {
    const take = zone.takes[i];
    if (s < take.start - edge || s > take.end + edge) continue;
    if (Math.abs(s - take.start) <= edge) return { take, edge: 'start' };
    if (Math.abs(s - take.end) <= edge) return { take, edge: 'end' };
    if (s >= take.start && s < take.end) return { take, edge: null };
  }
  return null;
}


/** Drag a kept take: its body moves it (also to another zone's lane), an edge trims it */
function startTakeDrag(ev: MouseEvent, lane: Element, zone: Zone, take: Take, edge: 'start' | 'end' | null): void {
  const startX = ev.clientX;
  const startY = ev.clientY;
  const down = laneTick(lane, startX);
  const mode = edge ?? 'move';
  const move = (e: MouseEvent): void => {
    if (!takeDrag && Math.abs(e.clientX - startX) < 3 && Math.abs(e.clientY - startY) < 3) return;
    const s = laneTick(lane, e.clientX);
    const min = snapMin(e);
    let { start, length, offset } = take;
    let target = zone;
    if (mode === 'move') {
      start = Math.max(0, snapWith(take.start + s - down, e));
      const over = (document.elementFromPoint(e.clientX, e.clientY) as Element | null)?.closest('#zones > .zone[id^="zone"]');
      const index = over ? parseInt(over.id.slice(4)) : -1;
      target = getZones()[index] ?? zone;
    } else if (mode === 'start') {
      start = Math.max(0, Math.min(take.end - min, snapWith(s, e)));
      offset = take.offset + (start - take.start);
      length = take.end - start;
    } else {
      length = Math.max(min, Math.min(Take.MAX_LENGTH, snapWith(s, e) - take.start));
    }
    takeDrag = { zone, take, mode, start, length, offset, target };
    invalidate();
  };
  const up = (): void => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    const drag = takeDrag;
    takeDrag = null;
    invalidate();
    if (!drag) return;
    const index = getZones().indexOf(drag.zone);
    const other = drag.target !== drag.zone;
    const unchanged = !other && drag.start === take.start && drag.length === take.length && drag.offset === take.offset;
    if (index < 0 || unchanged) return;
    const label = other
      ? `Move Take to ${drag.target.label || `Zone ${getZones().indexOf(drag.target) + 1}`}`
      : drag.mode === 'move'
        ? 'Move Take'
        : 'Trim Take';
    commit(index, label, () => {
      take.start = drag.start;
      take.length = drag.length;
      take.offset = drag.offset;
      if (other) {
        drag.zone.takes.splice(drag.zone.takes.indexOf(take), 1);
        drag.target.takes.push(take);
      }
      drag.target.takes.sort((a, b) => a.start - b.start);
    });
    takeSel = { zone: drag.target, take };
    if (other) select(getZones().indexOf(drag.target));
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

/** Cut the kept take under the mouse at that (snapped) place */
function cutTake(zone: Zone, take: Take, at: number): void {
  const index = getZones().indexOf(zone);
  if (index < 0 || at <= take.start || at >= take.end) return;
  commit(index, 'Cut Take', () => {
    zone.takes.push(take.cutAt(at));
    zone.takes.sort((a, b) => a.start - b.start);
  });
  takeSel = { zone, take };
}

function deleteSelectedTake(): void {
  if (!takeSel) return;
  const { zone, take } = takeSel;
  const index = getZones().indexOf(zone);
  if (index < 0) return;
  commit(index, 'Delete Take', () => zone.takes.splice(zone.takes.indexOf(take), 1));
  takeSel = null;
}

/** Open the conversion of a take (or a stretch of it) into steps, with its preview */
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
    kept: zone.takes.includes(take) && from === take.start && to === take.end,
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
  takeSel = null;
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
  panel.querySelector('.tdc-what')!.textContent =
    ` · ${Take.lengthLabel(c.to - c.from, timeline.meter)} from bar ${barNumber(c.from)} · ${plural(c.notes.length, 'note')}`;
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
  panel.querySelector('.tdc-strength-value')!.textContent = `${Math.round(c.strength * 100)} %`;
  panel.querySelectorAll('.tdc-mode [data-mode]').forEach((m) => {
    m.classList.toggle('on', ((m as HTMLElement).dataset['mode'] === 'drums') === c.drums);
  });
  const swingRow = panel.querySelector('.tdc-swing') as HTMLElement;
  swingRow.style.display = c.swing > 0 ? '' : 'none';
  (swingRow.querySelector('input') as HTMLInputElement).checked = c.useSwing;
  swingRow.querySelector('span')!.textContent = intoTake
    ? `Keep the swing (${Math.round(c.swing * 100)} %, the off-beats were played late); off: straighten them`
    : `Set the zone's Swing to ${Math.round(c.swing * 100)} % (the off-beats were played late)`;
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
  text += ' The sequencer plays them, Tk switches off; the take stays.';
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
      `${plural(c.notes.length, 'note')} move ${Math.round(c.strength * 100)} % toward ${DIV_NAMES[c.grid]}: ` +
      `${mean} ms on average, at most ${most} ms. Lengths stay. ` +
      (c.kept ? 'The take changes (undo goes back).' : 'The result is kept as a take.');
  }
  const result = panel.querySelector('.tdc-result') as HTMLElement;
  result.textContent = text;
  result.classList.toggle('warn', !intoTake && !q.fits);
  panel.querySelector('.tdc-fit')!.textContent = c.grid === c.suggested ? '' : 'not the detected grid';
  const action = panel.querySelector('.tdc-convert')!;
  action.textContent = intoTake ? (c.kept ? 'Quantize' : 'Keep quantized') : 'Convert';
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
    c.zone.takes_on = false;
  });
  endConvert();
  setTab('seq');
  toast(`${Math.min(c.q.steps, c.q.max)} steps of ${DIV_NAMES[c.grid]} made from the take`);
}

/** Quantize the take in place (a kept one), or keep the quantized stretch or take */
function quantizeTake(): void {
  const c = conv!;
  const index = getZones().indexOf(c.zone);
  if (index < 0) return;
  const moves = new Map<number, number>();
  c.notes.forEach((n, k) => moves.set(n.s, c.starts[k]));
  if (c.kept) {
    commit(index, 'Quantize Take', () => c.take.moveNotes(moves, c.take.start));
    takeSel = { zone: c.zone, take: c.take };
  } else {
    const result = c.take.slice(c.from, c.to);
    result.moveNotes(moves, c.from);
    commit(index, 'Keep Quantized Take', () => c.zone.keepTake(c.take, result));
    takeSel = { zone: c.zone, take: result };
  }
  endConvert();
  toast(`Quantized ${c.notes.length} notes toward ${DIV_NAMES[c.grid]} (${Math.round(c.strength * 100)} %)`);
}

function endConvert(): void {
  conv = null;
  document.body.classList.remove('converting');
  invalidate();
}

/** Drag on the ruler: the loop range (whole bars, beats with Alt/Option), switched on */
function startLoopDrag(ev: MouseEvent): void {
  if (!isActive() || ev.button !== 0) return;
  ev.preventDefault();
  const ruler = ev.currentTarget as Element;
  const start = laneTick(ruler, ev.clientX);
  let moved = false;
  const move = (e: MouseEvent): void => {
    if (!moved && Math.abs(e.clientX - ev.clientX) < 4) return;
    moved = true;
    const end = laneTick(ruler, e.clientX);
    // bars, beats with Alt/Option
    const bars = { shiftKey: !e.altKey, altKey: false };
    const from = Math.max(0, snapWith(Math.min(start, end), bars, 'floor'));
    const to = Math.min(Take.MAX_LENGTH, Math.max(from + snapMin(bars), snapWith(Math.max(start, end), bars, 'ceil')));
    loopDrag = { from, to };
    invalidate();
  };
  const up = (): void => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    const range = loopDrag;
    loopDrag = null;
    invalidate();
    if (range) loops.set({ on: true, from: range.from, to: range.to }, 'Loop Range');
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

/** The Loop button: on and off; without a range yet, the 4 bars from the playhead's bar */
function toggleLoop(): void {
  const loop = loops.get();
  if (loop) {
    loops.set({ ...loop, on: !loop.on }, loop.on ? 'Loop Off' : 'Loop On');
    return;
  }
  const from = (barNumber(Math.max(0, view.head)) - 1) * barLen();
  loops.set({ on: true, from, to: from + 4 * barLen() }, 'Loop On');
}

/** Keep the shown take of the selected track, whole */
function keepShownTake(): void {
  const zone = getZones()[selected];
  const take = zone && shownTake(zone)?.take;
  if (!take) return;
  commit(selected, 'Keep Take', () => zone.keepTake(take));
  toast(`Take kept: ${Take.lengthLabel(take.length, timeline.meter)} from bar ${barNumber(take.start)}`);
}

/** Keep the picked stretch of the shown take */
function keepStretch(): void {
  if (!capture) return;
  const { zone, from, to } = capture;
  const index = getZones().indexOf(zone);
  const take = shownTake(zone)?.take;
  if (index < 0 || !take) return;
  const part = take.slice(from, to);
  if (part.notes.length === 0) {
    toast('Nothing was played there');
    return;
  }
  commit(index, 'Keep Take', () => zone.keepTake(take, part));
  clearCapture();
  toast(`Kept ${Take.lengthLabel(part.length, timeline.meter)} from bar ${barNumber(from)}`);
}

/** Browse the selected track's unkept takes: -1 an older one, +1 a newer one */
function browseTakes(step: number): void {
  const zone = getZones()[selected];
  if (!zone) return;
  const count = zone.arrangementTakes.length;
  zone.shownTake = Math.max(0, Math.min(count - 1, zone.shownTake - step));
  clearCapture();
}

// ---------------------------------------------------------------------------

function initTrackView(
  zones: () => Zone[],
  commitChange: (zoneIndex: number, label: string, change: () => void) => void,
  loopRange: typeof loops,
  meter: () => Meter
): void {
  getZones = zones;
  commit = commitChange;
  loops = loopRange;
  currentMeter = meter;
  const rulerCanvas = document.querySelector('#trackRuler canvas') as HTMLCanvasElement;
  rulerCanvas.addEventListener('mousedown', startLoopDrag);
  document.querySelector('#trackRuler .tr-loop')!.addEventListener('click', toggleLoop);
  const zonesEl = document.getElementById('zones')!;
  captureButton = document.createElement('div');
  captureButton.className = 'track-capture track-chip';
  captureButton.innerHTML =
    '<a class="cb-keep lightButton" title="Keep this stretch of the take: it joins the song (Esc cancels)"></a>' +
    '<a class="cb-quantize lightButton" title="Keep this stretch quantized">Quantize</a>' +
    '<a class="cb-steps lightButton" title="Turn this stretch into steps">To steps</a>';
  captureButton.addEventListener('mousedown', (ev) => ev.stopPropagation());
  captureButton.querySelector('.cb-keep')!.addEventListener('click', keepStretch);
  const fromStretch = (target: 'steps' | 'take') => (): void => {
    const take = capture && shownTake(capture.zone)?.take;
    if (capture && take) startConvert(capture.zone, take, capture.from, capture.to, target);
  };
  captureButton.querySelector('.cb-steps')!.addEventListener('click', fromStretch('steps'));
  captureButton.querySelector('.cb-quantize')!.addEventListener('click', fromStretch('take'));
  keptChip = document.createElement('div');
  keptChip.className = 'track-chip';
  keptChip.innerHTML =
    '<a class="kc-quantize lightButton" title="Quantize this take">Quantize</a>' +
    '<a class="kc-steps lightButton" title="Turn this kept take into steps">To steps</a>';
  keptChip.addEventListener('mousedown', (ev) => ev.stopPropagation());
  const fromKept = (target: 'steps' | 'take') => (): void => {
    if (takeSel) startConvert(takeSel.zone, takeSel.take, takeSel.take.start, takeSel.take.end, target);
  };
  keptChip.querySelector('.kc-steps')!.addEventListener('click', fromKept('steps'));
  keptChip.querySelector('.kc-quantize')!.addEventListener('click', fromKept('take'));
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
  takeChip.innerHTML =
    '<a class="tc-prev lightButton" title="An earlier take">‹</a><span class="tc-label"></span>' +
    '<a class="tc-next lightButton" title="A later take">›</a>' +
    '<a class="tc-keep lightButton" title="Keep this take: it joins the song and plays from now on">Keep</a>' +
    '<a class="tc-quantize lightButton" title="Quantize this take (keeps the result)">Quantize</a>' +
    '<a class="tc-steps lightButton" title="Turn this take into steps">To steps</a>';
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
  takeChip.querySelector('.tc-keep')!.addEventListener('click', keepShownTake);
  zonesEl.addEventListener('mousedown', (ev) => {
    if (!isActive() || ev.button !== 0 || timeline.running) return;
    const lane = (ev.target as Element).closest('.track-lane');
    const zone = getZones()[zoneIndexOf(lane)];
    if (!lane || !zone || (ev.target as Element).closest('.track-capture, .track-takes')) return;
    // no text selection; a field being typed in still commits its value (on blur)
    ev.preventDefault();
    (document.activeElement as HTMLElement | null)?.blur();
    const hit = takeAt(zone, lane, ev.clientX);
    if (hit) {
      takeSel = { zone, take: hit.take };
      clearCapture();
      startTakeDrag(ev, lane, zone, hit.take, hit.edge);
      return;
    }
    takeSel = null;
    startCaptureDrag(ev, lane, zone);
  });
  document.addEventListener('keydown', (ev) => {
    if (capture && ev.key === 'Escape') clearCapture();
    if (conv && ev.key === 'Escape') endConvert();
    if (!takeSel || !isActive()) return;
    if ((ev.target as Element | null)?.closest?.('input, select, textarea')) return;
    if (ev.key === 'Escape') {
      takeSel = null;
      invalidate();
    } else if (ev.key === 'Backspace' || ev.key === 'Delete') {
      ev.preventDefault();
      deleteSelectedTake();
    }
  });
  // edges of kept takes trim, their bodies move (after Stop)
  zonesEl.addEventListener('mousemove', (ev) => {
    if (!isActive() || takeDrag) return;
    const lane = (ev.target as Element).closest('.track-lane') as HTMLElement | null;
    if (!lane) return;
    const zone = getZones()[zoneIndexOf(lane)];
    const hit = !timeline.running && zone ? takeAt(zone, lane, ev.clientX) : null;
    const cursor = hit ? (hit.edge ? 'ew-resize' : 'grab') : '';
    if (lane.style.cursor !== cursor) lane.style.cursor = cursor;
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
    if (index < 0) return;
    const zone = getZones()[index];
    // on a kept take (after Stop): cut it there
    const hit = !timeline.running && zone ? takeAt(zone, lane!, ev.clientX) : null;
    if (hit && !hit.edge) {
      cutTake(zone, hit.take, snapWith(laneTick(lane!, ev.clientX), ev));
      return;
    }
    const pianoRoll = zone?.elements.zoneElement?.querySelector(
      '[data-action$=":seq_open_piano_roll"]'
    ) as HTMLElement | null;
    const steps = zone?.sequence.active && !zone.sequence.isDrumSequence;
    if (steps && pianoRoll) pianoRoll.click();
    else setTab('seq');
  });
  const dock = document.getElementById('trackDock')!;
  dock.querySelectorAll('.td-tab').forEach((t) => {
    t.addEventListener('click', () => {
      const next = (t as HTMLElement).dataset['tab'] as DockTab;
      if (next === tab && dockOpen) setDockOpen(false);
      else setTab(next);
    });
  });
  dock.querySelector('.td-collapse')!.addEventListener('click', () => setDockOpen(!dockOpen));
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
  applyBodyState();
}

export { initTrackView, isTrackView, setTrackView, followTrack, invalidate as invalidateTrackView };
