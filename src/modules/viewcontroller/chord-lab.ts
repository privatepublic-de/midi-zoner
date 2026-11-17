/**
 * Chord lab (experiment, temporary): a floating panel (⌘⇧K) that harmonizes a zone's line
 * (its loop, else its melodic sequence, else its shown take) and writes the chords into
 * another zone's loop in this arrangement, one undo step per apply. Not the final UI.
 */
import { Zone } from '../zone/zone-class';
import { Take } from '../zone/take';
import { Meter, barTicks } from '../meter';
import { takeStore } from '../take-store';
import { timeline, nowTick } from '../timeline';
import { escapeHTML } from '../domutils';
import { toast } from './toast';
import { harmonize, chart, keyName, registerFor, segmentsOf, LineNote, HarmonyOptions } from '../zone/harmonize';
import { LiveChords, HeardNote, heardChords, Send } from '../zone/live-chords';
import { Note } from '../zone/note';
import { ZONES_CHANGED_EVENT } from '../zone/interfaces';

interface Hooks {
  zones: () => Zone[];
  commit: (zoneIndex: number, label: string, change: () => void) => void;
  meter: () => Meter;
}

let hooks: Hooks;
let panel: HTMLElement;
const state = {
  from: 0,
  to: 1,
  bass: -1,
  harmony: 0.3,
  changes: 0.5,
  rhythm: 0,
  colour: 0.4,
  register: 0,
  unfold: 0,
  length: 0.5,
  accents: 0.5,
  tensions: 0.5,
  vary: 0,
  bassMove: 0,
  follow: 'off' as 'off' | 'loop' | 'live',
  seed: 0,
  auto: true
};

/** The zone's line: its loop, else its melodic sequence, else its shown take */
function lineOf(zone: Zone): { notes: LineNote[]; length: number; what: string; anchor: number } | null {
  if (zone.loop && zone.loop.notes.length) {
    return { notes: zone.loop.notes.map((n) => ({ t: n.t, d: n.d, n: n.n, v: n.v, ...(n.p ? { p: 1 as const } : {}) })), length: zone.loop.length, what: 'loop', anchor: zone.looper.anchor };
  }
  const seq = zone.sequence;
  if (!seq.isDrumSequence && seq.steps.some((s) => s && s.notesArray.length)) {
    const ticks = seq.ticks;
    const notes: LineNote[] = [];
    seq.steps.slice(0, seq.length).forEach((s, i) => {
      if (!s) return;
      for (const note of s.notesArray) notes.push({ t: i * ticks, d: Math.max(1, s.length * ticks * s.gateLength), n: note.number, v: note.velo });
    });
    return { notes, length: seq.length * ticks, what: 'steps', anchor: 0 };
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
      return { notes: vis.map((n) => ({ t: n.s - from, d: n.d, n: n.n, v: n.v })).filter((n) => n.t >= 0 && n.t < length), length, what: 'take', anchor: -1 };
    }
  }
  return null;
}

function options(extra: Partial<HarmonyOptions> = {}): HarmonyOptions {
  return { ...extra, harmony: state.harmony, changes: state.changes, rhythm: state.rhythm, colour: state.colour, register: state.register, unfold: state.unfold, length: state.length, accents: state.accents * 2 - 1, tensions: state.tensions * 2 - 1, vary: state.vary, bassMove: state.bassMove, seed: state.seed };
}

function loopOf(notes: LineNote[], length: number): Take {
  const take = new Take();
  take.start = 0;
  take.length = length;
  take.notes = notes.map((n) => ({ t: n.t, d: n.d, n: n.n, v: n.v })).sort((a, b) => a.t - b.t);
  return take;
}

