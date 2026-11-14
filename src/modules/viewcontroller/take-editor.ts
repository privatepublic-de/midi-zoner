import MIDI from '../midi';
import type { Zone } from '../zone/zone-class';
import { Take } from '../zone/take';
import type { TakeNoteJSON } from '../zone/interfaces';
import { DIV_TICKS } from '../zone/seq-layer';
import { DIV_NAMES, quantizeStarts } from '../zone/take-quantize';
import { timeline } from '../timeline';
import { Meter, barTicks, beatLines, unitTicks } from '../meter';
import { toast } from './toast';

/**
 * The dock's Notes tab: a piano roll for the zone's loop or one of its takes. Note
 * times stay free: moves snap by whole grid steps (a note keeps its distance to the
 * grid), new notes and lengths snap to it; the length stays (notes stay inside). Every
 * gesture is one undo step (a loop's with the scene, a take's as a take patch).
 */

export interface TakeTarget {
  zone: Zone;
  take: Take;
  kind: 'loop' | 'take';
  label: string;
  /** Its bars and beats */
  meter: Meter;
  /** Where it's playing now (positions in it), null: not playing */
  playhead(): number | null;
}

export interface TakeEditorHooks {
  zones(): Zone[];
  /** The take the tab shows, null: none */
  target(): TakeTarget | null;
  /** A change to the loop: an undo step of the scene */
  commit(zoneIndex: number, label: string, change: () => void): void;
  /** A change to a take: an undo step of its own (takes aren't scene data) */
  commitTake(zoneIndex: number, take: Take, label: string, change: () => void): void;
  /** The bars from…to of a take become the zone's loop */
  loopFrom(zone: Zone, take: Take, from: number, to: number): void;
  /** Show the zone's loop or its shown take */
  show(kind: 'loop' | 'take'): void;
  invalidate(): void;
}

const KEYS_W = 40;
const RULER_H = 18;
const VEL_H = 48;
const VEL_GAP = 6;
const EDGE_PX = 5;
const DRAG_PX = 3;
const GRID_KEY = 'takeEditorGrid';
const GRIDS = [8, 10, 11, 13, 14, 15, 16]; // 1/4 … 1/32 (DIV_TICKS indices), -1 = off
const BLACK = [1, 3, 6, 8, 10];
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

type Drag =
  | {
      kind: 'move';
      x0: number;
      y0: number;
      dt: number;
      dn: number;
      moved: boolean;
      toggle: TakeNoteJSON | null;
    }
  | {
      kind: 'resize';
      x0: number;
      note: TakeNoteJSON;
      dd: number;
      moved: boolean;
    }
  | {
      kind: 'box';
      x0: number;
      y0: number;
      x1: number;
      y1: number;
      base: Set<TakeNoteJSON>;
      moved: boolean;
      additive: boolean;
    }
  | {
      kind: 'vel';
      y0: number;
      notes: TakeNoteJSON[];
      dv: number;
      moved: boolean;
    }
  | {
      kind: 'edge';
      edge: 'start' | 'end';
      start: number;
      length: number;
      offset: number;
      moved: boolean;
    };

let hooks: TakeEditorHooks;
let root: HTMLElement;
let canvas: HTMLCanvasElement;
const view = { left: 0, ppt: 1, top: 72, rowH: 10 };
let fittedId = '';
let sel = new Set<TakeNoteJSON>();
let selTake: Take | null = null;
// the notes array the selection was made in (undo replaces it)
let selNotes: TakeNoteJSON[] | null = null;
let drag: Drag | null = null;
let focused = false;
let grid = Number(localStorage.getItem(GRID_KEY) ?? 14);
if (grid !== -1 && !GRIDS.includes(grid)) grid = 14;
let strength = 1;
let lastVelo = 100;
let clipboard: {
  notes: { s: number; d: number; n: number; v: number }[];
  span: number;
} | null = null;
let nextPaste: number | null = null;
let size = { w: 0, h: 0 };

function gridTicks(): number {
  return grid < 0 ? 0 : DIV_TICKS[grid];
}

const sx = (s: number): number => KEYS_W + (s - view.left) * view.ppt;
const tickAt = (x: number): number => view.left + (x - KEYS_W) / view.ppt;
const py = (n: number): number => RULER_H + (view.top - n) * view.rowH;
const pitchAt = (y: number): number => view.top - Math.floor((y - RULER_H) / view.rowH);
const gridBottom = (): number => size.h - VEL_H - VEL_GAP;
const rows = (): number => Math.max(1, Math.floor((gridBottom() - RULER_H) / view.rowH));

