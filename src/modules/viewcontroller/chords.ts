/**
 * Chords zones: a zone set to "Play chords" or "Play bass" (⋯ menu) plays to another zone's
 * line. While running and without its loop playing it follows live (one decision per line,
 * zone/live-chords.ts, so a chords and a bass zone on one line agree); its loop is made of
 * the chords (Loop chip on a chords zone without a loop, or when the line zone closes a loop),
 * and remembers them (`Zone.chordPlan`) for its chord names and for redoing it when a setting
 * changes. The block (`.chords-block` in the zone template) holds Follows, Rhythm, two pads,
 * More and Another; in the track view it is the dock's Chords tab.
 */
import { Zone } from '../zone/zone-class';
import { Take } from '../zone/take';
import { Meter, barTicks } from '../meter';
import { takeStore } from '../take-store';
import { timeline, nowTick, NoteHistory } from '../timeline';
import { escapeHTML } from '../domutils';
import { toast } from './toast';
import { harmonize, progress, segmentsOf, chordName, keyName, RHYTHMS, LineNote, Chord, Key } from '../zone/harmonize';
import { LiveChords, HeardNote, Follower, Send, heardChords } from '../zone/live-chords';
import { ChordPart, ChordPlan, ChordSettings, DEFAULT_CHORD_SETTINGS, harmonyOptions, loopSig } from '../zone/chord-settings';
import MIDI from '../midi';

interface Hooks {
  zones: () => Zone[];
  /** one undo step changing the zones at `indices` */
  commit: (indices: number[], label: string, change: () => void) => void;
  meter: () => Meter;
}

let hooks: Hooks;

// ------------------------------------------------------------------------------ zones

/** The zone a chords zone follows (null: none or gone) */
export function lineZoneOf(zone: Zone): Zone | null {
  if (!zone.chords) return null;
  return hooks.zones().find((z) => z.id === zone.chords!.follows && z !== zone && !z.chords) ?? null;
}

/** The chords and bass zones following `line`: chords first (their settings choose the chords) */
function followersOf(line: Zone): Zone[] {
  const zs = hooks.zones();
  return zs
    .filter((z) => z.chords && z.chords.follows === line.id && z !== line)
    .sort((a, b) => Number(a.chords!.part === 'bass') - Number(b.chords!.part === 'bass') || zs.indexOf(a) - zs.indexOf(b));
}

/** "1 Lead line", "Zone 3 line" */
export function lineLabel(z: Zone): string {
  const i = hooks.zones().indexOf(z);
  return z.label ? `${i + 1} ${z.label} line` : `Zone ${i + 1} line`;
}

function zoneName(z: Zone): string {
  return z.label || `Zone ${hooks.zones().indexOf(z) + 1}`;
}

/** Who a new chords zone follows: a zone with a loop, else with a sequence, else the first */
function defaultLine(zone: Zone): string {
  const cands = hooks.zones().filter((z) => z !== zone && !z.chords);
  const pick = cands.find((z) => z.loop) ?? cands.find((z) => lineOf(z)) ?? cands[0];
  return pick?.id ?? '';
}

/** The zone's line: its loop, else its melodic sequence, else its shown take */
function lineOf(zone: Zone): { notes: LineNote[]; length: number; anchor: number } | null {
  if (zone.loop && zone.loop.notes.length) {
    return { notes: zone.loop.notes.map((n) => ({ t: n.t, d: n.d, n: n.n, v: n.v })), length: zone.loop.length, anchor: zone.looper.anchor };
  }
  const seq = zone.sequence;
  if (!seq.isDrumSequence && seq.steps.some((s) => s && s.notesArray.length)) {
    const ticks = seq.ticks;
    const notes: LineNote[] = [];
    seq.steps.slice(0, seq.length).forEach((s, i) => {
      if (!s) return;
      for (const note of s.notesArray) notes.push({ t: i * ticks, d: Math.max(1, s.length * ticks * s.gateLength), n: note.number, v: note.velo });
    });
    return { notes, length: seq.length * ticks, anchor: 0 };
  }
  const shown = takeStore.shownTake(zone.id);
  if (shown) {
    const vis = shown.visibleNotes();
    if (vis.length) {
      const bar = barTicks(hooks.meter());
      const from = Math.floor(vis[0].s / bar) * bar;
      let end = 0;
      for (const n of vis) end = Math.max(end, n.s + n.d);
      const length = Math.max(bar, Math.ceil((end - from - 6) / bar) * bar);
      return { notes: vis.map((n) => ({ t: n.s - from, d: n.d, n: n.n, v: n.v })).filter((n) => n.t >= 0 && n.t < length), length, anchor: -1 };
    }
  }
  return null;
}