function apply(extra: Partial<HarmonyOptions> = {}, label = 'Chords'): void {
  const zones = hooks.zones();
  const src = zones[state.from];
  const dst = zones[state.to];
  const out = panel.querySelector('.cl-out') as HTMLElement;
  if (!src || !dst || src === dst) {
    out.textContent = 'Pick two different zones';
    return;
  }
  const line = lineOf(src);
  if (!line) {
    out.textContent = `${src.label || 'Zone ' + (state.from + 1)} has no loop, sequence or take`;
    return;
  }
  const meter = hooks.meter();
  const acc = harmonize(line.notes, line.length, meter, options(extra));
  const k = acc.progression.analysis;
  out.textContent =
    `${line.what}, ${Math.round(line.length / barTicks(meter))} bars · ${keyName(acc.progression.key)}` +
    (k ? ` (sure ${Math.round(k.margin * 100)}%; then ${k.keys.slice(1, 3).map(keyName).join(', ')})` : '') +
    ` · ${acc.rhythm}\n` +
    `chords ${Note.display(Math.min(...acc.notes.map((n) => n.n)))}–${Note.display(Math.max(...acc.notes.map((n) => n.n)))}, ${registerFor(line.notes, state.register).over ? 'over' : 'under'} the line\n` +
    chart(acc.progression).replace(/(\| [^|]*){4}/g, '$&\n').trim();

  const anchor = (): number => {
    // with the source's cycle (a loop's anchor; steps from bar 1); a take lines up at the next bar
    if (line.anchor >= 0) return line.anchor;
    if (!timeline.running) return 0;
    const bar = barTicks(meter);
    return Math.ceil((nowTick() - timeline.sectionStart) / bar) * bar;
  };
  const put = (zone: Zone, index: number, notes: LineNote[]) => {
    if (zone.looper.mode !== 'idle') {
      toast('That zone’s loop is being recorded: finish that first');
      return;
    }
    hooks.commit(index, label, () => {
      zone.loop = loopOf(notes, line.length);
      zone.loopOn = true;
      zone.loopPlayer.release(true);
      zone.looper.anchor = anchor();
    });
  };
  put(dst, state.to, acc.notes);
  const bassZone = zones[state.bass];
  if (bassZone && bassZone !== src && bassZone !== dst) put(bassZone, state.bass, acc.bass);
}

function zoneOptions(selected: number, none = false): string {
  const zones = hooks.zones();
  return (
    (none ? `<option value="-1"${selected < 0 ? ' selected' : ''}>none</option>` : '') +
    zones.map((z, i) => `<option value="${i}"${i === selected ? ' selected' : ''}>${i + 1} ${escapeHTML(z.label || '')}</option>`).join('')
  );
}

function refreshSelects(): void {
  if (!panel || panel.hidden) return;
  (panel.querySelector('[data-k=from]') as HTMLSelectElement).innerHTML = zoneOptions(state.from);
  (panel.querySelector('[data-k=to]') as HTMLSelectElement).innerHTML = zoneOptions(state.to);
  (panel.querySelector('[data-k=bass]') as HTMLSelectElement).innerHTML = zoneOptions(state.bass, true);
  (panel.querySelector('[data-k=follow]') as HTMLSelectElement).value = state.follow;
  showLive();
}

function slider(key: keyof typeof state, label: string, left: string, right: string): string {
  return `<label class="cl-row"><span>${label}</span><small>${left}</small><input type="range" min="0" max="1" step="0.05" data-k="${key}" value="${state[key]}"><small>${right}</small></label>`;
}

