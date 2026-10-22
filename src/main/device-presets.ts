import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
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

  ipcMain.handle('presets-delete', (event, id: string): void => {
    if (!USER_ID.test(id)) throw new Error(`Not a user preset: ${id}`);
    fs.rmSync(path.join(userDir(), `${id.slice(5)}.json`), { force: true });
  });

  // Picks preset files to import; the renderer validates and saves them as new user presets
  ipcMain.handle('presets-import', async (event): Promise<{ name: string; json: string }[]> => {
    const win = BrowserWindow.fromWebContents(event.sender)!;
    const result = await dialog.showOpenDialog(win, {
      title: 'Import device presets',
      buttonLabel: 'Import',
      filters: [{ name: 'midi-zoner Device Preset', extensions: ['json'] }],
      properties: ['openFile', 'multiSelections']
    });
    if (result.canceled) return [];
    return result.filePaths.flatMap((f) => {
      try {
        return [{ name: path.basename(f), json: fs.readFileSync(f, 'utf-8') }];
      } catch (e) {
        console.log(e);
        return [];
      }
    });
  });

  // One preset: save dialog. Several: pick a folder, files named after the presets.
  // Returns the number of files written.
  ipcMain.handle('presets-export', async (event, files: { name: string; json: string }[]): Promise<number> => {
    const win = BrowserWindow.fromWebContents(event.sender)!;
    if (files.length === 1) {
      const result = await dialog.showSaveDialog(win, {
        title: 'Export device preset',
        defaultPath: `${slug(files[0].name)}.json`,
        filters: [{ name: 'midi-zoner Device Preset', extensions: ['json'] }],
        properties: ['createDirectory']
      });
      if (result.canceled || !result.filePath) return 0;
      fs.writeFileSync(result.filePath, files[0].json, 'utf-8');
      return 1;
    }
    const result = await dialog.showOpenDialog(win, {
      title: 'Export device presets to folder',
      buttonLabel: 'Export',
      properties: ['openDirectory', 'createDirectory']
    });
    if (result.canceled) return 0;
    const dir = result.filePaths[0];
    for (const f of files) {
      const base = slug(f.name);
      let fileName = base;
      for (let n = 2; fs.existsSync(path.join(dir, `${fileName}.json`)); n++) fileName = `${base}-${n}`;
      fs.writeFileSync(path.join(dir, `${fileName}.json`), f.json, 'utf-8');
    }
    return files.length;
  });

  ipcMain.handle('presets-reveal', async (): Promise<void> => {
    const dir = userDir();
    fs.mkdirSync(dir, { recursive: true });
    await shell.openPath(dir);
  });
}