// ------------------------------------------------------------------------------ live

/** One decision per followed line (by its zone id) */
const deciders = new Map<string, LiveChords>();
/** After the chords were switched on: the line's notes before this (session position) aren't heard */
const freshFrom = new Map<string, number>();

const send: Send = (out, on, n, v) => {
  const zone = out as Zone;
  const status = on ? MIDI.MESSAGE.NOTE_ON : MIDI.MESSAGE.NOTE_OFF;
  zone.handleMidi(status, Uint8Array.from([status, n, on ? v : 0]), true);
};

/** Plays live: switched on, and its loop isn't playing */
function playsLive(z: Zone): boolean {
  return !!z.chords && z.chordsOn && !(z.loop && z.loopOn);
}

/** The line as played, at song positions: what is played into the zone (also muted) and what its loop and sequence play */
function heard(line: Zone, songPos: number, meter: Meter): HeardNote[] {
  const offset = timeline.runStart + timeline.sectionStart;
  const now = offset + songPos;
  const from = Math.max(now - 9 * barTicks(meter), offset, freshFrom.get(line.id) ?? -Infinity);
  const take = (h: NoteHistory, played: boolean) =>
    h
      .between(from, now + 1)
      .filter((n) => n.start >= from && (played || !n.live))
      .map((n) => ({ s: n.start - offset, d: Math.max(1, (n.end ?? now) - n.start), n: n.pitch, v: n.velo, held: n.end === null }));
  return [...take(line.inputHistory, true), ...take(line.noteHistory, false)].sort((a, b) => a.s - b.s);
}

/** Every clock tick (run position): the live chords */
export function chordsTick(pos: number): void {
  if (!hooks) return;
  const zs = hooks.zones();
  const meter = hooks.meter();
  const songPos = pos - timeline.sectionStart;
  const seen = new Set<string>();
  for (const line of zs) {
    if (line.chords) continue;
    const fs = followersOf(line).filter(playsLive);
    let d = deciders.get(line.id);
    if (!fs.length) {
      if (d) d.stop(send);
      continue;
    }
    if (!d) deciders.set(line.id, (d = new LiveChords()));
    seen.add(line.id);
    const followers: Follower[] = fs.map((z) => ({ id: z.id, part: z.chords!.part, o: harmonyOptions(z.chordSet), out: z }));
    d.tick(songPos, heard(line, songPos, meter), followers, meter, send);
  }
  for (const [id, d] of deciders) if (!seen.has(id)) d.stop(send);
  updateChordChips();
}

/** Start, Stop, an arrangement switch: live chords start over (the key stays) */
export function chordsTransport(started: boolean): void {
  for (const d of deciders.values()) {
    d.stop(send);
    d.log.clear();
  }
  void started;
  updateChordChips();
}

/** Panic: the synths were reset */
export function chordsPanic(): void {
  for (const d of deciders.values()) d.forget();
}

/** Switched on: the line's decider starts fresh (a new key, listening from now) */
function freshStart(line: Zone): void {
  const d = deciders.get(line.id);
  if (d) d.reset(send);
  freshFrom.set(line.id, timeline.running ? timeline.runStart + nowTick() : -Infinity);
}

// ------------------------------------------------------------------------------ loops

function loopOf(notes: LineNote[], length: number): Take {
  const take = new Take();
  take.start = 0;
  take.length = length;
  take.notes = notes.map((n) => ({ t: n.t, d: n.d, n: n.n, v: n.v })).sort((a, b) => a.t - b.t);
  return take;
}

/** A plan still matching its loop (the loop's notes weren't edited another way) */
function planOf(zone: Zone): ChordPlan | null {
  const p = zone.chordPlan;
  return p && zone.loop && p.sig === loopSig(zone.loop) && p.length === zone.loop.length ? p : null;
}