function build(): void {
  try {
    Object.assign(state, JSON.parse(localStorage.getItem('chordLab') || '{}'));
  } catch {
    /* defaults */
  }
  panel = document.createElement('div');
  panel.id = 'chordLab';
  panel.hidden = true;
  panel.innerHTML = `
    <div class="cl-head">Chord lab <small>experiment · ⌘⇧K</small><button class="cl-close" title="Close (⌘⇧K)">×</button></div>
    <label class="cl-row"><span>Line</span><select data-k="from"></select></label>
    <label class="cl-row"><span>Chords into</span><select data-k="to"></select></label>
    <label class="cl-row"><span>Bass into</span><select data-k="bass"></select></label>
    ${slider('bassMove', 'Bass moves', 'Roots', 'Walking')}
    <label class="cl-row"><span>Follow</span><select data-k="follow" title="Off: chords on Apply. Loop: redone when a loop on the line zone is recorded or overdubbed. Live: chords as you play; a loop closed on the line zone keeps the chords heard">
      <option value="off">Off</option><option value="loop">Loop</option><option value="live">Live</option></select></label>
    ${slider('harmony', 'Harmony', 'Fifths', 'Modal')}
    ${slider('changes', 'Changes', 'Slow', 'Fast')}
    ${slider('rhythm', 'Rhythm', 'On-beat', 'Off-beat')}
    ${slider('colour', 'Colour', 'Triads', '7 / 9')}
    ${slider('unfold', 'Build-up', 'Together', 'Unfold')}
    <div class="cl-sub">Expression <small>(double-click a slider: middle)</small></div>
    ${slider('length', 'Length', 'Stabs', 'Legato')}
    ${slider('accents', 'Accents', 'On-beat', 'Off-beat')}
    ${slider('tensions', 'Tensions', 'Softer', 'Louder')}
    ${slider('vary', 'Vary', 'Even', 'Loose')}
    <label class="cl-row"><span>Register</span><small>Lower</small><input type="range" min="-12" max="12" step="1" data-k="register" value="${state.register}" title="Where the chords sit: semitones down or up from where they'd go (double-click: back to 0)"><small>Higher</small></label>
    <div class="cl-row cl-buttons">
      <button data-a="apply">Apply</button>
      <button data-a="another" title="Another good choice">Another</button>
      <button data-a="best" title="Back to the best choice">Best</button>
      <label><input type="checkbox" data-k="auto"${state.auto ? ' checked' : ''}> Apply on change</label>
    </div>
    <div class="cl-live"></div>
    <pre class="cl-out"></pre>`;
  document.body.appendChild(panel);
  const save = () => {
    try {
      localStorage.setItem('chordLab', JSON.stringify(state));
    } catch {
      /* per machine only */
    }
  };
  panel.addEventListener('input', (ev) => {
    const el = ev.target as HTMLInputElement;
    const k = el.dataset.k as keyof typeof state | undefined;
    if (!k) return;
    if (el.type === 'checkbox') (state as any)[k] = el.checked;
    else if (k === 'follow') {
      state.follow = el.value as typeof state.follow;
      save();
      stopLive();
      showLive();
      return;
    } else (state as any)[k] = parseFloat(el.value);
    if (k === 'from' || k === 'to' || k === 'bass') stopLive();
    save();
    // live, the settings apply to the next chord: no loop written
    if (state.follow === 'live' && k !== 'from' && k !== 'to' && k !== 'bass') return;
    if (state.auto && k !== 'auto' && el.type === 'range' && ev.type === 'input') return; // sliders apply on release
    if (state.auto && k !== 'auto') apply();
  });
  panel.addEventListener('change', (ev) => {
    const el = ev.target as HTMLInputElement;
    if (el.type === 'range' && state.auto && state.follow !== 'live') apply();
  });
  panel.addEventListener('dblclick', (ev) => {
    const el = ev.target as HTMLInputElement;
    const k = el.dataset?.k;
    const middle: Record<string, number> = { register: 0, length: 0.5, accents: 0.5, tensions: 0.5 };
    if (!k || !(k in middle)) return;
    el.value = String(middle[k]);
    (state as any)[k] = middle[k];
    save();
    apply();
  });
  panel.addEventListener('click', (ev) => {
    const a = (ev.target as HTMLElement).closest('[data-a]')?.getAttribute('data-a');
    if ((ev.target as HTMLElement).closest('.cl-close')) toggle();
    if (!a) return;
    if (a === 'another') state.seed = (state.seed % 9973) + 1;
    if (a === 'best') state.seed = 0;
    save();
    apply();
  });
  // the app's shortcuts stay out of the panel's fields
  panel.addEventListener('keydown', (ev) => {
    if (!(ev.metaKey && ev.shiftKey && ev.code === 'KeyK') && ev.code !== 'KeyZ') ev.stopPropagation();
  });
  const style = document.createElement('style');
  style.textContent = `
    #chordLab { position: fixed; right: 16px; bottom: 16px; z-index: 60; width: 400px; padding: 10px 12px;
      background: var(--slate-panel); border: 1px solid var(--slate-line); border-radius: var(--radius-lg);
      box-shadow: 0 8px 30px rgba(0,0,0,.5); font-size: 13px; color: var(--text-base-color); }
    #chordLab .cl-head { font-weight: 600; margin-bottom: 8px; display: flex; gap: 8px; align-items: baseline; }
    #chordLab .cl-head small { color: var(--slate-dim); font-weight: 400; }
    #chordLab .cl-close { margin-left: auto; background: none; border: 0; color: var(--slate-dim); font-size: 18px; cursor: pointer; }
    #chordLab .cl-sub { margin: 10px 0 2px; padding-top: 6px; border-top: 1px solid var(--slate-line); color: var(--slate-dim); font-size: 12px; }
    #chordLab .cl-sub small { font-size: 11px; }
    #chordLab .cl-row { display: flex; align-items: center; gap: 8px; margin: 5px 0; }
    #chordLab .cl-row > span { width: 80px; color: var(--slate-dim); }
    #chordLab .cl-row small { color: var(--slate-dim); width: 48px; font-size: 11px; }
    #chordLab .cl-row small:last-child { text-align: right; }
    #chordLab input[type=range] { flex: 1; }
    #chordLab select { flex: 1; }
    #chordLab .cl-buttons { gap: 6px; }
    #chordLab .cl-buttons label { margin-left: auto; color: var(--slate-dim); font-size: 12px; }
    #chordLab button[data-a] { background: var(--slate-raise); color: inherit; border: 1px solid var(--slate-line); border-radius: var(--radius); padding: 3px 10px; cursor: pointer; }
    #chordLab .cl-live { margin-top: 6px; font-size: 12px; color: var(--slate-dim); }
    #chordLab .cl-live b { color: var(--text-base-color); font-size: 15px; margin-right: 6px; }
    #chordLab .cl-out { margin: 8px 0 0; font: 11px/1.5 Menlo, monospace; white-space: pre; overflow-x: auto; color: var(--text-base-color); }`;
  document.head.appendChild(style);
}

