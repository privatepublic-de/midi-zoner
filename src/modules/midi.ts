import * as internalClock from './internal-clock';

interface PortDescriptor {
  id: string;
  name: string;
  fullName: string;
  isSelectedInput: boolean;
  isSelectedClockInput: boolean;
}

interface InputPortDef {
  id: string;
  ch: number;
  isSelected: boolean;
  allChannels?: boolean;
}

interface MIDIHandlers {
  portsChangedHandler?: (available: boolean, inputs: PortDescriptor[], outputs: PortDescriptor[], msg?: string) => void;
  eventHandler: (event: MIDIMessageEvent) => void;
  clockHandler?: (pos: number, tickIntervalMs: number) => void;
  transportHandler?: (started: boolean) => void;
  panicHandler?: () => void;
}

interface ListResult {
  success: boolean;
  message?: string;
  inputs: PortDescriptor[];
  outputs: PortDescriptor[];
}

/**
 * Web MIDI interface handler
 */
class MIDI {
  static INTERNAL_PORT_ID = '*';
  static NOTENAMES = [
    'C-',
    'C#',
    'D-',
    'D#',
    'E-',
    'F-',
    'F#',
    'G-',
    'G#',
    'A-',
    'A#',
    'B-'
  ] as const;
  static MESSAGE = {
    NOTE_OFF: 0x80,
    NOTE_ON: 0x90,
    NOTE_PRESSURE: 0xa0,
    CONTROLLER: 0xb0,
    PGM_CHANGE: 0xc0,
    CHANNEL_PRESSURE: 0xd0,
    PITCH_BEND: 0xe0,
    SYSTEM_EXCLUSIVE: 0xf0,
    SYSTEM_EXCLUSIVE_REAL_TIME: 0x7f,
    SONG_POS: 0xf2,
    SONG_SELECT: 0xf3,
    TUNE_REQUEST: 0xf6,
    CLOCK: 0xf8,
    START: 0xfa,
    CONTINUE: 0xfb,
    STOP: 0xfc
  } as const;

  panicHandler?: () => void;
  eventHandler: (event: MIDIMessageEvent) => void;
  transportHandler?: (started: boolean) => void;
  clockHandler?: (pos: number, tickIntervalMs: number) => void;
  midiAccess: MIDIAccess | null = null;
  deviceIdInClock: string | null;
  deviceInClock: MIDIInput | null = null;
  knownPorts: Record<string, MIDIInput | MIDIOutput> = {};
  usedPorts: Set<string> = new Set();
  clockOutputPorts: Record<string, boolean> = {};
  selectedInputPorts: Record<string, InputPortDef> = {};
  zoneInputPorts: Set<string> = new Set();
  deviceIdMackieControl: string | null = null;
  deviceIdMackieOutput: string | null = null;
  outputPortsRegistered: PortDescriptor[] = [];
  songposition = 0;
  isClockRunning = false;
  hasClock = false;
  sendClockIfPlaying = false;
  detectedBpm: number | null = null;
  bpmDetectedHandler: ((bpm: number | null) => void) | null = null;
  currentTickIntervalMs: number = 60000 / 120 / 24;
  private _warnedMissingPorts = new Set<string>();
  private _clockLostTimeout: ReturnType<typeof setTimeout> | null = null;
  private _bpmTimestamps: number[] = [];
  private _bpmTicksSinceUpdate = 0;
  private _recentTickTimestamps: number[] = [];