/** The decision settings: the lead zone's (the first chords zone on the line) */
function leadOf(line: Zone): ChordSettings {
  return followersOf(line)[0]?.chordSet ?? DEFAULT_CHORD_SETTINGS;
}

/** Writes a follower's loop from a plan (inside a commit) */
function renderLoop(z: Zone, src: { notes: LineNote[]; length: number }, plan: { key: Key; chords: (Chord | null)[]; length: number }, lead: ChordSettings, anchor: number): void {
  const o = {
    ...harmonyOptions(z.chordSet),
    harmony: lead.harmony,
    changes: lead.changes,
    seed: lead.seed,
    frozen: plan.chords,
    key: plan.key
  };
  const acc = harmonize(src.notes, src.length, hooks.meter(), o);
  const notes = z.chords!.part === 'bass' ? acc.bass : acc.notes;
  z.loop = loopOf(notes, src.length);
  z.loopOn = true;
  z.loopPlayer.release(true);
  z.looper.anchor = anchor;
  z.chordPlan = { key: acc.progression.key, length: src.length, chords: acc.progression.chords, sig: loopSig(z.loop) };
}

/** Where a chord loop's bar 1 goes: with the line's loop; a take lines up at the next bar */
function anchorFor(src: { anchor: number }): number {
  if (src.anchor >= 0) return src.anchor;
  if (!timeline.running) return 0;
  const bar = barTicks(hooks.meter());
  return Math.ceil((nowTick() - timeline.sectionStart) / bar) * bar;
}

/**
 * The line's chords as loops of its followers (`which`; one undo step). `fromLive`: the chords
 * heard while it played are kept; `fresh`: chosen anew (Harmony, Changes, Another), else each
 * keeps its own plan where it has one
 */
function makeLoops(line: Zone, which: Zone[], label: string, fromLive: boolean): boolean {
  const src = lineOf(line);
  if (!src) {
    toast(`${escapeHTML(lineLabel(line))} has no loop or sequence yet: record a loop there first`);
    return false;
  }
  const busy = which.find((z) => z.looper.mode !== 'idle');
  if (busy) {
    toast(`${escapeHTML(zoneName(busy))}: its loop is being recorded, finish that first`);
    return false;
  }
  const meter = hooks.meter();
  const lead = leadOf(line);
  let frozen: (Chord | null)[] | undefined;
  let key: Key | undefined;
  const d = deciders.get(line.id);
  if (fromLive && d && timeline.running) {
    const songNow = nowTick() - timeline.sectionStart;
    frozen = heardChords(d.log, segmentsOf(src.length, meter), src.length, src.anchor >= 0 ? src.anchor : 0, songNow);
    if (!frozen.some((c) => c)) frozen = undefined;
    if (d.key) key = d.key;
  }
  const p = progress(src.notes, src.length, meter, { ...harmonyOptions(lead), ...(frozen ? { frozen } : {}), ...(key ? { key } : {}) });
  const plan = { key: p.key, chords: p.chords as (Chord | null)[], length: src.length };
  const zs = hooks.zones();
  const anchor = anchorFor(src);
  hooks.commit(
    which.map((z) => zs.indexOf(z)),
    label,
    () => which.forEach((z) => renderLoop(z, src, plan, lead, anchor))
  );
  return true;
}

/** Loop chip of a chords zone without a loop: the chords heard (and the rest worked out) become the loop */
export function keepChords(zone: Zone): void {
  const line = lineZoneOf(zone);
  if (!line) {
    toast(`${escapeHTML(zoneName(zone))}: pick the line it follows first`);
    return;
  }
  // the line's other followers get theirs too, so chords and bass stay together
  makeLoops(line, followersOf(line).filter((z) => z === zone || (z.chordsOn && !planOf(z))), 'Keep Chords', true);
}

/** The line zone recorded or overdubbed its loop (an undo step already): its followers' chords become loops */
export function chordsLineLoopChanged(line: Zone): void {
  if (!hooks || line.chords) return;
  // followers set to follow live (their loop off) or with a loop edited by hand keep theirs
  const fs = followersOf(line).filter((z) => z.chordsOn && (!z.loop || (z.loopOn && planOf(z))));
  if (fs.length) makeLoops(line, fs, 'Chords', true);
}

