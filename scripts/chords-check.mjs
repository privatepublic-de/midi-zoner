#!/usr/bin/env node
/**
 * Checks the chords engine on the lines in chord-tunes.mjs, for a change to zone/harmonize.ts or
 * zone/live-chords.ts. The chords are a helper giving first steps, not a right answer, so this
 * doesn't score against a chart; it reports what makes chords implausible:
 *   key     the key found is one a listener would accept (✓), another mode on the same tonic
 *           that every melody note fits (~: the modal end picks colourful modes on purpose),
 *           else ✗ with the key found
 *   clash   share of the melody (8ths and longer) a half step over a tone of the chord under it
 *   ch/bar  chord changes per bar (restless when high)
 * for three paths: the loop (progress() over the whole line), live (heard as played) and ahead
 * (live with the line's take playing along: the notes a bar ahead known), each in a few styles.
 *
 *   npm run check:chords   (builds, then compares with scripts/chords-baseline.json)
 *   node scripts/chords-check.mjs [options]   (on dist/: build first)
 * Once a change is good, keep its results as the new baseline:
 *   node scripts/chords-check.mjs --save scripts/chords-baseline.json
 *     --save <file>      keep the results (e.g. before a change)
 *     --against <file>   compare with kept results: changes marked ▲ (worse) / ▼ (better)
 *     --styles a,b       chord styles to run (default piano,pop,ambient)
 *     --tune <text>      only tunes whose name contains it
 *     --chords           print the chords per bar too
 *     --dist <dir>       the compiled modules (default dist/modules)
 */
import { createRequire } from 'module';
import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { TUNES } from './chord-tunes.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const dist = path.resolve(opt('--dist') ?? path.join(here, '..', 'dist', 'modules'));
const require = createRequire(import.meta.url);
const H = require(path.join(dist, 'zone', 'harmonize.js'));
const { LiveChords } = require(path.join(dist, 'zone', 'live-chords.js'));
const { harmonyOptions } = require(path.join(dist, 'zone', 'chord-settings.js'));
const { styleById, styleSettings } = require(path.join(dist, 'zone', 'chord-styles.js'));
const { barTicks } = require(path.join(dist, 'meter.js'));

const PPQ = 24;
const PC = { C: 0, 'C#': 1, Db: 1, D: 2, 'D#': 3, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, 'G#': 8, Ab: 8, A: 9, 'A#': 10, Bb: 10, B: 11 };
const PATHS = ['loop', 'live', 'ahead'];