  constructor({
    portsChangedHandler,
    eventHandler,
    clockHandler,
    transportHandler,
    panicHandler,
  }: MIDIHandlers) {
    console.log('MIDI: Initializing...');
    this.panicHandler = panicHandler;
    this.eventHandler = eventHandler;
    this.transportHandler = transportHandler;
    this.clockHandler = clockHandler;
    this.deviceIdInClock = localStorage.getItem('midiInClockId');

    const reportStatus = (
      available: boolean,
      msg: string | undefined,
      inputPorts?: PortDescriptor[],
      outputPorts?: PortDescriptor[]
    ): void => {
      this.outputPortsRegistered = outputPorts || [];
      if (portsChangedHandler) {
        portsChangedHandler(available, inputPorts || [], outputPorts || [], msg);
      }
    };

    const onMIDISuccess = (midiAccess: MIDIAccess): void => {
      console.log('MIDI: ready');
      this.midiAccess = midiAccess;
      const initResult = listInputsAndOutputs();
      this.selectDevices(this.deviceIdInClock);
      this.midiAccess.onstatechange = onStateChange;
      reportStatus(
        initResult.success,
        initResult.message,
        initResult.inputs,
        initResult.outputs
      );
    };

    const onMIDIFailure = (msg: DOMException): void => {
      console.log('MIDI: Failed to get MIDI access - ' + msg);
      reportStatus(false, 'No MIDI available');
    };

    const onStateChange = (e: MIDIConnectionEvent): void => {
      const port = e.port;
      const portName = e.port.name;
      const wasNew = !this.knownPorts[port.id];

      if (port.state === 'disconnected') {
        delete this.knownPorts[port.id];
        if (port.id === this.deviceIdInClock) {
          // clock port gone — portsChangedHandler will fall back to internal
          this.deviceIdInClock = null;
        }
      } else {
        this._warnedMissingPorts.clear();
      }

      const initResult = listInputsAndOutputs();
      this.selectDevices(this.deviceIdInClock);

      // only report disconnect and genuinely new ports to avoid flooding the UI
      if (port.state === 'disconnected' || wasNew) {
        setTimeout(() => {
          reportStatus(
            initResult.success,
            `${portName} ${port.state}`,
            initResult.inputs,
            initResult.outputs
          );
        }, 0);
      }
    };

    // Pure port enumeration — no side effects on deviceIdInClock.
    // isSelectedClockInput reflects the current runtime deviceIdInClock value.
    const listInputsAndOutputs = (): ListResult => {
      let selectedIn: string | null = null;
      let countIn = 0;
      let countOut = 0;

      const sortPortsComparator = (
        a: [string, MIDIPort],
        b: [string, MIDIPort]
      ): number => {
        const aUpper = ('' + a[1].name).toUpperCase();
        const bUpper = ('' + b[1].name).toUpperCase();
        if (aUpper < bUpper) return -1;
        if (bUpper < aUpper) return 1;
        return 0;
      };

      const sortedInputs = Array.from(this.midiAccess.inputs).sort(sortPortsComparator);
      const savedMidiInId = localStorage.getItem('midiInId');
      sortedInputs.forEach((entry) => {
        const input = entry[1];
        this.knownPorts[input.id] = input;
        if (input.id == savedMidiInId) selectedIn = input.id;
        countIn++;
      });

      const sortedOutputs = Array.from(this.midiAccess.outputs).sort(sortPortsComparator);
      sortedOutputs.forEach((entry) => {
        this.knownPorts[entry[1].id] = entry[1];
        countOut++;
      });
      console.log('MIDI: ', countIn, 'inputs,', countOut, 'outputs');

      const mapDescriptor = (port: [string, MIDIPort]): PortDescriptor => {
        let sName = port[1].name;
        if (sName.length > 20) {
          sName =
            sName.substr(0, 10).trim() +
            '…' +
            sName.substr(sName.length - 10, 10).trim();
        }
        return {
          id: port[1].id,
          name: sName,
          fullName: port[1].name,
          isSelectedInput: port[1].id == selectedIn,
          isSelectedClockInput: port[1].id === this.deviceIdInClock
        };
      };

      const inputDescriptors = sortedInputs.map(mapDescriptor);
      const outputDescriptors = sortedOutputs.map(mapDescriptor);

      if (countIn == 0 || countOut == 0) {
        const message =
          countIn > 0 ? 'No MIDI output devices' :
          countOut > 0 ? 'No MIDI input devices' :
          'No MIDI devices';
        return { success: true, message, inputs: inputDescriptors, outputs: outputDescriptors };
      }
      return { success: true, inputs: inputDescriptors, outputs: outputDescriptors };
    };

    // go ahead, start midi
    if ('requestMIDIAccess' in navigator) {
      console.log('MIDI: System has MIDI support.');
      navigator
        .requestMIDIAccess({ sysex: true })
        .then(onMIDISuccess, onMIDIFailure);
    } else {
      console.log('MIDI: System has *no* MIDI support.');
      reportStatus(false, 'Sorry, browser has no MIDI support.');
    }
  }