/** A chords zone's Loop chip switched on again: in step with the line */
export function alignToLine(zone: Zone): void {
  const line = lineZoneOf(zone);
  const src = line && lineOf(line);
  if (src && zone.loop && src.anchor >= 0 && zone.loop.length === src.length) zone.looper.anchor = src.anchor;
}

// ------------------------------------------------------------------------------ role and switch

/** ⋯ menu: Play chords / Play bass (inside the action's undo step) */
export function playChords(zone: Zone, part: ChordPart): void {
  zone.setChordRole({ part, follows: zone.chords?.follows || defaultLine(zone) });
  zone.chordsOn = true;
  // a loop it had (not made of chords) is kept, switched off: the zone follows live
  if (zone.loop && !planOf(zone)) zone.setLoopOn(false);
  const line = lineZoneOf(zone);
  if (line) freshStart(line);
}

/** ⋯ menu: Stop playing chords: a normal zone again, its Seq and Arp switches back */
export function stopChords(zone: Zone): void {
  zone.setChordRole(null);
}

/** The chip: chords on/off (on: listening anew) */
export function toggleChords(zone: Zone): void {
  zone.setChordsOn(!zone.chordsOn);
  if (zone.chordsOn) {
    const line = lineZoneOf(zone);
    if (line && !followersOf(line).some((z) => z !== zone && playsLive(z))) freshStart(line);
  }
}

/** ⋯ menu entries for a zone */
export function chordsMenu(index: number): string[] {
  const zone = hooks?.zones()[index];
  if (!zone) return [];
  if (zone.chords) return [...(zone.loop ? [`${index}:zone_chords_clear`] : []), `${index}:zone_chords_stop`];
  // a zone others follow can't follow itself
  if (hooks.zones().some((z) => z.chords?.follows === zone.id)) return [];
  return [`${index}:zone_chords_play:chords`, `${index}:zone_chords_play:bass`];
}

// ------------------------------------------------------------------------------ chip and lanes

/** The chord sounding (or, stopped, the loop's first one) */
function chordNow(zone: Zone): string {
  const line = lineZoneOf(zone);
  const plan = planOf(zone);
  if (zone.loop && zone.loopOn && plan) {
    let at = 0;
    if (timeline.running) {
      const songNow = nowTick() - timeline.sectionStart;
      at = (((songNow - zone.looper.anchor) % plan.length) + plan.length) % plan.length;
    }
    const segs = segmentsOf(plan.length, hooks.meter());
    const i = segs.findIndex((s) => at >= s.t && at < s.end);
    const c = plan.chords[Math.max(0, i)];
    return c ? chordName(c) : '–';
  }
  if (timeline.running && line && zone.chordsOn) {
    const d = deciders.get(line.id);
    if (d?.chord) return chordName(d.chord);
  }
  return '–';
}

/** The chips of chords zones show the chord */
export function updateChordChips(): void {
  if (!hooks) return;
  hooks.zones().forEach((z) => {
    if (!z.chords) return;
    const chip = z.elements?.zoneElement?.querySelector<HTMLElement>('.channels .showchords');
    if (!chip) return;
    const text = chordNow(z);
    if (chip.textContent !== text) {
      chip.textContent = text;
      chip.classList.toggle('long', text.length > 4);
    }
    const line = lineZoneOf(z);
    const what = z.chords.part === 'bass' ? 'Bass' : 'Chords';
    const title = !line
      ? `${what} on/off · not following a line yet (choose one in its settings)`
      : `${what} on/off · follows ${lineLabel(line)}${deciders.get(line.id)?.key ? ' · ' + keyName(deciders.get(line.id)!.key!) : ''}`;
    if (chip.title !== title) chip.title = title;
  });
}