function inWindow(take: Take, note: TakeNoteJSON): boolean {
  return note.t >= take.offset && note.t < take.offset + take.length;
}

// ---------------------------------------------------------------------------
// Audition

const previewBuf = new Uint8Array(3);
let previewing: { zone: Zone; n: number } | null = null;
let previewTimer: ReturnType<typeof setTimeout> | null = null;

function stopPreview(): void {
  if (previewTimer) clearTimeout(previewTimer);
  previewTimer = null;
  if (!previewing) return;
  const { zone, n } = previewing;
  previewBuf[0] = MIDI.MESSAGE.NOTE_OFF + zone.channel;
  previewBuf[1] = n;
  previewBuf[2] = 0;
  zone.midi.send(previewBuf, zone.outputPortId);
  previewing = null;
}

function preview(zone: Zone, n: number, v: number): void {
  stopPreview();
  previewing = { zone, n };
  previewBuf[0] = MIDI.MESSAGE.NOTE_ON + zone.channel;
  previewBuf[1] = n;
  previewBuf[2] = v;
  zone.midi.send(previewBuf, zone.outputPortId);
  previewTimer = setTimeout(stopPreview, 180);
}

// ---------------------------------------------------------------------------
// Edits

/** The meter of what's shown */
function meter(): Meter {
  return hooks.target()?.meter ?? timeline.meter;
}

/** One undo step on what's shown (`mine` maps a note to itself: kept for the callers) */
function apply(label: string, change: (take: Take, mine: (n: TakeNoteJSON) => TakeNoteJSON) => void): void {
  const target = hooks.target();
  if (!target) return;
  const index = hooks.zones().indexOf(target.zone);
  if (index < 0) return;
  const take = target.take;
  const mine = (n: TakeNoteJSON): TakeNoteJSON => n;
  if (target.kind === 'loop') hooks.commit(index, label, () => change(take, mine));
  else hooks.commitTake(index, take, label, () => change(take, mine));
  selTake = take;
  selNotes = take.notes;
  hooks.invalidate();
}

function selectedOrdered(take: Take): TakeNoteJSON[] {
  return take.notes.filter((n) => sel.has(n));
}

function moveSelected(dt: number, dn: number, label = 'Move Notes'): void {
  const target = hooks.target();
  if (!target || sel.size === 0) return;
  const notes = selectedOrdered(target.take);
  ({ dt, dn } = clampMove(target.take, notes, dt, dn));
  if (dt === 0 && dn === 0) return;
  apply(label, (take, mine) => {
    for (const n of notes.map(mine)) {
      n.t += dt;
      n.n += dn;
    }
    take.sort();
  });
  if (dn !== 0) preview(target.zone, notes[0].n, notes[0].v);
}

/** Keep moved notes inside the take's window and 0–127 */
function clampMove(take: Take, notes: TakeNoteJSON[], dt: number, dn: number): { dt: number; dn: number } {
  if (notes.length === 0) return { dt: 0, dn: 0 };
  const first = Math.min(...notes.map((n) => take.songOf(n)));
  const last = Math.max(...notes.map((n) => take.songOf(n)));
  dt = Math.max(take.floor - first, Math.min(take.end - 0.01 - last, dt));
  const lo = Math.min(...notes.map((n) => n.n));
  const hi = Math.max(...notes.map((n) => n.n));
  dn = Math.max(-lo, Math.min(127 - hi, dn));
  return { dt, dn };
}

function deleteSelected(label = 'Delete Notes'): void {
  const target = hooks.target();
  if (!target || sel.size === 0) return;
  const notes = selectedOrdered(target.take);
  apply(label, (take, mine) => take.removeNotes(new Set(notes.map(mine))));
  sel.clear();
}

function addNote(s: number, n: number): void {
  const target = hooks.target();
  if (!target) return;
  const g = gridTicks() || unitTicks(meter()) / 4;
  const at = gridTicks() ? Math.floor(s / g) * g : s;
  if (at < target.take.floor || at >= target.take.end) return;
  if (target.take.notes.length >= Take.MAX_NOTES) {
    toast('This take is full');
    return;
  }
  let added: TakeNoteJSON[] = [];
  apply('Add Note', (take) => {
    added = take.addNotes([{ s: at, d: Math.min(g, take.end - at), n, v: lastVelo }]);
  });
  sel = new Set(added);
  preview(target.zone, n, lastVelo);
}