  onMIDIMessage(event: MIDIMessageEvent): void {
    const portId = event.target
      ? (event.target as MIDIInput).id
      : MIDI.INTERNAL_PORT_ID;
    const midiMessage = event.data[0];

    if (
      this.deviceIdInClock == portId &&
      (midiMessage === MIDI.MESSAGE.CLOCK ||
        midiMessage === MIDI.MESSAGE.START ||
        midiMessage === MIDI.MESSAGE.CONTINUE ||
        midiMessage === MIDI.MESSAGE.STOP)
    ) {
      // Computed once and shared by the rolling-average update and the clockHandler call
      let tickTimestamp = 0;

      if (midiMessage === MIDI.MESSAGE.CLOCK) {
        this.hasClock = true;
        clearTimeout(this._clockLostTimeout!);
        this._clockLostTimeout = setTimeout(() => {
          this.hasClock = false;
          if (this.bpmDetectedHandler) this.bpmDetectedHandler(null);
        }, 500);

        // Tick timestamp in performance.now() domain for the rolling-average tick interval
        tickTimestamp = (event as { timestamp?: number }).timestamp ?? event.timeStamp;
        this._recentTickTimestamps.push(tickTimestamp);
        if (this._recentTickTimestamps.length > 4) this._recentTickTimestamps.shift();
        if (this._recentTickTimestamps.length >= 2) {
          const n = this._recentTickTimestamps.length - 1;
          this.currentTickIntervalMs =
            (this._recentTickTimestamps[n] - this._recentTickTimestamps[0]) / n;
        }

        if (
          this.deviceIdInClock !== MIDI.INTERNAL_PORT_ID &&
          this.bpmDetectedHandler
        ) {
          this._bpmTimestamps.push(event.timeStamp);
          if (this._bpmTimestamps.length > 97) {
            this._bpmTimestamps.shift();
          }
          this._bpmTicksSinceUpdate++;
          if (
            this._bpmTicksSinceUpdate >= 24 &&
            this._bpmTimestamps.length >= 2
          ) {
            this._bpmTicksSinceUpdate = 0;
            const n = this._bpmTimestamps.length - 1;
            const avgMs = (this._bpmTimestamps[n] - this._bpmTimestamps[0]) / n;
            this.detectedBpm = 60000 / (avgMs * 24);
            this.bpmDetectedHandler(this.detectedBpm);
          }
        }
      }
      if (
        midiMessage === MIDI.MESSAGE.START ||
        midiMessage === MIDI.MESSAGE.CONTINUE
      ) {
        // start
        this.isClockRunning = true;
        if (this.transportHandler) {
          this.transportHandler(true);
        }
      } else if (midiMessage === MIDI.MESSAGE.STOP) {
        this.isClockRunning = false;
        this.songposition = 0;
        if (this.transportHandler) {
          this.transportHandler(false);
        }
      }

      const propagate =
        midiMessage === MIDI.MESSAGE.STOP ||
        !this.sendClockIfPlaying ||
        (this.sendClockIfPlaying && this.isClockRunning);
      if (propagate) {
        // Use timestamp from internal clock for precise scheduling
        const timestamp = (event as { timestamp?: number }).timestamp;
        for (const [portid, enabled] of Object.entries(this.clockOutputPorts)) {
          if (enabled) {
            this.send(event.data, portid, timestamp);
          }
        }
      }

      if (
        this.isClockRunning &&
        this.clockHandler &&
        midiMessage === MIDI.MESSAGE.CLOCK
      ) {
        this.clockHandler(this.songposition, this.currentTickIntervalMs);
        this.songposition++;
      }
    }

    const channel = event.data[0] & 0x0f;
    const portDef = this.selectedInputPorts[portId];
    if (this.zoneInputPorts.has(portId)) {
      // Port has per-zone subscribers: pass all channels, app.ts filters per-zone
      this.eventHandler(event);
    } else if (
      portDef &&
      portDef.isSelected &&
      (portDef.allChannels || portDef.ch === channel)
    ) {
      this.eventHandler(event);
    } else if (this.deviceIdMackieControl === portId) {
      this.eventHandler(event);
    }
  }

