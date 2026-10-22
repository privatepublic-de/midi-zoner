import { app, ipcMain, shell } from 'electron';
import path from 'path';
import fs from 'fs';

/**
 * Device presets (CC/NRPN controller sets) live as one JSON file each, apart from scenes:
 * factory presets ship read-only in res/device-presets, user presets go to
 * <userData>/device-presets. Ids are "<source>/<file name without .json>".
 * Parsing and validation happen in the renderer (modules/device-presets.ts).
 */

export interface PresetFile {
  id: string;
  source: 'factory' | 'user';
  json: string;
}

const USER_ID = /^user\/[a-z0-9-]{1,64}$/;

function userDir(): string {
  return path.join(app.getPath('userData'), 'device-presets');
}

function factoryDir(): string {
  return path.join(app.getAppPath(), 'res', 'device-presets');
}

function readDir(dir: string, source: PresetFile['source']): PresetFile[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .flatMap((f) => {
      try {
        return [{ id: `${source}/${f.slice(0, -5)}`, source, json: fs.readFileSync(path.join(dir, f), 'utf-8') }];
      } catch (e) {
        console.log(e);
        return [];
      }
    });
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 56) || 'preset'
  );
}

export function registerDevicePresetHandlers(): void {
  ipcMain.handle('presets-list', (): PresetFile[] => [
    ...readDir(factoryDir(), 'factory'),
    ...readDir(userDir(), 'user')
  ]);

  // Overwrites the user preset `id`, or creates a new file named after `baseName`. Returns the id.
  ipcMain.handle('presets-save', (event, json: string, id: string | null, baseName: string): string => {
    const dir = userDir();
    fs.mkdirSync(dir, { recursive: true });
    let fileId: string;
    if (id != null) {
      if (!USER_ID.test(id)) throw new Error(`Not a user preset: ${id}`);
      fileId = id.slice(5);
    } else {
      const base = slug(baseName);
      fileId = base;
      for (let n = 2; fs.existsSync(path.join(dir, `${fileId}.json`)); n++) fileId = `${base}-${n}`;
    }
    fs.writeFileSync(path.join(dir, `${fileId}.json`), json, 'utf-8');
    return `user/${fileId}`;
  });

  ipcMain.handle('presets-reveal', async (): Promise<void> => {
    const dir = userDir();
    fs.mkdirSync(dir, { recursive: true });
    await shell.openPath(dir);
  });
}