/** A tune as notes {t, d, n, v} from bar 0, its length, and where bar 1 starts (after a pick-up) */
function lineOf(tune) {
  const bar = barTicks(tune.meter);
  if (tune.notes) return { notes: tune.notes.map(([t, d, n, v]) => ({ t, d, n, v })), length: tune.length, first: 0 };
  const groups = tune.bars.split('|').map((g) => g.trim());
  const beats = (tune.meter.n * 4) / tune.meter.d;
  const notes = [];
  let first = 0;
  let t = 0;
  groups.forEach((g, i) => {
    const pickup = i === 0 && tune.pickup;
    if (pickup) {
      t = bar - tune.pickup * PPQ;
      first = bar;
    }
    let sum = 0;
    for (const tok of g.split(/\s+/)) {
      const [name, len] = tok.split(':');
      const L = parseFloat(len) * PPQ;
      sum += parseFloat(len);
      if (name !== 'r') {
        const m = name.match(/^([A-G][#b]?)(\d?)$/);
        if (!m) throw new Error(`${tune.name}: "${tok}"`);
        notes.push({ t, d: L * 0.92, n: 12 * ((m[2] ? +m[2] : 4) + 1) + PC[m[1]], v: 90 });
      }
      t += L;
    }
    const want = pickup ? tune.pickup : beats;
    if (Math.abs(sum - want) > 1e-6) console.warn(`⚠ ${tune.name}: bar ${i} has ${sum} beats, not ${want}`);
  });
  return { notes, length: Math.ceil(t / bar) * bar, first };
}

/** Chords per segment for one path: [{t, end, chord}] */
function chordsOf(pathName, line, meter, o) {
  if (pathName === 'loop') {
    // as a loop from bar 1: a pick-up goes at its end (as the looper puts it)
    const len = line.length - line.first;
    const notes = line.notes.map((n) => ({ ...n, t: n.t < line.first ? n.t - line.first + len : n.t - line.first }));
    const p = H.progress(notes, len, meter, o);
    return { key: p.key, spans: p.segments.map((s, i) => ({ t: s.t + line.first, end: s.end + line.first, chord: p.chords[i] })) };
  }
  const played = line.notes.map((n) => ({ s: n.t, d: n.d, n: n.n, v: n.v })).sort((a, b) => a.s - b.s);
  const lc = new LiveChords();
  const bar = barTicks(meter);
  const ahead = pathName === 'ahead';
  for (let pos = 0; pos < line.length; pos++) {
    const heard = () =>
      played
        .filter((h) => (ahead ? h.s < pos : h.s <= pos) && h.s >= pos - 9 * bar)
        .map((h) => ({ ...h, held: h.s + h.d > pos, d: h.s + h.d > pos ? Math.max(1, pos - h.s) : h.d }));
    const coming = ahead ? () => played.filter((h) => h.s >= pos && h.s < pos + bar + PPQ).map((h) => ({ ...h, held: false })) : undefined;
    lc.tick(pos, heard, [{ id: 'z', part: 'chords', o, out: null }], meter, () => {}, coming);
  }
  const segs = H.segmentsOf(line.length, meter);
  let last = null;
  const spans = segs.map((s) => {
    last = lc.log.get(s.t) ?? last;
    return { t: s.t, end: s.end, chord: lc.log.get(s.t) ?? null };
  });
  return { key: lc.key, spans };
}

function measure(tune, line, got) {
  const { key, spans } = got;
  const keyText = key ? H.keyName(key) : '-';
  // the melody's notes of an 8th or more against the chord under them
  let all = 0;
  let clash = 0;
  for (const n of line.notes) {
    if (n.d < PPQ / 2 - 1) continue;
    const pc = n.n % 12;
    for (const s of spans) {
      const o = Math.min(s.end, n.t + n.d) - Math.max(s.t, n.t);
      if (o <= 0 || !s.chord) continue;
      all += o;
      const tones = H.chordTones(s.chord);
      if (!tones.includes(pc) && tones.includes((pc + 11) % 12)) clash += o;
    }
  }
  let changes = 0;
  let prev = null;
  for (const s of spans) {
    if (!s.chord) continue;
    const name = H.chordName(s.chord);
    if (prev && name !== prev) changes++;
    prev = name;
  }
  const bars = (line.length - line.first) / barTicks(tune.meter);
  const tonics = tune.keys.map((k) => k.split(' ')[0]);
  const fits = !!key && tonics.includes(keyText.split(' ')[0]) && line.notes.every((n) => H.keyTones(key).includes(n.n % 12));
  const keyOk = tune.keys.includes(keyText);
  return { key: keyText, keyOk, keyMode: !keyOk && fits, clash: all ? (100 * clash) / all : 0, changes: changes / bars };
}

function chart(tune, line, spans) {
  const bar = barTicks(tune.meter);
  const rows = [];
  for (let b = 0; b * bar < line.length; b++) {
    const cells = spans.filter((s) => s.t >= b * bar && s.t < (b + 1) * bar).map((s) => (s.chord ? H.chordName(s.chord) : '-'));
    rows.push(cells.map((c, i) => (i > 0 && c === cells[i - 1] ? '.' : c).padEnd(6)).join(''));
  }
  return rows;
}

const styles = (opt('--styles') ?? 'piano,pop,ambient').split(',');
const only = opt('--tune');
const against = opt('--against') ? JSON.parse(readFileSync(opt('--against'), 'utf8')) : null;
const results = {};
const cell = (r, b) => {
  if (!r) return ''.padEnd(19);
  let mark = '';
  if (b) {
    const ok = (x) => x.keyOk || x.keyMode;
    const worse = (ok(b) && !ok(r)) || r.clash > b.clash + 2 || r.changes > b.changes + 0.25;
    const better = (!ok(b) && ok(r)) || r.clash < b.clash - 2 || r.changes < b.changes - 0.25;
    mark = worse && !better ? '▲' : better && !worse ? '▼' : worse ? '▲▼' : '';
  }
  const k = r.keyOk ? '✓' : r.keyMode ? '~' : '✗';
  return `${k} ${r.clash.toFixed(0).padStart(2)}% ${r.changes.toFixed(2)}${mark}`.padEnd(19);
};

for (const style of styles) {
  const st = styleById(style);
  if (!st) throw new Error(`no style "${style}"`);
  const o = harmonyOptions(styleSettings(st, 'chords'));
  results[style] = {};
  console.log(`\n== ${style}  (key ✓/✗ · clash % · changes per bar)${against ? '  ▲ worse ▼ better than kept' : ''}`);
  console.log('tune'.padEnd(38) + PATHS.map((p) => p.padEnd(19)).join(''));
  const sum = Object.fromEntries(PATHS.map((p) => [p, { keys: 0, clash: 0, changes: 0, n: 0 }]));
  for (const tune of TUNES) {
    if (only && !tune.name.toLowerCase().includes(only.toLowerCase())) continue;
    const line = lineOf(tune);
    const row = {};
    const charts = {};
    for (const p of PATHS) {
      const got = chordsOf(p, line, tune.meter, o);
      row[p] = measure(tune, line, got);
      charts[p] = got.spans;
      const s = sum[p];
      s.keys += row[p].keyOk || row[p].keyMode ? 1 : 0;
      s.clash += row[p].clash;
      s.changes += row[p].changes;
      s.n++;
    }
    results[style][tune.name] = row;
    const b = against?.[style]?.[tune.name];
    const keys = PATHS.filter((p) => !row[p].keyOk).map((p) => `${p}: ${row[p].key}`);
    console.log(tune.name.padEnd(38) + PATHS.map((p) => cell(row[p], b?.[p])).join('') + (keys.length ? `  (${keys.join(', ')})` : ''));
    if (args.includes('--chords')) {
      const cs = PATHS.map((p) => chart(tune, line, charts[p]));
      cs[0].forEach((_, i) => console.log(`   ${String(i).padStart(2)}  ` + cs.map((c) => (c[i] ?? '').padEnd(28)).join(' | ')));
    }
  }
  console.log(
    'all'.padEnd(38) +
      PATHS.map((p) => {
        const s = sum[p];
        return `${s.keys}/${s.n} ${(s.clash / s.n).toFixed(1)}% ${(s.changes / s.n).toFixed(2)}`.padEnd(19);
      }).join('')
  );
}

if (opt('--save')) {
  writeFileSync(opt('--save'), JSON.stringify(results, null, 1));
  console.log(`\nkept in ${opt('--save')}`);
}