  selectDevices(deviceIdInClock: string | null): void {
    if (deviceIdInClock !== this.deviceIdInClock) {
      this._bpmTimestamps = [];
      this._bpmTicksSinceUpdate = 0;
      this._recentTickTimestamps = [];
      this.detectedBpm = null;
      this.deviceIdInClock = deviceIdInClock;
      if (this.bpmDetectedHandler) this.bpmDetectedHandler(null);
    } else {
      this.deviceIdInClock = deviceIdInClock;
    }
    if (deviceIdInClock == MIDI.INTERNAL_PORT_ID) {
      internalClock.setHandler(this.onMIDIMessage.bind(this));
    } else {
      internalClock.setHandler(null);
    }
    const activePorts = new Set<string>();
    if (this.deviceIdInClock && this.deviceIdInClock !== MIDI.INTERNAL_PORT_ID) {
      activePorts.add(this.deviceIdInClock);
    }
    Object.values(this.selectedInputPorts).forEach((inputDef) => {
      if (inputDef.isSelected) activePorts.add(inputDef.id);
    });
    this.zoneInputPorts.forEach((portId) => activePorts.add(portId));
    if (this.deviceIdMackieControl) {
      activePorts.add(this.deviceIdMackieControl);
    }

    const handler = this.onMIDIMessage.bind(this);
    this.midiAccess?.inputs.forEach((entry: MIDIInput) => {
      entry.onmidimessage = activePorts.has(entry.id) ? handler : null;
    });

    this.deviceInClock =
      this.midiAccess?.inputs.get(this.deviceIdInClock!) ?? null;
  }

  selectInputPort(portId: string, channel: number, isSelected: boolean): void {
    this.selectedInputPorts[portId] = {
      id: portId,
      ch: channel,
      isSelected: isSelected
    };
  }

  /**
   * Send MIDI messages "all sound off" (0x78), "reset controllers" (0x79), "all notes off" (0x7b)
   * to all currently used ports on all 16 MIDI channels.
   */
  panic(): void {
    for (let i = 0; i < 16; i++) {
      const msg = new Uint8Array(3);
      msg[0] = MIDI.MESSAGE.CONTROLLER + i;
      msg[2] = 0;
      msg[1] = 120; // all sound off
      this.sendToAllUsedPorts(msg);
      msg[1] = 121; // reset controllers
      this.sendToAllUsedPorts(msg);
      msg[1] = 123; // all notes off
      this.sendToAllUsedPorts(msg);
    }
    console.log(
      'MIDI: Panic. Sent CC 120, 122, 123 to all channels and used ports'
    );
    if (this.panicHandler) this.panicHandler();
  }