/** Chord names for a zone's lane between song positions: its loop's chords, or the ones played live */
export function chordMarks(zone: Zone, from: number, to: number): { s: number; name: string }[] {
  if (!hooks || !zone.chords) return [];
  const out: { s: number; name: string }[] = [];
  const plan = planOf(zone);
  if (zone.loop && zone.loopOn && plan) {
    // where the chord changes (the same chord over several beats is one name)
    const segs = segmentsOf(plan.length, hooks.meter());
    const changes: { t: number; name: string }[] = [];
    segs.forEach((seg, i) => {
      const c = plan.chords[i];
      const name = c ? chordName(c) : '';
      if (name && (!changes.length || changes[changes.length - 1].name !== name)) changes.push({ t: seg.t, name });
    });
    // the loop plays from its anchor (bar 1 when stopped), not before
    const anchor = zone.looper.anchor;
    const first = Math.max(0, Math.floor((from - anchor) / plan.length) - 1);
    for (let k = first; anchor + k * plan.length < to; k++) {
      changes.forEach((c, j) => {
        const at = anchor + k * plan.length + c.t;
        // a cycle starts with its first chord's name even when the last one was the same
        if (j === 0 || at >= from) out.push({ s: at, name: c.name });
      });
    }
    return out.filter((m) => m.s < to);
  }
  const line = lineZoneOf(zone);
  const d = line && deciders.get(line.id);
  if (!d) return out;
  let last = '';
  [...d.log.entries()]
    .sort((a, b) => a[0] - b[0])
    .forEach(([s, c]) => {
      const name = chordName(c);
      if (name !== last && s >= from - 4 * barTicks(hooks.meter()) && s < to) out.push({ s, name });
      last = name;
    });
  return out;
}

// ------------------------------------------------------------------------------ the block

const moreOpen = new Set<string>();

interface PadSpec {
  name: string;
  x: keyof ChordSettings;
  y: keyof ChordSettings;
  left: string;
  right: string;
  bottom: string;
  top: string;
  title: string;
}

const PADS: Record<ChordPart, PadSpec[]> = {
  chords: [
    { name: 'Harmony', x: 'harmony', y: 'colour', left: 'Fifths', right: 'Modal', bottom: 'Triads', top: '7 / 9', title: 'Left: chords along the circle of fifths, right: modal. Down: triads, up: sevenths and ninths (double-click: middle)' },
    { name: 'Feel', x: 'length', y: 'accents', left: 'Stabs', right: 'Legato', bottom: 'On-beat', top: 'Off-beat', title: 'Left: short stabs, right: held. Down: accents on the beat, up: off the beat (double-click: middle)' }
  ],
  bass: [
    { name: 'Bass', x: 'bass', y: 'length', left: 'Roots', right: 'Walking', bottom: 'Stabs', top: 'Legato', title: 'Left: the roots held, right: walking with approach notes. Down: short, up: held (double-click: middle)' },
    { name: 'Feel', x: 'sync', y: 'vary', left: 'Straight', right: 'Syncopated', bottom: 'Even', top: 'Loose', title: 'Left: straight, right: anticipations, off-beats and pickups. Down: even, up: loose velocities (double-click: straight)' }
  ]
};

interface SliderSpec {
  k: keyof ChordSettings;
  label: string;
  left: string;
  right: string;
  min?: number;
  max?: number;
  step?: number;
  title: string;
}

const MORE: Record<ChordPart, SliderSpec[]> = {
  chords: [
    { k: 'changes', label: 'Changes', left: 'Slow', right: 'Fast', title: 'How often the chord changes' },
    { k: 'unfold', label: 'Build-up', left: 'Together', right: 'Unfold', title: 'Chords rolled, the 7th and 9th coming in later' },
    { k: 'register', label: 'Register', left: 'Lower', right: 'Higher', min: -12, max: 12, step: 1, title: 'Where the chords sit: semitones down or up (double-click: back to 0)' },
    { k: 'tensions', label: 'Tensions', left: 'Softer', right: 'Louder', title: 'The 7th, 9th and b5 softer or louder than the triad' },
    { k: 'vary', label: 'Vary', left: 'Even', right: 'Loose', title: 'Velocities vary' }
  ],
  bass: [
    { k: 'accents', label: 'Accents', left: 'On-beat', right: 'Off-beat', title: 'Louder on the beat or off it' },
    { k: 'harmony', label: 'Harmony', left: 'Fifths', right: 'Modal', title: 'Only when no chords zone follows the same line (that one chooses the chords)' },
    { k: 'changes', label: 'Changes', left: 'Slow', right: 'Fast', title: 'How often the chord changes (when no chords zone follows the same line)' }
  ]
};

