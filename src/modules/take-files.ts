import fs from 'fs';
import path from 'path';
import { ipcRenderer } from 'electron';
import { takeStore } from './take-store';
import { Take } from './zone/take';

/**
 * The takes are saved in a file of their own (<userData>/takes.json), apart from the
 * scene in localStorage: they can grow to megabytes. Written a second after a change,
 * atomically (a temp file, then renamed), and at once when the window closes.
 */

const SAVE_DELAY_MS = 1000;
let file = '';
let timer: ReturnType<typeof setTimeout> | null = null;
let savedVersion = -1;
let zoneIds: () => string[] = () => [];

function takesFile(): string {
  if (!file) file = path.join(ipcRenderer.sendSync('user-data-path') as string, 'takes.json');
  return file;
}

/** What goes into the file: the takes of the zones in the scene */
function contents(): string {
  const zones: Record<string, unknown[]> = {};
  for (const id of zoneIds()) {
    const takes = takeStore.toJSON(id);
    if (takes.length) zones[id] = takes;
  }
  return JSON.stringify({ format: 'midi-zoner-takes', version: 1, zones });
}

/** Reads the saved takes for the zones in the scene (an untrusted file: every take is checked) */
function loadSavedTakes(ids: string[]): void {
  let data: any;
  try {
    data = JSON.parse(fs.readFileSync(takesFile(), 'utf8'));
  } catch {
    return;
  }
  if (!data || data.format !== 'midi-zoner-takes' || !data.zones || typeof data.zones !== 'object') return;
  for (const id of ids) {
    const takes = Take.listFrom(data.zones[id]);
    if (takes.length) takeStore.set(id, takes);
  }
  savedVersion = takeStore.version;
}

function saveNow(sync: boolean): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (takeStore.version === savedVersion) return;
  savedVersion = takeStore.version;
  const json = contents();
  const target = takesFile();
  const temp = `${target}.tmp`;
  if (sync) {
    try {
      fs.writeFileSync(temp, json);
      fs.renameSync(temp, target);
    } catch (e) {
      console.error('takes: not saved', e);
    }
    return;
  }
  fs.promises
    .writeFile(temp, json)
    .then(() => fs.promises.rename(temp, target))
    .catch((e) => {
      console.error('takes: not saved', e);
      savedVersion = -1;
    });
}

/** Saves after every change (the zones' ids from `ids`), and when the window closes */
function initTakeFiles(ids: () => string[]): void {
  zoneIds = ids;
  takeStore.onChange = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => saveNow(false), SAVE_DELAY_MS);
  };
  window.addEventListener('beforeunload', () => saveNow(true));
}

/** The zones' takes have to be saved again (a zone was added, deleted or its scene replaced) */
function takesNeedSaving(): void {
  savedVersion = -1;
  takeStore.onChange?.();
}

export { initTakeFiles, loadSavedTakes, takesNeedSaving };
