/**
 * The metronome's controls: Click and Count-in in the transport (the Click chip carries
 * the beat light), its sound in the setup drawer (Metronome group). Settings are per
 * machine (metronome.ts), not part of scenes.
 */
import DOM, { escapeHTML as esc } from '../domutils';
import { PortDescriptor } from '../midi';
import { metronomeSettings, updateMetronome, previewMetronome, outputDevices } from '../metronome';

const BEAT_FLASH_MS = 90;

let led: HTMLElement | null = null;
let flashTimer: ReturnType<typeof setTimeout> | null = null;

function initMetronomeControls(): void {
  const clickChip = DOM.get('#metroClick') as HTMLElement;
  const countInChip = DOM.get('#metroCountIn') as HTMLElement;
  led = clickChip.querySelector('.beat-led');
  const sync = (): void => {
    clickChip.classList.toggle('active', metronomeSettings.click);
    countInChip.classList.toggle('active', metronomeSettings.countIn);
    countInChip.textContent = metronomeSettings.countInBars > 1 ? `Count-in ${metronomeSettings.countInBars}` : 'Count-in';
  };
  clickChip.addEventListener('click', () => {
    updateMetronome({ click: !metronomeSettings.click });
    sync();
  });
  countInChip.addEventListener('click', () => {
    updateMetronome({ countIn: !metronomeSettings.countIn });
    sync();
  });

  const bars = DOM.get('#metroBars') as HTMLSelectElement;
  bars.value = String(metronomeSettings.countInBars);
  bars.addEventListener('change', () => {
    updateMetronome({ countInBars: parseInt(bars.value) || 1 });
    sync();
  });

  const volume = DOM.get('#metroVolume') as HTMLInputElement;
  const volumeValue = DOM.get('#metroVolumeValue') as HTMLOutputElement;
  const showVolume = (): void => {
    volume.value = String(Math.round(metronomeSettings.volume * 100));
    volume.style.setProperty('--fill', `${volume.value}%`);
    volumeValue.textContent = volume.value === '0' ? 'Off' : `${volume.value}%`;
  };
  showVolume();
  volume.addEventListener('input', () => {
    updateMetronome({ volume: parseInt(volume.value) / 100 });
    showVolume();
  });
  volume.addEventListener('change', () => previewMetronome());

  const output = DOM.get('#metroOutput') as HTMLSelectElement;
  const listOutputs = async (): Promise<void> => {
    const devices = await outputDevices().catch(() => []);
    const chosen = metronomeSettings.sinkId;
    const missing = chosen && !devices.some((d) => d.id === chosen);
    output.innerHTML =
      '<option value="">System output</option>' +
      devices.map((d) => `<option value="${esc(d.id)}">${esc(d.label)}</option>`).join('') +
      (missing ? `<option value="${esc(chosen)}">⚠ missing output</option>` : '');
    output.value = chosen;
  };
  void listOutputs();
  navigator.mediaDevices?.addEventListener?.('devicechange', () => void listOutputs());
  output.addEventListener('change', () => {
    updateMetronome({ sinkId: output.value });
    previewMetronome();
  });

  const port = DOM.get('#metroMidiPort') as HTMLSelectElement;
  port.addEventListener('change', () => {
    updateMetronome({ midiPortId: port.value });
    showMidiFields();
  });
  const channel = DOM.get('#metroMidiChannel') as HTMLSelectElement;
  channel.innerHTML = Array.from({ length: 16 }, (_, i) => `<option value="${i}">Ch ${i + 1}</option>`).join('');
  channel.value = String(metronomeSettings.midiChannel);
  channel.addEventListener('change', () => updateMetronome({ midiChannel: parseInt(channel.value) }));
  const noteField = (id: string, key: 'accentNote' | 'beatNote'): void => {
    const input = DOM.get(id) as HTMLInputElement;
    input.value = String(metronomeSettings[key]);
    input.addEventListener('input', () => {
      const n = parseInt(input.value);
      if (n >= 0 && n <= 127) updateMetronome({ [key]: n });
    });
    input.addEventListener('blur', () => (input.value = String(metronomeSettings[key])));
  };
  noteField('#metroAccentNote', 'accentNote');
  noteField('#metroBeatNote', 'beatNote');
  showMidiFields();
  sync();
}

function showMidiFields(): void {
  DOM.get('#metroSettings')?.classList.toggle('has-midi', !!metronomeSettings.midiPortId);
}

/** The MIDI click's port selector (visible outputs; the chosen port is kept visible by portsInUse()) */
function updateMetronomePorts(outputs: PortDescriptor[]): void {
  const port = DOM.get('#metroMidiPort') as HTMLSelectElement | null;
  if (!port) return;
  const chosen = metronomeSettings.midiPortId;
  const missing = chosen && !outputs.some((p) => p.id === chosen);
  port.innerHTML =
    '<option value="">(None)</option>' +
    outputs.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('') +
    (missing ? `<option value="${esc(chosen)}">⚠ missing</option>` : '');
  port.value = chosen;
  showMidiFields();
}

/** Count-in only works with the internal clock: an external clock decides where bar 1 is */
function setMetronomeClockExternal(external: boolean): void {
  const field = DOM.get('#metroBarsField') as HTMLElement | null;
  const bars = DOM.get('#metroBars') as HTMLSelectElement | null;
  if (!field || !bars) return;
  bars.disabled = external;
  field.classList.toggle('disabled', external);
  field.title = external
    ? 'Count-in needs the internal clock: the external clock decides where bar 1 is. Use your clock source’s count-in'
    : 'How long Count-in counts before Start';
}

/** Flashes the beat light (a beat as it sounds; accent: the first beat of a bar) */
function flashBeat(accent: boolean): void {
  if (!led) return;
  led.classList.remove('beat', 'accent');
  void led.offsetWidth;
  led.classList.add(accent ? 'accent' : 'beat');
  if (flashTimer !== null) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    flashTimer = null;
    led?.classList.remove('beat', 'accent');
  }, BEAT_FLASH_MS);
}

export { initMetronomeControls, updateMetronomePorts, setMetronomeClockExternal, flashBeat };