const MIDDLE: Partial<Record<keyof ChordSettings, number>> = { length: 0.5, accents: 0.5, tensions: 0.5, register: 0, harmony: 0.3, colour: 0.4, bass: 0.5, vary: 0, changes: 0.5, unfold: 0, sync: 0 };

function blockOf(zone: Zone): HTMLElement | null {
  return zone.elements?.zoneElement?.querySelector<HTMLElement>('.chords-block') ?? null;
}

/** The block's layout (rebuilt only when this changes, never during a drag) */
function layoutKey(zone: Zone): string {
  const zs = hooks.zones();
  return [zone.chords?.part, moreOpen.has(zone.id), zone.chords?.follows, ...zs.map((z) => `${z.id}:${z.label}:${!!z.chords}`)].join('|');
}

let dragging: HTMLElement | null = null;

/** Draws a zone's block (after every change of the zone) */
export function renderChordBlock(zone: Zone): void {
  const el = blockOf(zone);
  if (!el || !zone.chords || !hooks) return;
  if (dragging && el.contains(dragging)) return;
  const part = zone.chords.part;
  const key = layoutKey(zone);
  if (el.dataset.layout !== key) {
    el.dataset.layout = key;
    el.innerHTML = blockHTML(zone);
  }
  // values
  const s = zone.chordSet;
  el.querySelectorAll<HTMLElement>('.cb-pad').forEach((pad, i) => {
    const spec = PADS[part][i];
    placeDot(pad, s[spec.x] as number, s[spec.y] as number);
  });
  el.querySelectorAll<HTMLElement>('.cb-rhythm a').forEach((a, i) => a.classList.toggle('on', i === s.rhythm));
  el.querySelectorAll<HTMLInputElement>('.cb-more input[type=range]').forEach((inp) => {
    const k = inp.dataset.k as keyof ChordSettings;
    if (document.activeElement !== inp) inp.value = String(s[k]);
  });
  const another = el.querySelector<HTMLElement>('.cb-another');
  if (another) another.title = `Another good choice${s.seed ? ` (choice ${s.seed + 1}; double-click: back to the best)` : ''}`;
  const tag = el.querySelector<HTMLElement>('.cb-key');
  if (tag) {
    const line = lineZoneOf(zone);
    const plan = planOf(zone);
    const k = plan?.key ?? (line && deciders.get(line.id)?.key);
    tag.textContent = k ? keyName(k) : '';
  }
}

function placeDot(pad: HTMLElement, x: number, y: number): void {
  const dot = pad.querySelector<HTMLElement>('.cb-dot')!;
  const lx = pad.querySelector<HTMLElement>('.cb-x')!;
  const ly = pad.querySelector<HTMLElement>('.cb-y')!;
  dot.style.left = lx.style.left = `${x * 100}%`;
  dot.style.top = ly.style.top = `${(1 - y) * 100}%`;
}

function blockHTML(zone: Zone): string {
  const part = zone.chords!.part;
  const zs = hooks.zones();
  const line = lineZoneOf(zone);
  const cands = zs.filter((z) => z !== zone && !z.chords);
  const options =
    (line ? '' : `<option value="" selected>${zone.chords!.follows ? '⚠ missing' : 'choose a line'}</option>`) +
    cands.map((z) => `<option value="${escapeHTML(z.id)}"${z === line ? ' selected' : ''}>${escapeHTML(lineLabel(z))}</option>`).join('');
  const what = part === 'bass' ? 'Bass' : 'Chords';
  const pads = PADS[part]
    .map(
      (p, i) => `
    <div class="cb-padbox" title="${escapeHTML(p.title)}">
      <div class="cb-pt">${p.name}${i === 0 ? ' <small class="cb-key"></small>' : ''}</div>
      <div class="cb-yl"><span>${p.bottom}</span><span>${p.top}</span></div>
      <div class="cb-pad" data-pad="${i}"><div class="cb-x"></div><div class="cb-y"></div><div class="cb-dot"></div></div>
      <div class="cb-xl"><span>${p.left}</span><span>${p.right}</span></div>
    </div>`
    )
    .join('');
  const open = moreOpen.has(zone.id);
  const more = MORE[part]
    .map(
      (m) => `<label class="cb-sl" title="${escapeHTML(m.title)}"><span class="label">${m.label}</span><small>${m.left}</small>
      <input type="range" data-k="${m.k}" min="${m.min ?? 0}" max="${m.max ?? 1}" step="${m.step ?? 0.05}" tabindex="-1"><small>${m.right}</small></label>`
    )
    .join('');
  return `
    <div class="cb-row"><span class="cb-what">${what}</span><span class="label">follows</span>
      <select class="cb-follows" tabindex="-1" title="The zone whose line it plays to">${options}</select></div>
    <div class="cb-row"><span class="label">Rhythm</span><div class="cb-rhythm">${RHYTHMS.map((r) => `<a>${r}</a>`).join('')}</div></div>
    <div class="cb-pads">${pads}</div>
    <div class="cb-row cb-foot">
      <a class="cb-more-toggle" title="More settings"><i class="material-icons${open ? ' open' : ''}">chevron_right</i>More<small>${open ? '' : ': ' + MORE[part].map((m) => m.label).join(', ')}</small></a>
      <a class="lightButton cb-another">Another</a>
    </div>
    ${open ? `<div class="cb-more">${more}</div>` : ''}`;
}

