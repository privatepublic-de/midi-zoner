import { Zone } from '../zone/zone-class';
import { ZONES_CHANGED_EVENT, UPDATE_ZONE_VIEW_EVENT } from '../zone/interfaces';
import { timeline, nowTick, sessionNow, NoteHistory } from '../timeline';
import { Clip, TICKS_PER_BAR as CLIP_BAR } from '../zone/clip';
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
const TICKS_PER_BEAT = 24;
const TICKS_PER_BAR = 96; // 4/4
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
// Changes to a zone that are undo steps (set by the controller)
let commit: (zoneIndex: number, label: string, change: () => void) => void = (_i, _l, change) => change();
// The last frame's view, to turn a mouse position on a lane into a session position
const view = { head: 0, historyShift: 0, ppt: 1, scrollPx: 0 };
// Following the playhead, or looking back: then this session position stays where
// the playhead normally is (a wheel or trackpad scrolls, Follow returns)
let follow = true;
let pinnedAt = 0;
// A stretch of a lane's past, in session positions
let capture: { zone: Zone; from: number; to: number } | null = null;
let captureButton: HTMLElement;
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
  if (timeline.running || dirty || now - lastDraw > STOPPED_REDRAW_MS) {
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
  if (seq.active) return 80;
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
  // Stopped, the playhead waits at the start; the last run stays visible behind it
  // Run positions (the sequence's) map to the session at the displayed run's start
  const head = timeline.running ? nowTick() : 0;
  const origin = timeline.running ? timeline.runStart : timeline.nextRunStart;
  const historyShift = -origin;
  if (follow) pinnedAt = origin + head;
  const scrollPx = (origin + head - pinnedAt) * ppt;
  view.head = head;
  view.historyShift = historyShift;
  view.ppt = ppt;
  view.scrollPx = scrollPx;
  document.querySelector('#trackRuler .tr-follow')?.classList.toggle('active', follow);
  drawRuler(head, ppt, origin, scrollPx);
  zones.forEach((z) => drawLane(z, head, historyShift, ppt, scrollPx));
}

/** Scroll back in time (and forward up to the playhead, which follows again) */
function scrollBy(px: number): void {
  const now = sessionNow();
  pinnedAt = Math.max(0, Math.min(now, (follow ? now : pinnedAt) + px / view.ppt));
  follow = pinnedAt >= now;
  invalidate();
}

/** The run start at or before a session position (bars are counted from it) */
function runStartBefore(s: number, origin: number): number {
  let start = 0;
  for (const r of timeline.runStarts) if (r <= s) start = r;
  return origin <= s ? Math.max(start, origin) : start;
}

function drawRuler(head: number, ppt: number, origin: number, scrollPx: number): void {
  const ruler = document.getElementById('trackRuler');
  const pos = ruler?.querySelector('.tr-pos');
  if (pos) {
    const t = Math.max(0, Math.floor(head));
    pos.textContent = timeline.running
      ? `${Math.floor(t / TICKS_PER_BAR) + 1}.${Math.floor((t % TICKS_PER_BAR) / TICKS_PER_BEAT) + 1}`
      : 'Stopped';
  }
  const p = prepare(ruler?.querySelector('canvas') ?? null);
  if (!p) return;
  const [g, w, h] = p;
  const headX = Math.round(w * PLAYHEAD_AT) + scrollPx;
  const headSession = origin + head;
  g.font = '11px "Barlow Semi Condensed", sans-serif';
  const first = Math.max(0, Math.ceil((headSession - headX / ppt) / TICKS_PER_BEAT) * TICKS_PER_BEAT);
  const labelEvery = ppt < 1 ? 2 : 1; // bars apart, so numbers don't touch
  for (let s = first; ; s += TICKS_PER_BEAT) {
    const x = Math.round(headX + (s - headSession) * ppt);
    if (x > w) break;
    if (s % TICKS_PER_BAR !== 0) {
      g.fillStyle = '#4a525d';
      g.fillRect(x, h - 6, 1, 6);
      continue;
    }
    // bars count from the start of their run; a run's first bar is marked
    const runStart = runStartBefore(s, origin);
    const barNo = (s - runStart) / TICKS_PER_BAR;
    g.fillStyle = barNo === 0 ? '#e7eaee' : DIM_TEXT;
    g.fillRect(x, barNo === 0 ? 0 : h - 14, 1, barNo === 0 ? h : 14);
    if ((barNo % labelEvery === 0 || barNo === 0) && Math.abs(x - headX) > 8) g.fillText(String(barNo + 1), x + 4, h - 5);
  }
  if (headX < -6 || headX > w + 6) return;
  g.fillStyle = '#e7eaee';
  g.beginPath();
  g.moveTo(headX - 5, h - 10);
  g.lineTo(headX + 6, h - 10);
  g.lineTo(headX + 0.5, h - 1);
  g.fill();
}

