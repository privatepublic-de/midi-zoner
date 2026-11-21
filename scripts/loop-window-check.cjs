// Checks zone/loop-window.ts (a loop as a window on its take): run with `npm run check:loops`

const path = require('path');
const D = path.join(__dirname, '../dist/modules/zone/');
const { Take } = require(D + 'take.js');
const W = require(D + 'loop-window.js');
let fails = 0;
const ok = (c, m) => { console.log((c ? '  ok  ' : '  FAIL ') + m); if (!c) fails++; };
const sig = (l) => JSON.stringify([...l.notes].map(n => [Math.round(n.t*1000)/1000, n.n, n.v, Math.round(n.d*1000)/1000, n.o||0, n.p||0]).sort());
// a 12-bar take, 4/4, with a pick-up into bar 4 (index 3)
const take = new Take(); take.at = 1700000000000; take.length = 12*96; take.start = 0;
let seed = 3; const r = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
for (let bar = 0; bar < 12; bar++) for (const p of [0, 24, 48, 60, 72]) {
  if (bar === 2 && p < 72) continue;              // a rest, then the pick-up at beat 4 of bar 3
  take.notes.push({ t: bar*96 + p + (r()-0.5)*4 + 2, d: 10 + r()*6, n: 60 + Math.floor(r()*12), v: 70 + Math.floor(r()*40) });
}
take.sort();
// a sustain pedal down for the first half of every bar, and a mod wheel line
take.g = { c64: [], c1: [] };
for (let bar = 0; bar < 12; bar++) take.g.c64.push(bar*96 + 1, 127, bar*96 + 48, 0);
for (let t = 0; t < 12*96; t += 24) take.g.c1.push(t, Math.round(64 + 60 * Math.sin(t / 50)));
const mk = (from, to) => { const c = W.cutWindow(take, from, to, {}); c.loop.origin = { at: take.at, run: from }; return c.loop; };
let loop = mk(3*96, 7*96);
ok(loop.notes.some(n => n.p), 'pick-up wrapped to the end');
ok(W.follows(loop, take) !== null, 'a fresh loop follows its take');
ok(sig(W.recutWindow(loop, take, 3*96, 7*96, 'edge')) === sig(loop), 'same window cut anew: identical');
// dubs
loop.notes.push({ t: 30, d: 10, n: 90, v: 100, o: 1 }, { t: 200, d: 10, n: 91, v: 100, o: 1 }); loop.sort();
const a = W.recutWindow(loop, take, 5*96, 9*96, 'slide');
ok(a.notes.filter(n => n.o).map(n => n.t).join() === '30,200', 'slide: dubs keep their place in the loop');
const back = W.recutWindow(a, take, 3*96, 7*96, 'slide');
ok(sig(back) === sig(loop), 'slide away and back: identical (dubs included)');
const e = W.recutWindow(loop, take, 2*96, 7*96, 'edge');
ok(e.notes.filter(n => n.o).map(n => n.t).join() === '126,296', 'start edge out a bar: dubs stay over the same take notes');
const e2 = W.recutWindow(loop, take, 3*96, 5*96, "edge");
ok(e2.notes.filter(n => n.o).length === 1 && e2.spare.filter(n => n.o).length === 1, 'end edge in: a dub past the end waits in the spare notes');
ok(sig(W.recutWindow(e2, take, 3*96, 7*96, 'edge')) === sig(loop), 'and comes back with the bar');
// JSON round trips (undo snapshots, takes.json)
const loopJ = Take.from(JSON.parse(JSON.stringify(loop.toJSON()))), takeJ = Take.from(JSON.parse(JSON.stringify(take.toJSON())));
ok(W.follows(loopJ, takeJ) !== null && !loopJ.notes.some(n => n.o && n.n < 90), 'after toJSON: still follows, no note taken for its own');
ok(sig(W.recutWindow(loopJ, takeJ, 3*96, 7*96, 'edge')) === sig(loopJ), 'after toJSON: cut anew without doubles');
ok(W.follows(loopJ, take) !== null && sig(W.recutWindow(loopJ, take, 3*96, 7*96, 'edge')).length === sig(loopJ).length, 'rounded loop vs unrounded take: follows');
// an edit in the loop: pitch of one take note, delete another, add one
let L = loop.copy(); L.origin = loop.origin;
let end = W.beginEdit(L, take);
const target = L.notes.find(n => !n.o && !n.p && n.t > 100); const tPitch = target.n + 1; target.n = tPitch;
const gone = L.notes.find(n => !n.o && n !== target && n.t > 150 && !n.p); L.notes = L.notes.filter(n => n !== gone);
L.notes.push({ t: 333, d: 5, n: 95, v: 90 }); L.sort();
end();
ok(L.link.fix?.length === 1 && L.link.hide?.length === 1 && L.notes.find(n => n.n === 95).o === 1, 'edit recorded: one change, one deleted, one own');
ok(sig(W.recutWindow(L, take, 3*96, 7*96, 'edge')) === sig(L), 'edited loop cut anew: identical');
const Ls = W.recutWindow(L, take, 1*96, 5*96, 'slide');
const fixT = L.link.fix[0];
ok(Ls.notes.some(n => n.n === tPitch && Math.abs(n.t - (target.t + 2*96)) < 0.01), 'slide: the changed note stays with the take (2 bars later in the loop)');
ok(sig(W.recutWindow(Ls, take, 3*96, 7*96, 'slide')) === sig(L), 'slide back: the edit is all there');
// quantize as the loop's setting
const Q = W.quantizeWindow(L, take, 14, 1); // 14 = 1/16?
const ticks = require(D + 'seq-layer.js').DIV_TICKS[14];
ok(Q.notes.filter(n => !n.o && !n.p).every(n => Math.abs(n.t / ticks - Math.round(n.t / ticks)) < 1e-6 || n.t === 0) , `quantize: take notes on the grid (${ticks} ticks)`);
ok(Q.notes.some(n => n.n === tPitch), 'quantize keeps the changed pitch');
const Q2 = W.recutWindow(Q, take, 4*96, 8*96, 'edge');
ok(Q2.notes.filter(n => !n.o && !n.p).every(n => Math.abs(n.t / ticks - Math.round(n.t / ticks)) < 1e-6), 'quantize applies to bars brought in later');
ok(W.follows(Q, take) !== null && sig(W.recutWindow(Q, take, 3*96, 7*96, 'edge')) === sig(Q), 'quantized loop follows and recuts identically');
// a take edit: move the changed note's take note; the loop follows
const T2 = take.copy();
const L2 = L.copy(); L2.origin = L.origin;
const finish = W.beginTakeEdit(T2, [L2]);
const src = T2.notes.find(n => Math.abs(n.t - fixT.k[0]) < 0.01 && n.n === fixT.k[1]);
src.t += 3; T2.sort();
const [L3] = finish();
ok(L3 && L3.link.fix?.[0] && Math.abs(L3.link.fix[0].k[0] - (fixT.k[0] + 3)) < 0.01, 'take edit: the key follows the moved take note');
ok(L3.notes.filter(n => n.n === tPitch).length >= 1 && L3.notes.length === L.notes.length, 'take edit: no doubles, the change still applies');
// a pick-up note corrected, then the start edge moved
let P = loop.copy(); P.origin = loop.origin;
end = W.beginEdit(P, take); const pu = P.notes.find(n => n.p); pu.n = 100; end();
const P2 = W.recutWindow(P, take, 2*96, 7*96, 'edge');
ok(P2.notes.some(n => n.n === 100 && !n.p) && !P2.notes.some(n => n.n === 100 && n.p), 'pick-up changed, start moved before it: it plays in its own bar, changed');
ok(sig(W.recutWindow(P2, take, 3*96, 7*96, 'edge')) === sig(P), 'start back: the changed pick-up wraps again');
// a loop that doesn't follow (another take, or rewritten)
const X = loop.copy(); X.origin = loop.origin; X.notes = X.notes.map(n => ({ ...n, t: n.t + 7 })); X.link = {};
ok(W.follows(X, take) === null, 'a loop changed beyond recognition gets no window');
// a legacy loop (no link, no flags) with a dub is taken on, playing as before
const old = mk(3*96, 7*96); old.link = null; old.notes.push({ t: 50, d: 9, n: 99, v: 99 }); old.sort();
const before = sig(old).replace(/,0,(\d)\]/g, ',X,$1]');
ok(W.follows(old, take) !== null && old.notes.find(n => n.n === 99).o === 1, 'legacy loop taken on: its dub becomes its own');
// gestures: a slide takes the take's, also after the loop's JSON round trip (undo)
const g0 = W.cutWindow(take, 5*96, 9*96, {}).loop.g;
ok(JSON.stringify(W.recutWindow(loop, take, 5*96, 9*96, 'slide').g) === JSON.stringify(g0), 'slide: gestures come from the take');
const loopG = Take.from(JSON.parse(JSON.stringify(loop.toJSON())));
ok(JSON.stringify(W.recutWindow(loopG, take, 5*96, 9*96, 'slide').g) === JSON.stringify(g0), 'after toJSON: still the take\'s gestures (not taken for overdubbed)');
const dubG = loop.copy(); dubG.origin = loop.origin; dubG.g = { ...dubG.g, c64: [10, 127, 300, 0] };
ok(JSON.stringify(W.recutWindow(dubG, take, 5*96, 9*96, 'slide').g.c64) === JSON.stringify([10, 127, 300, 0]), 'overdubbed pedal: kept on a slide');
// a linked loop whose take changed under it (another arrangement): no window
const T3 = take.copy(); T3.notes[20].t += 5; T3.sort();
const L4 = loop.copy(); L4.origin = loop.origin;
ok(W.follows(L4, T3) === null, 'a linked loop whose take changed under it gets no window');
// cleared MPE stays cleared
const M = loop.copy(); M.origin = loop.origin; M.notes[0].x = { p: [0, 100] }; M.clearExpression();
ok(M.link.plain === 1 && !W.recutWindow(M, take, 3*96, 7*96, 'edge').hasExpression, 'cleared MPE stays cleared when cut anew');
console.log(fails ? `${fails} FAILED` : 'all ok');
if (fails) process.exitCode = 1;