function copySelection(): boolean {
  const target = hooks.target();
  if (!target || sel.size === 0) return false;
  const take = target.take;
  const notes = selectedOrdered(take);
  const base = take.songOf(notes[0]);
  const end = Math.max(...notes.map((n) => take.songOf(n) + n.d));
  const step = gridTicks() || unitTicks(meter());
  clipboard = {
    notes: notes.map((n) => ({
      s: take.songOf(n) - base,
      d: n.d,
      n: n.n,
      v: n.v
    })),
    span: Math.max(step, Math.ceil((end - base) / step - 0.001) * step)
  };
  nextPaste = base + clipboard.span;
  return true;
}

/** Paste the clipboard at a position (notes past the end are left out: the length stays) */
function paste(at: number, label: string): void {
  const target = hooks.target();
  if (!target || !clipboard) return;
  const clip = clipboard;
  at = Math.max(target.take.floor, at);
  let added: TakeNoteJSON[] = [];
  apply(label, (take) => {
    added = take.addNotes(
      clip.notes.map((n) => ({ ...n, s: at + n.s, d: Math.min(n.d, take.end - at - n.s) })).filter((n) => n.s < take.end)
    );
  });
  sel = new Set(added);
  if (added.length < clip.notes.length) toast(`${clip.notes.length - added.length} notes didn’t fit before the end`);
}

function quantizeSelection(): void {
  const target = hooks.target();
  if (!target) return;
  if (grid < 0) {
    toast('Pick a grid to quantize to');
    return;
  }
  const take = target.take;
  const notes = sel.size > 0 ? selectedOrdered(take) : take.notes.filter((n) => inWindow(take, n));
  if (notes.length === 0) return;
  const starts = quantizeStarts(
    notes.map((n) => ({ s: take.songOf(n), d: n.d, n: n.n, v: n.v })),
    0,
    grid,
    0,
    strength,
    false
  );
  apply(sel.size > 0 ? 'Quantize Notes' : 'Quantize Take', (t, mine) => {
    notes.forEach((n, i) => {
      const note = mine(n);
      note.t = Math.max(t.floor, Math.min(t.end - 0.01, starts[i])) - t.start + t.offset;
    });
    t.sort();
  });
}

/** The bars around the selected notes of a take become the zone's loop */
function loopSelection(): void {
  const target = hooks.target();
  if (!target || target.kind !== 'take') return;
  const take = target.take;
  const notes = selectedOrdered(take);
  if (notes.length === 0) {
    toast('Select the notes to loop first (⌘A: all)');
    return;
  }
  const from = take.barLine(Math.min(...notes.map((n) => take.songOf(n))), 'floor');
  let to = take.barLine(Math.max(...notes.map((n) => take.songOf(n) + Math.min(n.d, 1))), 'ceil');
  if (to <= from) to = from + barTicks(take.sectionAt(from).meter);
  hooks.loopFrom(target.zone, take, from, to);
}

function selectAll(): void {
  const target = hooks.target();
  if (!target) return;
  sel = new Set(target.take.notes.filter((n) => inWindow(target.take, n)));
  hooks.invalidate();
}

// ---------------------------------------------------------------------------
// View

function fit(take: Take): void {
  const w = size.w - KEYS_W;
  const h = gridBottom() - RULER_H;
  view.ppt = Math.max(0.1, Math.min(16, w / (take.length * 1.04)));
  view.left = take.start - take.length * 0.02;
  const notes = take.visibleNotes();
  const lo = notes.length ? Math.min(...notes.map((n) => n.n)) : 60;
  const hi = notes.length ? Math.max(...notes.map((n) => n.n)) : 60;
  view.rowH = Math.max(6, Math.min(14, Math.floor(h / (hi - lo + 5))));
  view.top = Math.round((hi + lo) / 2 + rows() / 2);
  clampView();
}

function clampView(): void {
  view.top = Math.max(rows() - 1, Math.min(127, view.top));
}

function zoomAt(x: number, factor: number): void {
  const t = tickAt(x);
  view.ppt = Math.max(0.1, Math.min(16, view.ppt * factor));
  view.left = t - (x - KEYS_W) / view.ppt;
  hooks.invalidate();
}

function sizeCanvas(): CanvasRenderingContext2D | null {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return null;
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  size = { w, h };
  const g = canvas.getContext('2d')!;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return g;
}