function toggle(): void {
  panel.hidden = !panel.hidden;
  refreshSelects();
}

export function initChordLab(h: Hooks): void {
  hooks = h;
  build();
  window.addEventListener('keydown', (ev) => {
    if (ev.code === 'KeyK' && ev.shiftKey && (ev.metaKey || ev.ctrlKey)) {
      ev.preventDefault();
      toggle();
    }
  });
  window.addEventListener(ZONES_CHANGED_EVENT, refreshSelects);
}

// ---------------------------------------------------------------------------- following

const live = new LiveChords();
let liveZones: { dst: Zone; bass: Zone | null } | null = null;

function sendTo(dst: Zone, bass: Zone | null): Send {
  return (on, n, v, isBass) => {
    const zone = isBass ? bass : dst;
    if (!zone) return;
    const status = on ? 0x90 : 0x80;
    zone.handleMidi(status, Uint8Array.from([status, n, on ? v : 0]), true);
  };
}

function stopLive(): void {
  if (liveZones) live.stop(sendTo(liveZones.dst, liveZones.bass));
  liveZones = null;
  showLive();
}

function showLive(): void {
  const el = panel?.querySelector('.cl-live') as HTMLElement | null;
  if (!el) return;
  if (state.follow !== 'live') {
    el.textContent = state.follow === 'loop' ? 'Following the line zone’s loop: recorded or overdubbed, the chords are redone' : '';
    return;
  }
  const dst = hooks.zones()[state.to];
  if (dst?.loop && dst.loopOn) el.textContent = 'Live: the chord zone plays its loop (clear it to play live again)';
  else if (!timeline.running) el.textContent = 'Live: waiting for Start';
  else if (!live.key) el.textContent = 'Live: listening…';
  else el.innerHTML = `<b>${escapeHTML(live.name)}</b>${escapeHTML(keyName(live.key))}`;
}

/** What the line zone played in the last bars, at song positions */
function heard(src: Zone, songPos: number, meter: Meter): HeardNote[] {
  const offset = timeline.runStart + timeline.sectionStart;
  const now = offset + songPos;
  const from = now - 9 * barTicks(meter);
  return src.noteHistory
    .between(Math.max(from, offset), now + 1)
    .filter((h) => h.start >= offset)
    .map((h) => ({ s: h.start - offset, d: Math.max(1, (h.end ?? now) - h.start), n: h.pitch, v: h.velo, held: h.end === null }));
}

/** Every clock tick (run position): live chords */
export function chordLabTick(pos: number): void {
  if (!hooks || state.follow !== 'live') return;
  const zones = hooks.zones();
  const src = zones[state.from];
  const dst = zones[state.to];
  if (!src || !dst || src === dst) return;
  const bassZone = zones[state.bass];
  const bass = bassZone && bassZone !== src && bassZone !== dst ? bassZone : null;
  // undo replaces zone objects: what sounds goes off through the zones it went to
  if (liveZones && (liveZones.dst !== dst || liveZones.bass !== bass)) stopLive();
  // the chord zone's loop plays instead
  if (dst.loop && dst.loopOn) {
    if (liveZones) stopLive();
    return;
  }
  liveZones = { dst, bass };
  const meter = hooks.meter();
  const songPos = pos - timeline.sectionStart;
  if (live.tick(songPos, heard(src, songPos, meter), options(), meter, sendTo(dst, bass))) showLive();
}

/** Start and Stop: live chords start over */
export function chordLabTransport(started: boolean): void {
  if (!hooks) return;
  stopLive();
  live.log.clear();
  void started;
}

/** A loop on a zone was recorded or overdubbed (an undo step already) */
export function chordLabLoopChanged(zone: Zone, kind: string): void {
  if (!hooks || state.follow === 'off') return;
  const zones = hooks.zones();
  if (zones[state.from] !== zone || !zone.loop) return;
  if (state.follow === 'live' && kind === 'recorded') {
    // the chords heard while it was recorded become the loop's
    const meter = hooks.meter();
    const songNow = nowTick() - timeline.sectionStart;
    const frozen = heardChords(live.log, segmentsOf(zone.loop.length, meter), zone.loop.length, zone.looper.anchor, songNow);
    stopLive();
    apply(frozen.some((c) => c) ? { frozen, ...(live.key ? { key: live.key } : {}) } : {}, 'Chords from Live');
  } else apply({}, 'Chords');
  showLive();
}
