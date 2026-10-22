import { DevicePresetMeta } from '../device-presets';

/** Asks for name, device, port match and notes of a new device preset; null when cancelled */
export function askDevicePresetMeta(
  defaults: Partial<DevicePresetMeta>,
  knownDevices: string[]
): Promise<DevicePresetMeta | null> {
  const dialog = document.getElementById('presetSaveDialog') as HTMLDialogElement;
  const form = dialog.querySelector('form') as HTMLFormElement;
  const field = (name: string): HTMLInputElement | HTMLTextAreaElement =>
    form.elements.namedItem(name) as HTMLInputElement | HTMLTextAreaElement;
  field('name').value = defaults.name ?? '';
  field('device').value = defaults.device ?? '';
  field('portMatch').value = defaults.portMatch ?? '';
  field('notes').value = defaults.notes ?? '';
  const list = document.getElementById('presetDeviceList') as HTMLDataListElement;
  list.replaceChildren(
    ...knownDevices.map((d) => {
      const option = document.createElement('option');
      option.value = d;
      return option;
    })
  );
  dialog.returnValue = '';
  dialog.showModal();
  (field('name') as HTMLInputElement).select();
  return new Promise((resolve) => {
    dialog.addEventListener(
      'close',
      () => {
        if (dialog.returnValue !== 'save') {
          resolve(null);
          return;
        }
        resolve({
          name: field('name').value.trim(),
          device: field('device').value.trim(),
          portMatch: field('portMatch').value.trim(),
          notes: field('notes').value.trim()
        });
      },
      { once: true }
    );
  });
}