/** Keep the note selection on the take across undo (same id: notes by index) */
function followTake(take: Take | null): void {
  // the same take with its notes replaced (undo of a take edit restores them) counts as another
  if (take === selTake && take?.notes === selNotes) return;
  const oldNotes = selNotes;
  if (take && selTake && take.id === selTake.id && oldNotes && take.notes.length === oldNotes.length) {
    sel = new Set([...sel].map((n) => take.notes[oldNotes.indexOf(n)]).filter(Boolean));
  } else {
    sel.clear();
    nextPaste = null;
  }
  selTake = take;
  selNotes = take?.notes ?? null;
}

function updateTools(target: TakeTarget | null): void {
  const title = root.querySelector('.tdn-title')!;
  const what = root.querySelector('.tdn-what')!;
  if (!target) {
    title.textContent = '';
    what.textContent = '';
    return;
  }
  const take = target.take;
  const count = take.visibleNotes().length;
  title.textContent = target.label;
  what.textContent = [
    Take.lengthLabel(take.length, target.meter),
    `${count} note${count === 1 ? '' : 's'}`,
    sel.size ? `${sel.size} selected` : ''
  ]
    .filter(Boolean)
    .join(' · ');
  root.querySelector('.tdn-delete')!.classList.toggle('disabled', sel.size === 0);
  root.querySelector('.tdn-quantize')!.textContent = sel.size ? 'Quantize selection' : `Quantize ${target.kind}`;
  // a take's bars can become the loop; the loop is already one
  const loop = root.querySelector('.tdn-loop') as HTMLElement;
  loop.style.display = target.kind === 'take' ? '' : 'none';
  loop.classList.toggle('disabled', sel.size === 0);
  root.querySelectorAll('[data-tdn-show]').forEach((b) => {
    const kind = (b as HTMLElement).dataset['tdnShow'];
    b.classList.toggle('on', kind === target.kind);
  });
}

