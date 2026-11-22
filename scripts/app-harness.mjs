// Runs the real app for scripts (check:app, screenshots): a throwaway profile, the DevTools
// protocol to drive it, and virtual MIDI ports only (navigator.requestMIDIAccess is replaced
// before the app loads), so no device is ever opened or hears anything.
// Needs Node 22+ (global WebSocket).

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * One app instance in its own profile. `launch()` starts it and returns a CDP connection to
 * its window; `quit(cdp)` closes it gracefully (localStorage flushed, takes saved on unload).
 */
export function createApp({ prefix = 'zoner-check-' } = {}) {
  const port = 9300 + Math.floor(Math.random() * 600);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  let proc = null;

  async function launch(extraArgs = []) {
    const env = { ...process.env };
    // the VS Code shell sets it, and Electron then runs as plain Node
    delete env.ELECTRON_RUN_AS_NODE;
    proc = spawn(path.join(ROOT, 'node_modules/.bin/electron'), ['.', `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, ...extraArgs], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'ignore', 'pipe']
    });
    proc.stderr.on('data', () => undefined);
    for (let i = 0; i < 100; i++) {
      await wait(200);
      try {
        const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
        const page = list.find((t) => t.type === 'page' && t.url.includes('index.html'));
        if (page) return connect(page.webSocketDebuggerUrl);
      } catch {
        // not up yet
      }
    }
    throw new Error('the app did not start');
  }

  async function quit(cdp) {
    // a window closed gracefully flushes localStorage (and runs the takes' save on unload)
    await cdp.eval('window.close()').catch(() => undefined);
    cdp.close();
    for (let i = 0; i < 25 && proc.exitCode === null; i++) await wait(200);
    if (proc.exitCode === null) proc.kill();
    for (let i = 0; i < 25 && proc.exitCode === null; i++) await wait(200);
    proc = null;
  }

  /** Kills a still running app and removes the profile (unless kept) */
  async function cleanup(keep = false) {
    if (proc) {
      proc.kill();
      await wait(1000);
    }
    if (keep) return console.log('profile kept at', profile);
    for (let i = 0; i < 5; i++) {
      try {
        fs.rmSync(profile, { recursive: true, force: true });
        break;
      } catch {
        await wait(500);
      }
    }
  }

  return { profile, launch, quit, cleanup, running: () => proc !== null };
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    const listeners = new Map();
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.method) {
        for (const fn of listeners.get(msg.method) ?? []) fn(msg.params);
        return;
      }
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    };
    ws.onerror = reject;
    const send = (method, params = {}) =>
      new Promise((res, rej) => {
        pending.set(++id, { resolve: res, reject: rej });
        ws.send(JSON.stringify({ id, method, params }));
      });
    const cdp = {
      send,
      close: () => ws.close(),
      /** Calls `fn(params)` for every event `method` (e.g. 'Page.screencastFrame'); returns a function that stops it */
      on(method, fn) {
        if (!listeners.has(method)) listeners.set(method, new Set());
        listeners.get(method).add(fn);
        return () => listeners.get(method).delete(fn);
      },
      /** Evaluates an expression (awaited) in the page; returns its value */
      async eval(expr) {
        const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
        return r.result.value;
      },
      /** Polls an expression until it's truthy */
      async until(expr, ms = 5000, what = expr) {
        for (let t = 0; t < ms; t += 100) {
          const v = await cdp.eval(expr).catch(() => null);
          if (v) return v;
          await wait(100);
        }
        throw new Error('timed out waiting for ' + what);
      }
    };
    ws.onopen = () => resolve(cdp);
  });
}

/**
 * Virtual MIDI ports for the page: `inputs` / `outputs` as [{id, name}]. What is sent to an
 * output is kept in `__check.sent` ({t, d, port}); `__check.play(data, inputId?)` plays a
 * message into an input (the first one when no id is given).
 */
export function fakeMidiSource(inputs, outputs) {
  return `(() => {
  const check = (window.__check = { sent: [], t0: 0 });
  const port = (id, name, type) => ({
    id, name, type, manufacturer: 'check', version: '1', state: 'connected', connection: 'open',
    onmidimessage: null, onstatechange: null,
    open: async function () { return this; }, close: async function () { return this; },
    addEventListener() {}, removeEventListener() {}, clear() {}
  });
  const outs = ${JSON.stringify(outputs)}.map((p) => {
    const out = port(p.id, p.name, 'output');
    out.send = (d, ts) => check.sent.push({ t: ts && ts > 0 ? ts : performance.now(), d: Array.from(d), port: p.id });
    return out;
  });
  const ins = ${JSON.stringify(inputs)}.map((p) => port(p.id, p.name, 'input'));
  check.play = (d, id) => {
    const inp = id ? ins.find((p) => p.id === id) : ins[0];
    if (inp && inp.onmidimessage) inp.onmidimessage({ data: Uint8Array.from(d), target: inp, timeStamp: performance.now() });
  };
  const access = { inputs: new Map(ins.map((p) => [p.id, p])), outputs: new Map(outs.map((p) => [p.id, p])), sysexEnabled: true, onstatechange: null,
    addEventListener() {}, removeEventListener() {} };
  navigator.requestMIDIAccess = async () => access;
})();`;
}

/** Reloads the page with the virtual ports in place of Web MIDI */
export async function withFakeMidi(cdp, source) {
  await cdp.send('Page.enable');
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source });
  await cdp.send('Page.reload');
  await wait(500);
  await cdp.until('window.__check && document.querySelector("#zones")', 10000, 'the app with fake MIDI');
}
