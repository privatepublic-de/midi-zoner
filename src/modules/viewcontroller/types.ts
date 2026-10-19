import { Zone } from '../zone/zone-class';
import { Sequence } from '../zone/sequence';
import MIDI, { InputPortDef } from '../midi';

export type ZoneType = Zone;
export type SequenceType = Sequence;
export type MIDIInstance = InstanceType<typeof MIDI>;

export interface ZonesData {
  list: ZoneType[];
  inChannel: number;
  clockOutputPorts: Record<string, boolean>;
  clockSuppressTransportPorts: Record<string, boolean>;
  selectedInputPorts: Record<string, InputPortDef>;
  tempo: number;
  sendInternalClockIfPlaying: boolean;
  outputConfigNames: Record<string, string>;
  arrangementIndex: number;
  nextArrangementIndex: number;
  arrangementQuantIndex: number;
  keySwitchEnabled: boolean;
  mackieOutlineEnabled: boolean;
  knownPortNames: Record<string, string>;
}

export interface ToastProperties {
  warning?: boolean;
}

export interface TouchedNoteResult {
  isLow: boolean;
  low: number | null;
  high: number | null;
}

export interface PortDescriptor {
  id: string;
  name: string;
}

export interface ActionContext {
  zones: ZonesData;
  midiController: MIDIInstance;
  zone: ZoneType;
  zoneindex: number;
  sequence: SequenceType;
  element: HTMLElement;
  ev: MouseEvent;
  actionParam1: string;
  actionParam2: string;
  triggerSave: () => void;
  pushHistory: (snapshot: string, label: string) => void;
  updateValuesForZone: (index: number) => void;
  updateValuesForAllZones: () => void;
  renderControllersForZone: (zone: ZoneType, index: number) => void;
  renderMarkersForZone: (index: number, tempLo?: number, tempHigh?: number) => void;
  renderZones: () => void;
  listUsedPorts: () => Set<string>;
  toast: (msg: string, props?: ToastProperties) => void;
  updateOutputPortsForZone: (index: number, outputs: PortDescriptor[]) => void;
  cachedOutputPorts: PortDescriptor[];
  cachedInputPorts: PortDescriptor[];
  updateInputPortsForZone: (index: number, inputs: PortDescriptor[]) => void;
  findTouchedNote: (ev: MouseEvent, e: HTMLElement, zone: ZoneType) => TouchedNoteResult;
  updateControllerValues: (zone: ZoneType, index: number, onlyIndex?: number) => void;
  selectArrangement: (index: number) => void;
  beforeAction: (label: string) => void;
  startGesture: (label: string) => void;
  endGesture: () => void;
}

export interface ActionHelpers {
  applyParamToggle: () => void;
  applySelectedIndex: () => void;
  applyPercentage: () => void;
  calcAndDisplayPercentage: () => number;
}

export type ActionHandler = () => void | Promise<void>;
export type ActionMap = Record<string, ActionHandler>;