  /**
   * Send MIDI message to given portId, optionally scheduled at timestamp
   */
  send(msg: Uint8Array, portId: string, timestamp?: number): void {
    if (!portId || portId == MIDI.INTERNAL_PORT_ID) {
      // do nothing
    } else {
      const deviceOut = this.knownPorts[portId] as MIDIOutput | undefined;
      if (deviceOut) {
        deviceOut.send(msg, timestamp);
      } else if (!this._warnedMissingPorts.has(portId)) {
        this._warnedMissingPorts.add(portId);
      }
    }
  }

  /**
   * Send MIDI message to all used ports.
   */
  sendToAllUsedPorts(msg: Uint8Array): void {
    this.usedPorts.forEach((portId) => {
      const deviceOut = this.knownPorts[portId] as MIDIOutput | undefined;
      if (deviceOut) {
        deviceOut.send(msg);
      }
    });
  }

  sendToAllClockReceiverPorts(msg: Uint8Array): void {
    for (const [portid, enabled] of Object.entries(this.clockOutputPorts)) {
      if (enabled) {
        const deviceOut = this.knownPorts[portid] as MIDIOutput | undefined;
        if (deviceOut) {
          deviceOut.send(msg);
        }
      }
    }
  }

  sendMackie(note: number, velocity: number): void {
    if (!this.deviceIdMackieOutput) return;
    const msg = new Uint8Array(3);
    msg[0] = 0x90; // Note On ch 1
    msg[1] = note;
    msg[2] = velocity;
    this.send(msg, this.deviceIdMackieOutput);
  }

  /**
   * Send MIDI start message (0xfa) to all used ports.
   */
  sendStart(): void {
    this.sendToAllClockReceiverPorts(startMSG);
  }

  /**
   * Send MIDI stop message (0xfc) and song position start (0xf2, 0, 0) to all used ports.
   */
  sendStop(): void {
    this.sendToAllClockReceiverPorts(stopMSG);
    this.sendToAllClockReceiverPorts(songPosStart);
  }

  /**
   * Send program change message (0xc0) to given port.
   */
  sendProgramChange(portId: string, channel: number, no: number): void {
    const deviceOut = this.knownPorts[portId] as MIDIOutput | undefined;
    if (deviceOut) {
      deviceOut.send(Uint8Array.from([channel + MIDI.MESSAGE.PGM_CHANGE, no]));
    }
  }

  /**
   * Starts internal MIDI clock and sends MIDI start message
   * if MIDI controller's sendInternalClock is set to true.
   */
  startClock(): void {
    if (this.deviceIdInClock == MIDI.INTERNAL_PORT_ID) {
      this.sendStart();
      if (this.transportHandler) {
        this.transportHandler(true);
      }
    }
    this.songposition = 0;
    this.isClockRunning = true;
  }

  /**
   * Stops internal MIDI clock and send MIDI stop message
   * if MIDI controller's sendInternalClock is set to true.
   */
  stopClock(): void {
    if (this.deviceIdInClock == MIDI.INTERNAL_PORT_ID) {
      this.sendStop();
      if (this.transportHandler) {
        this.transportHandler(false);
      }
    }
    this.isClockRunning = false;
  }

  setInternalBPM(v: number): void {
    internalClock.setBPM(v);
  }

  /**
   * Update list of used ports. This list is used for
   * all "sendToAllPorts" methods.
   */
  updateUsedPorts(set: Set<string>): void {
    this.usedPorts = set;
  }

  updateClockOutputReceiver(portid: string, enabled: boolean): void {
    this.clockOutputPorts[portid] = enabled;
    console.log(
      `MIDI: Update clock output receiver ${portid}, ${enabled}`,
      this.clockOutputPorts
    );
  }
}

const clockMSG = Uint8Array.from([MIDI.MESSAGE.CLOCK]);
const startMSG = Uint8Array.from([MIDI.MESSAGE.START]);
const stopMSG = Uint8Array.from([MIDI.MESSAGE.STOP]);
const songPosStart = Uint8Array.from([MIDI.MESSAGE.SONG_POS, 0, 0]);

export default MIDI;