/** Called by the track view's draw loop while the Notes tab is open */
function drawTakeEditor(): void {
  const target = hooks.target();
  followTake(target?.take ?? null);
  updateTools(target);
  root.classList.toggle('none', !target);
  const g = sizeCanvas();
  if (!g || !target) return;
  const { w, h } = size;
  const take = target.take;
  if (take.id !== fittedId) {
    fittedId = take.id;
    fit(take);
  }
  clampView();
  const colour = getComputedStyle(root).getPropertyValue('--zone-color').trim() || '#8fa3b8';
  const bottom = gridBottom();
  g.clearRect(0, 0, w, h);
  g.fillStyle = '#15171a';
  g.fillRect(KEYS_W, RULER_H, w - KEYS_W, bottom - RULER_H);
  // pitch rows: black keys darker, a line under each C
  g.save();
  g.beginPath();
  g.rect(0, RULER_H, w, bottom - RULER_H);
  g.clip();
  for (let n = view.top; n >= Math.max(0, view.top - rows()); n--) {
    const y = py(n);
    if (BLACK.includes(n % 12)) {
      g.fillStyle = '#0f1113';
      g.fillRect(KEYS_W, y, w - KEYS_W, view.rowH);
    }
    if (n % 12 === 0) {
      g.fillStyle = '#ffffff14';
      g.fillRect(KEYS_W, y + view.rowH - 1, w - KEYS_W, 1);
    }
  }
  // grid steps (when they're far enough apart), beats and bars
  const from = tickAt(KEYS_W);
  const to = tickAt(w);
  const gt = gridTicks();
  if (gt && gt * view.ppt >= 6) {
    g.fillStyle = '#ffffff08';
    for (let t = Math.ceil(from / gt) * gt; t <= to; t += gt)
      g.fillRect(Math.round(sx(t)), RULER_H, 1, bottom - RULER_H);
  }
  for (const { t, bar } of beatLines(meter(), Math.max(0, from), to)) {
    g.fillStyle = bar ? '#ffffff26' : '#ffffff12';
    g.fillRect(Math.round(sx(t)), RULER_H, 1, bottom - RULER_H);
  }
  // notes: the recording's, those trimmed away dim; a move or resize shows where they go
  const d = drag;
  for (const note of take.notes) {
    let s = take.songOf(note);
    let len = note.d;
    let n = note.n;
    const chosen = sel.has(note);
    if (chosen && d?.kind === 'move' && d.moved) {
      s += d.dt;
      n += d.dn;
    } else if (chosen && d?.kind === 'resize' && d.moved) {
      len = Math.max(0.5, len + d.dd);
    }
    const x0 = sx(s);
    const x1 = Math.max(x0 + 3, sx(s + len));
    if (x1 < KEYS_W || x0 > w || n > view.top || n < view.top - rows()) continue;
    const inside = inWindow(take, note);
    g.globalAlpha = inside ? 0.5 + (0.5 * note.v) / 127 : 0.25;
    g.fillStyle = colour;
    g.fillRect(x0, py(n) + 1, x1 - x0 - 1, view.rowH - 2);
    if (chosen) {
      g.globalAlpha = 1;
      g.strokeStyle = '#ffffff';
      g.lineWidth = 1.5;
      g.strokeRect(x0 + 0.75, py(n) + 1.75, x1 - x0 - 2.5, view.rowH - 3.5);
    }
  }
  g.globalAlpha = 1;
  // past its end: shaded
  const winStart = take.start;
  const winEnd = take.end;
  g.fillStyle = '#000000a0';
  g.fillRect(KEYS_W, RULER_H, Math.max(0, sx(winStart) - KEYS_W), bottom - RULER_H);
  g.fillRect(sx(winEnd), RULER_H, Math.max(0, w - sx(winEnd)), bottom - RULER_H);
  if (d?.kind === 'box' && d.moved) {
    g.fillStyle = '#ffffff14';
    g.strokeStyle = '#ffffff99';
    g.lineWidth = 1;
    const bx = Math.min(d.x0, d.x1);
    const by = Math.min(d.y0, d.y1);
    g.fillRect(bx, by, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
    g.strokeRect(bx + 0.5, by + 0.5, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
  }
  g.restore();

  // keys
  g.fillStyle = '#1c1f23';
  g.fillRect(0, RULER_H, KEYS_W, bottom - RULER_H);
  g.font = '10px "Barlow Semi Condensed", sans-serif';
  g.textBaseline = 'middle';
  for (let n = view.top; n >= Math.max(0, view.top - rows()); n--) {
    const y = py(n);
    if (y + view.rowH > bottom) break;
    if (BLACK.includes(n % 12)) {
      g.fillStyle = '#0f1113';
      g.fillRect(0, y, KEYS_W * 0.6, view.rowH);
    }
    if (n % 12 === 0 || view.rowH >= 12) {
      g.fillStyle = n % 12 === 0 ? '#cfd6df' : '#8b95a3';
      if (!BLACK.includes(n % 12) || view.rowH >= 12)
        g.fillText(`${NOTE_NAMES[n % 12]}${Math.floor(n / 12) - 1}`, 4, y + view.rowH / 2);
    }
  }

  // ruler: bars, its start and end marked
  g.fillStyle = '#1c1f23';
  g.fillRect(0, 0, w, RULER_H);
  g.font = '11px "Barlow Semi Condensed", sans-serif';
  g.textBaseline = 'alphabetic';
  const barLen = barTicks(meter());
  const every = Math.max(1, Math.ceil(50 / (barLen * view.ppt)));
  beatLines(meter(), Math.max(0, from), to).forEach((l) => {
    if (!l.bar) return;
    const x = Math.round(sx(l.t));
    if (x < KEYS_W) return;
    g.fillStyle = '#4a525d';
    g.fillRect(x, RULER_H - 6, 1, 6);
    const no = Math.round(l.t / barLen) + 1;
    if ((no - 1) % every === 0) {
      g.fillStyle = '#8b95a3';
      g.fillText(String(no), x + 3, RULER_H - 5);
    }
  });
  g.fillStyle = '#cfd6df';
  for (const x of [sx(winStart), sx(winEnd)]) {
    if (x < KEYS_W - 1 || x > w + 1) continue;
    g.fillRect(Math.round(x) - 1, 2, 2, RULER_H - 2);
  }
  g.globalAlpha = 0.3;
  g.fillRect(
    Math.max(KEYS_W, sx(winStart)),
    2,
    Math.max(0, Math.min(w, sx(winEnd)) - Math.max(KEYS_W, sx(winStart))),
    4
  );
  g.globalAlpha = 1;

  // velocity lane
  const vy = h - VEL_H;
  g.fillStyle = '#1c1f23';
  g.fillRect(0, vy, w, VEL_H);
  g.fillStyle = '#8b95a3';
  g.font = '10px "Barlow Semi Condensed", sans-serif';
  g.fillText('Vel', 6, vy + 14);
  g.save();
  g.beginPath();
  g.rect(KEYS_W, vy, w - KEYS_W, VEL_H);
  g.clip();
  for (const note of take.notes) {
    if (!inWindow(take, note)) continue;
    const x = sx(take.songOf(note) + (sel.has(note) && d?.kind === 'move' && d.moved ? d.dt : 0));
    if (x < KEYS_W - 4 || x > w) continue;
    let v = note.v;
    if (d?.kind === 'vel' && d.moved && d.notes.includes(note)) v = Math.max(1, Math.min(127, v + d.dv));
    const bh = (v / 127) * (VEL_H - 6);
    g.fillStyle = sel.has(note) ? '#ffffff' : colour;
    g.globalAlpha = sel.has(note) ? 0.9 : 0.7;
    g.fillRect(x, h - bh, 3, bh);
    g.fillRect(x, h - bh, 6, 1.5);
  }
  g.restore();
  g.globalAlpha = 1;

  // playhead
  const head = target.playhead();
  if (head !== null) {
    const x = sx(head);
    if (x >= KEYS_W && x <= w) {
      g.fillStyle = '#e7eaee';
      g.fillRect(Math.round(x), RULER_H, 1, h - RULER_H);
    }
  }
}

// ---------------------------------------------------------------------------
// Pointer

function point(ev: MouseEvent): { x: number; y: number } {
  const r = canvas.getBoundingClientRect();
  return { x: ev.clientX - r.left, y: ev.clientY - r.top };
}

function noteAt(take: Take, x: number, y: number): { note: TakeNoteJSON; edge: boolean } | null {
  if (y < RULER_H || y >= gridBottom() || x < KEYS_W) return null;
  const n = pitchAt(y);
  for (let i = take.notes.length - 1; i >= 0; i--) {
    const note = take.notes[i];
    if (note.n !== n || !inWindow(take, note)) continue;
    const x0 = sx(take.songOf(note));
    const x1 = Math.max(x0 + 3, sx(take.songOf(note) + note.d));
    if (x >= x0 && x <= x1) return { note, edge: x1 - x0 > 8 && x >= x1 - EDGE_PX };
  }
  return null;
}

function velocityNoteAt(take: Take, x: number): TakeNoteJSON | null {
  let best: TakeNoteJSON | null = null;
  let bestDx = 5;
  for (const note of take.notes) {
    if (!inWindow(take, note)) continue;
    const dx = Math.abs(x - (sx(take.songOf(note)) + 1.5));
    if (dx < bestDx) {
      bestDx = dx;
      best = note;
    }
  }
  return best;
}

/** (Edges don't drag: a loop's or take's length stays) */
function edgeAt(_take: Take, _x: number, _y: number): 'start' | 'end' | null {
  return null;
}

function onMouseDown(ev: MouseEvent): void {
  const target = hooks.target();
  if (ev.button !== 0 || !target) return;
  ev.preventDefault();
  (document.activeElement as HTMLElement | null)?.blur();
  focused = true;
  const take = target.take;
  const { x, y } = point(ev);
  const additive = ev.shiftKey || ev.metaKey || ev.ctrlKey;
  const edge = edgeAt(take, x, y);
  if (edge) {
    drag = {
      kind: 'edge',
      edge,
      start: take.start,
      length: take.length,
      offset: take.offset,
      moved: false
    };
  } else if (y >= size.h - VEL_H) {
    const note = velocityNoteAt(take, x);
    if (!note) return;
    const notes = sel.has(note) ? selectedOrdered(take) : [note];
    drag = { kind: 'vel', y0: y, notes, dv: 0, moved: false };
  } else if (y >= RULER_H && y < gridBottom() && x >= KEYS_W) {
    const hit = noteAt(take, x, y);
    if (hit) {
      lastVelo = hit.note.v;
      let toggle: TakeNoteJSON | null = null;
      if (additive && sel.has(hit.note))
        toggle = hit.note; // a click without moving takes it out
      else if (additive) sel.add(hit.note);
      else if (!sel.has(hit.note)) sel = new Set([hit.note]);
      preview(target.zone, hit.note.n, hit.note.v);
      drag = hit.edge
        ? { kind: 'resize', x0: x, note: hit.note, dd: 0, moved: false }
        : { kind: 'move', x0: x, y0: y, dt: 0, dn: 0, moved: false, toggle };
    } else {
      drag = {
        kind: 'box',
        x0: x,
        y0: y,
        x1: x,
        y1: y,
        base: additive ? new Set(sel) : new Set(),
        moved: false,
        additive
      };
    }
  }
  hooks.invalidate();
}

function onMouseMove(ev: MouseEvent): void {
  const target = hooks.target();
  if (!target) return;
  const take = target.take;
  const { x, y } = point(ev);
  if (!drag) {
    if (ev.buttons) return;
    const edge = edgeAt(take, x, y);
    const hit = edge ? null : noteAt(take, x, y);
    const cursor = edge || hit?.edge ? 'ew-resize' : hit ? 'grab' : '';
    if (canvas.style.cursor !== cursor) canvas.style.cursor = cursor;
    return;
  }
  const gt = ev.altKey ? 0 : gridTicks();
  if (drag.kind === 'move') {
    if (!drag.moved && Math.hypot(x - drag.x0, y - drag.y0) < DRAG_PX) return;
    drag.moved = true;
    const raw = (x - drag.x0) / view.ppt;
    const dn = -Math.round((y - drag.y0) / view.rowH);
    const moved = clampMove(take, selectedOrdered(take), gt ? Math.round(raw / gt) * gt : raw, dn);
    if (moved.dn !== drag.dn && sel.size) {
      const first = selectedOrdered(take)[0];
      preview(target.zone, first.n + moved.dn, first.v);
    }
    drag.dt = moved.dt;
    drag.dn = moved.dn;
  } else if (drag.kind === 'resize') {
    if (!drag.moved && Math.abs(x - drag.x0) < DRAG_PX) return;
    drag.moved = true;
    const end = take.songOf(drag.note) + drag.note.d;
    let to = end + (x - drag.x0) / view.ppt;
    if (gt) to = Math.round(to / gt) * gt;
    const min = gt || 1;
    to = Math.max(take.songOf(drag.note) + min, to);
    drag.dd = to - end;
  } else if (drag.kind === 'box') {
    drag.x1 = x;
    drag.y1 = y;
    if (!drag.moved && Math.hypot(x - drag.x0, y - drag.y0) < DRAG_PX) return;
    drag.moved = true;
    const left = Math.min(drag.x0, x);
    const right = Math.max(drag.x0, x);
    const top = Math.min(drag.y0, y);
    const bottom = Math.max(drag.y0, y);
    sel = new Set(drag.base);
    for (const note of take.notes) {
      if (!inWindow(take, note)) continue;
      const x0 = sx(take.songOf(note));
      const x1 = Math.max(x0 + 3, sx(take.songOf(note) + note.d));
      const y0 = py(note.n);
      if (x0 < right && x1 > left && y0 < bottom && y0 + view.rowH > top) sel.add(note);
    }
  } else if (drag.kind === 'vel') {
    if (!drag.moved && Math.abs(y - drag.y0) < 1) return;
    drag.moved = true;
    drag.dv = Math.round((-(y - drag.y0) / (VEL_H - 6)) * 127);
  }
  hooks.invalidate();
}

function onMouseUp(): void {
  const d = drag;
  drag = null;
  if (!d) return;
  const target = hooks.target();
  if (!target) return;
  const take = target.take;
  if (d.kind === 'move') {
    if (!d.moved) {
      if (d.toggle) sel.delete(d.toggle);
    } else {
      moveSelected(d.dt, d.dn);
    }
  } else if (d.kind === 'resize' && d.moved && d.dd !== 0) {
    const notes = selectedOrdered(take);
    const dd = d.dd;
    apply('Change Note Length', (_t, mine) => {
      for (const n of notes.map(mine)) n.d = Math.max(0.5, n.d + dd);
    });
  } else if (d.kind === 'box' && !d.moved && !d.additive) {
    addNote(tickAt(d.x0), pitchAt(d.y0));
  } else if (d.kind === 'vel' && d.moved && d.dv !== 0) {
    const dv = d.dv;
    apply('Change Velocity', (_t, mine) => {
      for (const n of d.notes.map(mine)) n.v = Math.max(1, Math.min(127, n.v + dv));
    });
    lastVelo = Math.max(1, Math.min(127, d.notes[0].v + dv));
  }
  hooks.invalidate();
}

function onWheel(ev: WheelEvent): void {
  if (!hooks.target()) return;
  ev.preventDefault();
  const { x } = point(ev);
  if (ev.metaKey || ev.ctrlKey) {
    zoomAt(Math.max(KEYS_W, x), Math.exp(-ev.deltaY * 0.01));
    return;
  }
  const dx = ev.deltaX !== 0 ? ev.deltaX : ev.shiftKey ? ev.deltaY : 0;
  if (dx !== 0) view.left += dx / view.ppt;
  else view.top += ev.deltaY > 0 ? -2 : 2;
  clampView();
  hooks.invalidate();
}

// ---------------------------------------------------------------------------
// Keys: while the editor was the last place pressed

function isShowing(): boolean {
  return canvas.clientWidth > 0 && !root.classList.contains('none');
}

function onKeyDown(ev: KeyboardEvent): void {
  if (!focused || !isShowing()) return;
  const mod = ev.metaKey || ev.ctrlKey;
  if (mod && ev.code === 'KeyZ') return; // undo / redo: the app's
  if ((ev.target as Element | null)?.closest?.('input, select, textarea')) return;
  if (ev.code === 'Space') return; // play / stop
  const target = hooks.target();
  if (!target) return;
  const step = gridTicks() || unitTicks(meter()) / 4;
  const beat = unitTicks(meter());
  const arrows: Record<string, [number, number]> = {
    ArrowLeft: [-(ev.shiftKey ? beat : step), 0],
    ArrowRight: [ev.shiftKey ? beat : step, 0],
    ArrowUp: [0, ev.shiftKey ? 12 : 1],
    ArrowDown: [0, ev.shiftKey ? -12 : -1]
  };
  let handled = true;
  if (mod && ev.code === 'KeyA') selectAll();
  else if (mod && (ev.code === 'KeyC' || ev.code === 'KeyX')) {
    const count = sel.size;
    if (copySelection()) {
      if (ev.code === 'KeyX') deleteSelected('Cut Notes');
      else toast(`Copied ${count} note${count === 1 ? '' : 's'}`);
    }
  } else if (mod && ev.code === 'KeyV') {
    if (!clipboard) toast('Nothing to paste: copy notes first (⌘C)');
    else {
      const at = nextPaste ?? target.take.start;
      paste(at, 'Paste Notes');
      nextPaste = at + clipboard.span;
    }
  } else if (mod && ev.code === 'KeyD') {
    if (copySelection() && clipboard) {
      paste(nextPaste!, 'Duplicate Notes');
      nextPaste! += clipboard.span;
    }
  } else if (arrows[ev.key] && !mod && !ev.altKey) moveSelected(...arrows[ev.key]);
  else if (ev.key === 'Backspace' || ev.key === 'Delete') deleteSelected();
  else if (ev.key === 'Escape') {
    if (drag) drag = null;
    else if (sel.size) sel.clear();
    else focused = false;
  } else handled = false;
  if (!handled) return;
  // the app's shortcuts (and the lanes' take keys) stay out of it
  ev.preventDefault();
  ev.stopPropagation();
  hooks.invalidate();
}

function initTakeEditor(h: TakeEditorHooks): void {
  hooks = h;
  root = document.querySelector('#trackDock .td-notes') as HTMLElement;
  canvas = root.querySelector('canvas') as HTMLCanvasElement;
  const select = root.querySelector('.tdn-grid') as HTMLSelectElement;
  select.innerHTML =
    GRIDS.map((i) => `<option value="${i}">${DIV_NAMES[i]}</option>`).join('') + '<option value="-1">Off</option>';
  select.value = String(grid);
  select.addEventListener('change', () => {
    grid = Number(select.value);
    localStorage.setItem(GRID_KEY, String(grid));
    select.blur();
    hooks.invalidate();
  });
  const strengthSel = root.querySelector('.tdn-strength') as HTMLSelectElement;
  strengthSel.addEventListener('change', () => {
    strength = Number(strengthSel.value) / 100;
    strengthSel.blur();
  });
  root.querySelector('.tdn-quantize')!.addEventListener('click', quantizeSelection);
  root.querySelector('.tdn-delete')!.addEventListener('click', () => deleteSelected());
  root.querySelector('.tdn-loop')!.addEventListener('click', loopSelection);
  root.querySelectorAll('[data-tdn-show]').forEach((b) =>
    b.addEventListener('click', () => {
      hooks.show((b as HTMLElement).dataset['tdnShow'] as 'loop' | 'take');
      fittedId = '';
    })
  );
  root.querySelector('.tdn-fit')!.addEventListener('click', () => {
    const target = hooks.target();
    if (target) fit(target.take);
    hooks.invalidate();
  });
  root
    .querySelectorAll('[data-tdn-zoom]')
    .forEach((b) =>
      b.addEventListener('click', () =>
        zoomAt(KEYS_W + (size.w - KEYS_W) / 2, Number((b as HTMLElement).dataset['tdnZoom']) > 0 ? 1.5 : 1 / 1.5)
      )
    );
  canvas.addEventListener('mousedown', onMouseDown);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
  document.addEventListener('keydown', onKeyDown, true);
  // a press anywhere else hands the keys back
  document.addEventListener(
    'mousedown',
    (ev) => {
      if (!root.contains(ev.target as Node)) focused = false;
    },
    true
  );
}

/** Open on a take: fit it into view again */
function refitTakeEditor(): void {
  fittedId = '';
}

export { initTakeEditor, drawTakeEditor, refitTakeEditor };