/** A setting changed (one undo step): a loop made of chords is redone, live it applies to the next chord */
function setSettings(zone: Zone, change: Partial<ChordSettings>, label = 'Chords'): void {
  const zs = hooks.zones();
  const index = zs.indexOf(zone);
  // the zone was replaced meanwhile (undo, an arrangement switch during a drag)
  if (index < 0) return;
  const line = lineZoneOf(zone);
  // only a real change of these chooses new chords (a pad's other axis moved alone doesn't)
  const decides = (['harmony', 'changes', 'seed'] as const).some((k) => k in change && change[k] !== zone.chordSet[k]);
  const plan = planOf(zone);
  // a change of the chords themselves goes to every follower with a loop made of chords
  if (line && decides && plan && followersOf(line)[0] === zone) {
    makeLoopsWith(line, followersOf(line).filter((z) => planOf(z)), label, () => Object.assign(zone.chordSet, change));
    return;
  }
  hooks.commit([index], label, () => {
    Object.assign(zone.chordSet, change);
    if (plan && line) {
      const src = lineOf(line);
      if (src && src.length === plan.length) renderLoop(zone, src, plan, leadOf(line), zone.looper.anchor);
    }
  });
}

/** makeLoops with a settings change inside the same undo step */
function makeLoopsWith(line: Zone, which: Zone[], label: string, change: () => void): void {
  const src = lineOf(line);
  if (!src) return;
  const zs = hooks.zones();
  const indices = which.map((z) => zs.indexOf(z));
  hooks.commit(indices, label, () => {
    change();
    const meter = hooks.meter();
    const lead = leadOf(line);
    const p = progress(src.notes, src.length, meter, harmonyOptions(lead));
    const plan = { key: p.key, chords: p.chords as (Chord | null)[], length: src.length };
    which.forEach((z) => renderLoop(z, src, plan, lead, z.looper.anchor));
  });
}

function zoneOfEl(el: Element): Zone | null {
  const z = el.closest('.zone');
  if (!z) return null;
  const i = parseInt(z.id.replace('zone', ''));
  return hooks.zones()[i] ?? null;
}