function drawLane(zone: Zone, head: number, historyShift: number, ppt: number, scrollPx: number): void {
  const el = zone.elements.zoneElement;
  if (!el) return;
  const height = `${laneHeight(zone)}px`;
  if (el.style.getPropertyValue('--track-h') !== height) el.style.setProperty('--track-h', height);
  const p = prepare(el.querySelector('.track-lane canvas'));
  if (!p) return;
  const [g, w, h] = p;
  // where the playhead is: its place, or further right while looking back
  const headX = Math.round(w * PLAYHEAD_AT) + scrollPx;
  const x = (t: number): number => headX + (t - head) * ppt;
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

  // beats and bars of the session (runs start on whole bars), a run's start stronger
  const sessionStart = historyShift; // run position of session position 0
  const firstBeat = Math.ceil((head - headX / ppt) / TICKS_PER_BEAT) * TICKS_PER_BEAT;
  for (let t = Math.max(sessionStart, firstBeat); ; t += TICKS_PER_BEAT) {
    const gx = Math.round(x(t));
    if (gx > w) break;
    g.fillStyle = (t - sessionStart) % TICKS_PER_BAR === 0 ? '#ffffff1c' : '#ffffff0a';
    g.fillRect(gx, 0, 1, h);
  }
  g.fillStyle = '#ffffff40';
  for (const r of timeline.runStarts) {
    const rx = Math.round(x(r + historyShift));
    if (rx >= 0 && rx <= w) g.fillRect(rx, 0, 1, h);
  }

  // pitch rows: drum lanes, or the span of the sequence's, the held and the sent notes
  // only the notes in view: a session's history can be long
  const sessionAt = (px: number): number => head + (px - headX) / ppt - historyShift;
  const heldHistory = drums ? null : syncHeld(zone);
  const history = zone.noteHistory.between(sessionAt(0), sessionAt(w));
  const held = heldHistory ? heldHistory.between(sessionAt(0), sessionAt(w)) : [];
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
    if (seq.active && seq.isClip) {
      seq.clip.playing.forEach((n) => take(n.n));
    } else if (seq.active) {
      for (let s = 0; s < seq.length; s++) seq.steps[s]?.notesArray.forEach((n) => take(n.number));
    }
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

  const note = (t0: number, t1: number, row: number, velo: number, ghost: boolean): void => {
    if (row < 0) return;
    const x0 = x(t0);
    const x1 = x(t1);
    if (x1 < 0 || x0 > w) return;
    const y = rowY(row);
    const width = Math.max(2, x1 - x0 - 1);
    g.globalAlpha = silent ? 0.3 : 0.45 + (0.55 * velo) / 127;
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
    if (timeline.running && t0 <= head && head < t1) {
      g.globalAlpha = 0.8;
      g.fillStyle = '#ffffff';
      g.fillRect(Math.max(x0, headX - 2), y, 2, noteH);
    }
  };

  // the notes the arp plays from: a band behind its notes, fading out ahead while still held
  const bandH = Math.max(noteH + 2, Math.min(rowH, noteH + 4));
  for (const n of held) {
    const x0 = x(n.start + historyShift);
    const x1 = n.end === null ? headX : x(n.end + historyShift);
    if (x1 < 0 || x0 > w) continue;
    const y = rowY(rowOf(n.pitch)) - (bandH - noteH) / 2;
    g.globalAlpha = silent ? 0.08 : 0.22;
    g.fillStyle = colour;
    g.fillRect(x0, y, Math.max(1, x1 - x0), bandH);
    if (n.end === null && timeline.running) {
      const fade = TICKS_PER_BAR * ppt * 0.5;
      const gradient = g.createLinearGradient(headX, 0, headX + fade, 0);
      gradient.addColorStop(0, colour);
      gradient.addColorStop(1, 'transparent');
      g.fillStyle = gradient;
      g.fillRect(headX, y, fade, bandH);
    }
  }

  // behind the playhead: what was sent
  for (const n of history) {
    const t0 = n.start + historyShift;
    const t1 = (n.end ?? sessionNow()) + historyShift;
    note(t0, Math.max(t1, t0 + 1 / ppt), rowOf(n.pitch), n.velo, false);
  }

  // ahead of it: the sequence step by step, as playback will decide each step
  // (Sequence.upcoming()); dashed where a condition or chance skips it
  if (seq.active) {
    const ticks = seq.ticks;
    const MAX_STEPS_AHEAD = 4096;
    const ahead = (lane: number, cur: number, each: (t: number, step: number, plays: boolean) => void): void => {
      const base = stepStart(cur, ticks, head);
      let k = 1;
      for (const next of seq.upcoming(lane)) {
        const t = base + k * ticks;
        if (x(t) > w || k++ > MAX_STEPS_AHEAD) break;
        if (t >= head) each(t, next.step, next.plays);
      }
    };
    if (seq.isClip) {
      // the clip loops from bar 1
      const clip = seq.clip;
      const length = clip.length;
      for (let base = Math.floor(head / length) * length; x(base) < w; base += length) {
        if (base >= head) {
          g.globalAlpha = silent ? 0.2 : 0.45;
          g.fillStyle = colour;
          g.fillRect(Math.round(x(base)), 0, 1, h);
        }
        for (const n of clip.notes) {
          if (n.t >= length) break;
          const t0 = base + n.t;
          if (x(t0) > w) break;
          if (t0 >= head) note(t0, t0 + n.d, rowOf(n.n), n.v, false);
        }
      }
    } else if (drums) {
      for (let ln = 0; ln < rows; ln++) {
        const lane = seq.drum_lanes[ln];
        if (!lane) continue;
        ahead(ln, lane.currentStep, (t, s, plays) => {
          const step = lane.steps[s];
          if (!step || step.notesArray.length === 0) return;
          const velo = step.notesArray[0].velo;
          const hits = Math.max(1, step.ratchetCount);
          for (let r = 0; r < hits; r++) {
            const rt = t + (hits > 1 ? r * step.ratchetResolution : 0);
            note(rt, rt + Math.max(1, (hits > 1 ? step.ratchetResolution : ticks) * 0.6), ln, velo, !plays);
          }
        });
      }
    } else if (seq.length > 0) {
      ahead(-1, seq.currentStepNumber, (t, s, plays) => {
        if (s === 0) {
          // where each repeat begins
          g.globalAlpha = silent ? 0.2 : 0.45;
          g.fillStyle = colour;
          g.fillRect(Math.round(x(t)), 0, 1, h);
        }
        const step = seq.steps[s];
        if (!step || step.notesArray.length === 0) return;
        const dur =
          (Math.max(1, step.length) - 1) * ticks + Math.max(1, Math.min(ticks * step.gateLength, ticks - 1));
        const hits = Math.max(1, step.ratchetCount);
        for (const n of step.notesArray) {
          if (hits > 1) {
            for (let r = 0; r < hits; r++) {
              const rt = t + r * step.ratchetResolution;
              note(rt, rt + Math.max(1, step.ratchetResolution - 1), rowOf(n.number), n.velo, !plays);
            }
          } else {
            note(t, t + dur, rowOf(n.number), n.velo, !plays);
          }
        }
      });
    }
    const label = seq.isClip
      ? `Clip · ${Clip.lengthLabel(seq.clip.length)}`
      : drums
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

  // the past a shade darker, then the playhead
  g.globalAlpha = 1;
  g.fillStyle = '#0000002e';
  g.fillRect(0, 0, Math.min(w, headX), h);
  g.fillStyle = '#e7eaeecc';
  if (headX <= w) g.fillRect(headX, 0, 1, h);

  if (capture?.zone === zone) drawCapture(g, el, x(capture.from + historyShift), x(capture.to + historyShift), w, h);
}

/** The stretch picked for a clip, and its Make clip button at its end */
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
  const text = `Make clip · ${Clip.lengthLabel(capture!.to - capture!.from)}`;
  if (captureButton.textContent !== text) captureButton.textContent = text;
  captureButton.style.left = `${Math.max(4, Math.min(w - captureButton.offsetWidth - 4, x1 - captureButton.offsetWidth - 4))}px`;
}

