import { ipcRenderer } from 'electron';
import {
  DevicePreset,
  deleteDevicePreset,
  exportDevicePresets,
  getDevicePresets,
  importDevicePresets,
  revealDevicePresetFolder,
  saveDevicePreset
} from '../device-presets';
import { escapeHTML } from '../domutils';
import { askDevicePresetMeta } from './device-preset-dialog';
import { toast } from './toast';

interface ManagerHooks {
  /** Number of zones linked to the preset */
  usage: (id: string) => number;
  /** Called after the preset list changed (edited, duplicated, deleted, imported) */
  changed: () => void;
}

let hooks: ManagerHooks;

function iconButton(icon: string, title: string, onClick: () => Promise<void>): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'preset-row-action';
  button.title = title;
  button.tabIndex = -1;
  button.innerHTML = `<i class="material-icons">${icon}</i>`;
  button.addEventListener('click', () => {
    onClick().catch((e) => toast(`Device preset: ${escapeHTML(String(e))}`, { warning: true }));
  });
  return button;
}

function knownDevices(): string[] {
  return [...new Set(getDevicePresets().map((p) => p.device))];
}

async function afterChange(): Promise<void> {
  hooks.changed();
  renderList();
}

async function editPreset(preset: DevicePreset): Promise<void> {
  const meta = await askDevicePresetMeta(preset, knownDevices(), 'Edit device preset', 'Save');
  if (!meta) return;
  await saveDevicePreset(meta, preset.controllers, preset.id);
  await afterChange();
}

async function duplicatePreset(preset: DevicePreset): Promise<void> {
  const meta = await askDevicePresetMeta(
    { ...preset, name: `${preset.name} copy` },
    knownDevices(),
    'Duplicate device preset',
    'Duplicate'
  );
  if (!meta) return;
  await saveDevicePreset(meta, preset.controllers, null);
  await afterChange();
}

async function removePreset(preset: DevicePreset): Promise<void> {
  const used = hooks.usage(preset.id);
  const confirmed: boolean = await ipcRenderer.invoke(
    'open-confirm',
    'Delete device preset',
    `Delete preset "${preset.name}" (${preset.device})?` +
      (used > 0 ? `\n\n${used} zone${used > 1 ? 's use' : ' uses'} it and keep${used > 1 ? '' : 's'} its controllers.` : '')
  );
  if (!confirmed) return;
  await deleteDevicePreset(preset.id);
  await afterChange();
}

async function exportPresets(list: DevicePreset[]): Promise<void> {
  const count = await exportDevicePresets(list);
  if (count > 0) toast(`Exported ${count} device preset${count > 1 ? 's' : ''}`);
}

async function importPresets(): Promise<void> {
  const { imported, skipped } = await importDevicePresets();
  if (imported > 0) await afterChange();
  if (skipped.length > 0) {
    toast(`Not a device preset: ${skipped.map(escapeHTML).join(', ')}`, { warning: true });
  } else if (imported > 0) {
    toast(`Imported ${imported} device preset${imported > 1 ? 's' : ''}`);
  }
}

function renderList(): void {
  const list = document.querySelector('#presetManageDialog .preset-manager-list') as HTMLElement;
  list.replaceChildren();
  const presets = getDevicePresets();
  if (presets.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'selectWindowHint';
    empty.textContent = 'No device presets yet. Save the controllers of a zone as a preset, or import preset files.';
    list.append(empty);
  }
  let device: string | null = null;
  for (const preset of presets) {
    if (preset.device !== device) {
      device = preset.device;
      const heading = document.createElement('div');
      heading.className = 'mckhelp-heading';
      heading.textContent = device;
      list.append(heading);
    }
    const row = document.createElement('div');
    row.className = 'preset-row';
    const name = document.createElement('span');
    name.className = 'preset-row-name';
    name.textContent = preset.name;
    name.title = [
      `${preset.controllers.length} controllers`,
      preset.portMatch ? `Port match: ${preset.portMatch}` : '',
      preset.notes ?? ''
    ]
      .filter((t) => t)
      .join('\n');
    row.append(name);
    if (preset.source == 'factory') {
      const badge = document.createElement('span');
      badge.className = 'preset-row-badge';
      badge.textContent = 'factory';
      row.append(badge);
    }
    const used = hooks.usage(preset.id);
    const info = document.createElement('span');
    info.className = 'preset-row-info';
    info.textContent = `${preset.controllers.length} ctrl${used > 0 ? ` · ${used} zone${used > 1 ? 's' : ''}` : ''}`;
    row.append(info);
    if (preset.source == 'user') {
      row.append(iconButton('edit', 'Edit name, device, port match and notes', () => editPreset(preset)));
    }
    row.append(iconButton('content_copy', 'Duplicate', () => duplicatePreset(preset)));
    row.append(iconButton('save_alt', 'Export to file…', () => exportPresets([preset])));
    if (preset.source == 'user') {
      const remove = iconButton('delete', 'Delete', () => removePreset(preset));
      remove.classList.add('warn');
      row.append(remove);
    }
    list.append(row);
  }
  (document.querySelector('#presetManageDialog .preset-export-all') as HTMLButtonElement).disabled =
    presets.length === 0;
}

let initialised = false;

/** Opens the device preset manager */
export function openDevicePresetManager(managerHooks: ManagerHooks): void {
  hooks = managerHooks;
  const dialog = document.getElementById('presetManageDialog') as HTMLDialogElement;
  if (!initialised) {
    initialised = true;
    dialog.querySelector('.preset-import')!.addEventListener('click', () => importPresets());
    dialog.querySelector('.preset-export-all')!.addEventListener('click', () => exportPresets(getDevicePresets()));
    dialog.querySelector('.preset-reveal')!.addEventListener('click', () => revealDevicePresetFolder());
    dialog.querySelectorAll('.preset-close').forEach((b) => b.addEventListener('click', () => dialog.close()));
  }
  renderList();
  dialog.showModal();
}