function initBlockEvents(): void {
  document.addEventListener('pointerdown', (ev) => {
    const pad = (ev.target as HTMLElement).closest?.('.chords-block .cb-pad') as HTMLElement | null;
    if (!pad || ev.button !== 0) return;
    const zone = zoneOfEl(pad);
    if (!zone?.chords) return;
    ev.preventDefault();
    const spec = PADS[zone.chords.part][parseInt(pad.dataset.pad!)];
    const previous = { ...zone.chordSet };
    dragging = pad;
    pad.setPointerCapture(ev.pointerId);
    pad.classList.add('dragging');
    const at = (e: PointerEvent) => {
      const r = pad.getBoundingClientRect();
      const x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
      const y = Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / r.height));
      return { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100 };
    };
    const move = (e: PointerEvent) => {
      const p = at(e);
      // live it plays with the next chord; the loop is redone on release
      (zone.chordSet as any)[spec.x] = p.x;
      (zone.chordSet as any)[spec.y] = p.y;
      placeDot(pad, p.x, p.y);
    };
    move(ev);
    const up = (e: PointerEvent) => {
      pad.removeEventListener('pointermove', move);
      pad.removeEventListener('pointerup', up);
      pad.removeEventListener('pointercancel', up);
      pad.classList.remove('dragging');
      dragging = null;
      const p = at(e);
      const change = { [spec.x]: p.x, [spec.y]: p.y } as Partial<ChordSettings>;
      // back to where it was, so the undo step holds the change
      Object.assign(zone.chordSet, { [spec.x]: previous[spec.x], [spec.y]: previous[spec.y] });
      if (previous[spec.x] === p.x && previous[spec.y] === p.y) return;
      setSettings(zone, change);
    };
    pad.addEventListener('pointermove', move);
    pad.addEventListener('pointerup', up);
    pad.addEventListener('pointercancel', up);
  });
  document.addEventListener('dblclick', (ev) => {
    const t = ev.target as HTMLElement;
    const pad = t.closest?.('.chords-block .cb-pad') as HTMLElement | null;
    const zone = zoneOfEl(t);
    if (!zone?.chords) return;
    if (pad) {
      const spec = PADS[zone.chords.part][parseInt(pad.dataset.pad!)];
      setSettings(zone, { [spec.x]: MIDDLE[spec.x] ?? 0.5, [spec.y]: MIDDLE[spec.y] ?? 0.5 } as Partial<ChordSettings>);
    } else if (t.closest('.chords-block .cb-another')) {
      setSettings(zone, { seed: 0 }, 'Chords: the Best');
    } else if (t.matches('.chords-block .cb-more input[type=range]')) {
      const k = (t as HTMLInputElement).dataset.k as keyof ChordSettings;
      setSettings(zone, { [k]: MIDDLE[k] ?? 0.5 } as Partial<ChordSettings>);
    }
  });
  document.addEventListener('click', (ev) => {
    const t = ev.target as HTMLElement;
    if (!t.closest?.('.chords-block')) return;
    const zone = zoneOfEl(t);
    if (!zone?.chords) return;
    const r = t.closest('.cb-rhythm a');
    if (r) {
      const i = [...r.parentElement!.children].indexOf(r);
      if (i !== zone.chordSet.rhythm) setSettings(zone, { rhythm: i });
      return;
    }
    if (t.closest('.cb-another') && ev.detail === 1) {
      setSettings(zone, { seed: (zone.chordSet.seed % 9973) + 1 }, 'Chords: Another');
      return;
    }
    if (t.closest('.cb-more-toggle')) {
      if (moreOpen.has(zone.id)) moreOpen.delete(zone.id);
      else moreOpen.add(zone.id);
      renderChordBlock(zone);
    }
  });
  document.addEventListener('change', (ev) => {
    const t = ev.target as HTMLElement;
    if (!t.closest?.('.chords-block')) return;
    const zone = zoneOfEl(t);
    if (!zone?.chords) return;
    if (t.matches('.cb-follows')) {
      const id = (t as HTMLSelectElement).value;
      const zs = hooks.zones();
      hooks.commit([zs.indexOf(zone)], 'Chords Follow', () => {
        zone.chords = { ...zone.chords!, follows: id };
      });
      const line = lineZoneOf(zone);
      if (line) freshStart(line);
      return;
    }
    if (t.matches('.cb-more input[type=range]')) {
      const k = (t as HTMLInputElement).dataset.k as keyof ChordSettings;
      const v = parseFloat((t as HTMLInputElement).value);
      (t as HTMLInputElement).blur();
      setSettings(zone, { [k]: v } as Partial<ChordSettings>);
    }
  });
  // keys typed in the block's fields stay out of the app's shortcuts
  document.addEventListener(
    'keydown',
    (ev) => {
      const t = ev.target as HTMLElement;
      if (t.closest?.('.chords-block') && ev.code !== 'KeyZ' && ev.code !== 'Space') ev.stopPropagation();
    },
    true
  );
}

export function initChords(h: Hooks): void {
  hooks = h;
  initBlockEvents();
}

/** For the track view: the zone plays chords (its lane shows their names) */
export function isChordsZone(zone: Zone): boolean {
  return !!zone.chords;
}
