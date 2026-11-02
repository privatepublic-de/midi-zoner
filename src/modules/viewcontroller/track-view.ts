import { Zone } from '../zone/zone-class';
import { ZONES_CHANGED_EVENT, UPDATE_ZONE_VIEW_EVENT } from '../zone/interfaces';
import { timeline, nowTick } from '../timeline';

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

function select(index: number): void {
  if (index === selected) return;
  selected = index;
  invalidate();
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

/** Where the step `cur` of a sequence started, and that step; stopped: step 0 at the playhead */
function anchor(cur: number, ticks: number, head: number): [number, number] {
  if (timeline.running && cur >= 0) return [cur, Math.floor(Math.max(0, timeline.pos) / ticks) * ticks];
  return [0, head];
}

function divisionName(zone: Zone): string {
  const select = zone.elements.zoneElement?.querySelector('.seq_division') as HTMLSelectElement | null;
  return select?.options[zone.sequence.division]?.text ?? '';
}

function draw(): void {
  const zones = getZones();
  if (selected >= zones.length) selected = Math.max(0, zones.length - 1);
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
  const head = timeline.running ? nowTick() : 0;
  const historyShift = timeline.running ? 0 : -timeline.stopPos;
  drawRuler(head, ppt);
  zones.forEach((z) => drawLane(z, head, historyShift, ppt));
}

function drawRuler(head: number, ppt: number): void {
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
  const playX = Math.round(w * PLAYHEAD_AT);
  g.font = '11px "Barlow Semi Condensed", sans-serif';
  const first = Math.max(0, Math.ceil((head - playX / ppt) / TICKS_PER_BEAT) * TICKS_PER_BEAT);
  const labelEvery = ppt < 1 ? 2 : 1; // bars apart, so numbers don't touch
  for (let t = first; ; t += TICKS_PER_BEAT) {
    const x = Math.round(playX + (t - head) * ppt);
    if (x > w) break;
    const bar = t % TICKS_PER_BAR === 0;
    g.fillStyle = bar ? DIM_TEXT : '#4a525d';
    g.fillRect(x, bar ? h - 14 : h - 6, 1, bar ? 14 : 6);
    const barNo = t / TICKS_PER_BAR;
    // clear of the playhead mark
    if (bar && barNo % labelEvery === 0 && Math.abs(x - playX) > 8) g.fillText(String(barNo + 1), x + 4, h - 5);
  }
  g.fillStyle = '#e7eaee';
  g.beginPath();
  g.moveTo(playX - 5, h - 10);
  g.lineTo(playX + 6, h - 10);
  g.lineTo(playX + 0.5, h - 1);
  g.fill();
}

function drawLane(zone: Zone, head: number, historyShift: number, ppt: number): void {
  const el = zone.elements.zoneElement;
  if (!el) return;
  const height = `${laneHeight(zone)}px`;
  if (el.style.getPropertyValue('--track-h') !== height) el.style.setProperty('--track-h', height);
  const p = prepare(el.querySelector('.track-lane canvas'));
  if (!p) return;
  const [g, w, h] = p;
  const playX = Math.round(w * PLAYHEAD_AT);
  const x = (t: number): number => playX + (t - head) * ppt;
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

  // beats and bars from the start on
  for (let t = Math.max(0, Math.ceil((head - playX / ppt) / TICKS_PER_BEAT) * TICKS_PER_BEAT); ; t += TICKS_PER_BEAT) {
    const gx = Math.round(x(t));
    if (gx > w) break;
    g.fillStyle = t % TICKS_PER_BAR === 0 ? '#ffffff1c' : '#ffffff0a';
    g.fillRect(gx, 0, 1, h);
  }

  // pitch rows: drum lanes, or the span of the sequence's and the sent notes
  const history = zone.noteHistory.notes;
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
    history.forEach((n) => take(n.pitch));
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

  const note = (t0: number, t1: number, row: number, velo: number, hollow: boolean, alpha = 1): void => {
    if (row < 0) return;
    const x0 = x(t0);
    const x1 = x(t1);
    if (x1 < 0 || x0 > w) return;
    const y = rowY(row);
    const width = Math.max(2, x1 - x0 - 1);
    g.globalAlpha = (silent ? 0.3 : 0.45 + (0.55 * velo) / 127) * alpha;
    if (hollow) {
      g.strokeStyle = colour;
      g.strokeRect(x0 + 0.5, y + 0.5, width - 1, noteH - 1);
    } else {
      g.fillStyle = colour;
      g.fillRect(x0, y, width, noteH);
    }
    if (timeline.running && t0 <= head && head < t1) {
      g.globalAlpha = 0.8;
      g.fillStyle = '#ffffff';
      g.fillRect(Math.max(x0, playX - 2), y, 2, noteH);
    }
  };

  // behind the playhead: what was sent
  for (const n of history) {
    const t0 = n.start + historyShift;
    const t1 = (n.end ?? nowTick()) + historyShift;
    note(t0, Math.max(t1, t0 + 1 / ppt), rowOf(n.pitch), n.velo, false);
  }

  // ahead of it: the sequence, repeated; hollow where chance or a condition decide
  if (seq.active) {
    const ticks = seq.ticks;
    const ahead = (len: number, cur: number, start: number, s: number, each: (t: number) => void): void => {
      let t = start + ((((s - cur) % len) + len) % len) * ticks;
      if (t < head) t += len * ticks;
      for (; x(t) < w; t += len * ticks) each(t);
    };
    if (drums) {
      const soloCount = seq.getDrumLaneSoloCount();
      for (let ln = 0; ln < rows; ln++) {
        const lane = seq.drum_lanes[ln];
        if (!lane || lane.length < 1) continue;
        const [cur, start] = anchor(lane.currentStep, ticks, head);
        const quiet = !lane.enabled || (soloCount > 0 && !lane.solo);
        for (let s = 0; s < lane.length; s++) {
          const step = lane.steps[s];
          if (!step || step.notesArray.length === 0) continue;
          const hollow = step.probability < 1 || step.condition !== 0;
          const velo = step.notesArray[0].velo;
          const hits = Math.max(1, step.ratchetCount);
          ahead(lane.length, cur, start, s, (t) => {
            for (let r = 0; r < hits; r++) {
              const rt = t + (hits > 1 ? r * step.ratchetResolution : 0);
              note(rt, rt + Math.max(1, (hits > 1 ? step.ratchetResolution : ticks) * 0.6), ln, velo, hollow, quiet ? 0.35 : 1);
            }
          });
        }
      }
    } else if (seq.length > 0) {
      const len = seq.length;
      const [cur, start] = anchor(seq.currentStepNumber, ticks, head);
      // where each repeat begins
      g.globalAlpha = silent ? 0.2 : 0.45;
      g.fillStyle = colour;
      ahead(len, cur, start, 0, (t) => g.fillRect(Math.round(x(t)), 0, 1, h));
      for (let s = 0; s < len; s++) {
        const step = seq.steps[s];
        if (!step || step.notesArray.length === 0) continue;
        const hollow = step.probability < 1 || step.condition !== 0;
        const dur =
          (Math.max(1, step.length) - 1) * ticks + Math.max(1, Math.min(ticks * step.gateLength, ticks - 1));
        const hits = Math.max(1, step.ratchetCount);
        ahead(len, cur, start, s, (t) => {
          for (const n of step.notesArray) {
            if (hits > 1) {
              for (let r = 0; r < hits; r++) {
                const rt = t + r * step.ratchetResolution;
                note(rt, rt + Math.max(1, step.ratchetResolution - 1), rowOf(n.number), n.velo, hollow);
              }
            } else {
              note(t, t + dur, rowOf(n.number), n.velo, hollow);
            }
          }
        });
      }
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

  // the past a shade darker, then the playhead
  g.globalAlpha = 1;
  g.fillStyle = '#0000002e';
  g.fillRect(0, 0, playX, h);
  g.fillStyle = '#e7eaeecc';
  g.fillRect(playX, 0, 1, h);
}

// ---------------------------------------------------------------------------

function initTrackView(zones: () => Zone[]): void {
  getZones = zones;
  const zonesEl = document.getElementById('zones')!;
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
    if (zone?.sequence.active && !zone.sequence.isDrumSequence && pianoRoll) pianoRoll.click();
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

export { initTrackView, isTrackView, setTrackView, invalidate as invalidateTrackView };