function clearCapture(): void {
  capture = null;
  captureButton?.remove();
  invalidate();
}

/** The session position up to which notes were played (stopped: the end of the last run) */
function playedUntil(): number {
  return timeline.running ? sessionNow() : timeline.runStart + timeline.stopPos;
}

/** Session position under a mouse x on a lane */
function laneTick(lane: Element, clientX: number): number {
  const rect = lane.getBoundingClientRect();
  const headX = Math.round(rect.width * PLAYHEAD_AT) + view.scrollPx;
  return view.head + (clientX - rect.left - headX) / view.ppt - view.historyShift;
}

/** Drag over a lane's past: whole bars, up to the bar being played */
function startCaptureDrag(ev: MouseEvent, lane: Element, zone: Zone): void {
  const startX = ev.clientX;
  const start = laneTick(lane, startX);
  let dragging = false;
  const move = (e: MouseEvent): void => {
    if (!dragging && Math.abs(e.clientX - startX) < 4) return;
    dragging = true;
    const end = laneTick(lane, e.clientX);
    const now = playedUntil();
    // beats, whole bars with Shift, free (to the tick) with Alt/Option
    const unit = e.altKey ? 1 : e.shiftKey ? CLIP_BAR : CLIP_BAR / 4;
    const last = Math.ceil(now / unit) * unit;
    const from = Math.max(0, Math.floor(Math.min(start, end) / unit) * unit);
    let to = Math.min(last, Math.max(from + unit, Math.ceil(Math.max(start, end) / unit) * unit));
    to = Math.min(to, from + Clip.MAX_LENGTH);
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

/** The picked stretch of what was played becomes the track's clip */
function makeClip(): void {
  if (!capture) return;
  const { zone, from, to } = capture;
  const index = getZones().indexOf(zone);
  if (index < 0) return;
  const now = playedUntil();
  let played = zone.inputHistory.between(from, to).filter((n) => n.start >= from && n.start < to);
  if (played.length === 0) {
    toast('Nothing was played into this track there');
    return;
  }
  const clip = new Clip();
  clip.length = Math.max(1, Math.round(to - from));
  if (played.length > Clip.MAX_NOTES) {
    played = played.slice(0, Clip.MAX_NOTES);
    toast(`Only the first ${Clip.MAX_NOTES} notes fit into a clip`, { warning: true });
  }
  clip.notes = played.map((n) => ({
    t: n.start - from,
    d: Math.max(0.25, Math.min((n.end ?? now) - n.start, clip.length)),
    n: n.pitch,
    v: n.velo
  }));
  clip.sort();
  commit(index, 'Make Clip', () => {
    const seq = zone.sequence;
    seq.isClip = true;
    seq.clip = clip;
    seq.active = true;
  });
  clearCapture();
  setTab('seq');
  toast(`Clip made: ${Clip.lengthLabel(clip.length)}, ${clip.notes.length} notes`);
}

// ---------------------------------------------------------------------------

function initTrackView(
  zones: () => Zone[],
  commitChange: (zoneIndex: number, label: string, change: () => void) => void
): void {
  getZones = zones;
  commit = commitChange;
  const zonesEl = document.getElementById('zones')!;
  captureButton = document.createElement('a');
  captureButton.className = 'track-capture lightButton';
  captureButton.title = 'Make the notes played in this stretch the track\'s clip (Esc cancels)';
  captureButton.addEventListener('mousedown', (ev) => ev.stopPropagation());
  captureButton.addEventListener('click', makeClip);
  zonesEl.addEventListener('mousedown', (ev) => {
    if (!isActive() || ev.button !== 0) return;
    const lane = (ev.target as Element).closest('.track-lane');
    const zone = getZones()[zoneIndexOf(lane)];
    if (!lane || !zone || (ev.target as Element).closest('.track-capture')) return;
    // no text selection; a field being typed in still commits its value (on blur)
    ev.preventDefault();
    (document.activeElement as HTMLElement | null)?.blur();
    startCaptureDrag(ev, lane, zone);
  });
  document.addEventListener('keydown', (ev) => {
    if (capture && ev.key === 'Escape') clearCapture();
  });
  // Horizontal wheel or trackpad (or Shift + wheel) over the lanes or the ruler looks back
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
    const pianoRoll = zone?.elements.zoneElement?.querySelector(
      '[data-action$=":seq_open_piano_roll"]'
    ) as HTMLElement | null;
    const steps = zone?.sequence.active && !zone.sequence.isDrumSequence && !zone.sequence.isClip;
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
