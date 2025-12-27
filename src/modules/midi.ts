import internalClock = require('./internal-clock');

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
}

interface MIDIHandlers {
  completeHandler?: (available: boolean, msg: string) => void;
  updatePortsHandler?: (inputs: PortDescriptor[], outputs: PortDescriptor[], msg?: string) => void;
  eventHandler: (event: any) => void;
  clockHandler?: (pos: number) => void;
  transportHandler?: (started: boolean) => void;
  panicHandler?: () => void;
  updateClockReceiverHandler?: (outputs: PortDescriptor[]) => void;
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
  eventHandler: (event: any) => void;
  transportHandler?: (started: boolean) => void;
  updateClockReceiverHandler?: (outputs: PortDescriptor[]) => void;
  clockHandler?: (pos: number) => void;
  midiAccess: any = null;
  deviceIdInClock: string | null;
  deviceInClock: any = null;
  knownPorts: Record<string, any> = {};
  usedPorts: Set<string> = new Set();
  clockOutputPorts: Record<string, boolean> = {};
  selectedInputPorts: Record<string, InputPortDef> = {};
  outputPortsRegistered: PortDescriptor[] = [];
  songposition = 0;
  isClockRunning = false;
  hasClock = false;
  sendClockIfPlaying = false;

  constructor({
    completeHandler,
    updatePortsHandler,
    eventHandler,
    clockHandler,
    transportHandler,
    panicHandler,
    updateClockReceiverHandler
  }: MIDIHandlers) {
    console.log('MIDI: Initializing...');
    this.panicHandler = panicHandler;
    this.eventHandler = eventHandler;
    this.transportHandler = transportHandler;
    this.updateClockReceiverHandler = updateClockReceiverHandler;
    this.clockHandler = clockHandler;
    this.deviceIdInClock = localStorage.getItem('midiInClockId');

    setInterval(() => {
      this.hasClock = false;
    }, 1000);

    let trueReported = false;

    const reportStatus = (
      available: boolean,
      msg: string | undefined,
      inputPorts?: PortDescriptor[],
      outputPorts?: PortDescriptor[]
    ): void => {
      this.outputPortsRegistered = outputPorts || [];
      if ((available && !trueReported) || !available) {
        trueReported = available;
        if (completeHandler) {
          completeHandler(available, msg || '');
        }
        if (updatePortsHandler) {
          updatePortsHandler(inputPorts || [], outputPorts || [], msg);
        }
      } else {
        if (updatePortsHandler) {
          updatePortsHandler(inputPorts || [], outputPorts || [], msg);
        }
      }
    };

    const onMIDISuccess = (midiAccess: any): void => {
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

    const onMIDIFailure = (msg: any): void => {
      console.log('MIDI: Failed to get MIDI access - ' + msg);
      reportStatus(false, 'No MIDI available');
    };

    const onStateChange = (e: any): void => {
      const port = e.port;
      const state = e.port.state;
      const portName = e.port.name;
      if (state === 'disconnected') {
        delete this.knownPorts[port.id];
        const initResult = listInputsAndOutputs();
        reportStatus(
          initResult.success,
          `${portName} ${state}`,
          initResult.inputs,
          initResult.outputs
        );
        this.selectDevices(this.deviceIdInClock);
      } else if (state === 'connected') {
        if (!this.knownPorts[port.id]) {
          const initResult = listInputsAndOutputs();
          reportStatus(
            initResult.success,
            `${portName} ${state}`,
            initResult.inputs,
            initResult.outputs
          );
        }
        this.selectDevices(this.deviceIdInClock);
      }
    };

    const listInputsAndOutputs = (): ListResult => {
      let selectedIn: string | null = null;
      let selectedInClock: string | null = null;
      let countIn = 0;
      let countOut = 0;

      const sortPortsComparator = (a: [string, any], b: [string, any]): number => {
        const aUpper = ('' + a[1].name).toUpperCase();
        const bUpper = ('' + b[1].name).toUpperCase();
        if (aUpper < bUpper) {
          return -1;
        }
        if (bUpper < aUpper) {
          return 1;
        }
        return 0;
      };

      const sortedInputs = Array.from(this.midiAccess.inputs as Map<string, any>).sort(
        sortPortsComparator
      );
      sortedInputs.forEach((entry) => {
        const input = entry[1];
        this.knownPorts[input.id] = input;
        if (input.id == localStorage.getItem('midiInId')) {
          selectedIn = input.id;
        }
        if (input.id == localStorage.getItem('midiInClockId')) {
          selectedInClock = input.id;
        }
        countIn++;
      });

      const sortedOutputs = Array.from(this.midiAccess.outputs as Map<string, any>).sort(
        sortPortsComparator
      );
      sortedOutputs.forEach((entry) => {
        const output = entry[1];
        this.knownPorts[output.id] = output;
        countOut++;
      });
      console.log('MIDI: ', countIn, 'inputs,', countOut, 'outputs');
      this.deviceIdInClock = selectedInClock;

      const mapDescriptor = (port: [string, any]): PortDescriptor => {
        let sName = port[1].name;
        if (sName.length > 20) {
          sName =
            sName.substr(0, 20 / 2).trim() +
            '…' +
            sName.substr(sName.length - 20 / 2, 20 / 2).trim();
        }
        return {
          id: port[1].id,
          name: sName,
          fullName: port[1].name,
          isSelectedInput: port[1].id == selectedIn,
          isSelectedClockInput: port[1].id == selectedInClock
        };
      };

      const inputDescriptors = sortedInputs.map(mapDescriptor);
      const outputDescriptors = sortedOutputs.map(mapDescriptor);

      if (countIn == 0 || countOut == 0) {
        let message: string;
        if (countIn > 0 && countOut == 0) {
          message = 'No MIDI output devices';
        } else if (countIn == 0 && countOut > 0) {
          message = 'No MIDI input devices';
        } else {
          message = 'No MIDI devices';
        }
        return {
          success: true,
          message,
          inputs: inputDescriptors,
          outputs: outputDescriptors
        };
      } else {
        return {
          success: true,
          inputs: inputDescriptors,
          outputs: outputDescriptors
        };
      }
    };

    // go ahead, start midi
    if ('function' === typeof (window.navigator as any).requestMIDIAccess) {
      console.log('MIDI: System has MIDI support.');
      (navigator as any)
        .requestMIDIAccess({ sysex: true })
        .then(onMIDISuccess, onMIDIFailure);
    } else {
      console.log('MIDI: System has *no* MIDI support.');
      reportStatus(false, 'Sorry, browser has no MIDI support.');
    }
  }

  onMIDIMessage(event: any): void {
    const portId = event.srcElement
      ? event.srcElement.id
      : MIDI.INTERNAL_PORT_ID;
    const midiMessage = event.data[0];

    if (
      this.deviceIdInClock == portId &&
      (midiMessage === MIDI.MESSAGE.CLOCK ||
        midiMessage === MIDI.MESSAGE.START ||
        midiMessage === MIDI.MESSAGE.CONTINUE ||
        midiMessage === MIDI.MESSAGE.STOP)
    ) {
      if (midiMessage === MIDI.MESSAGE.CLOCK) {
        this.hasClock = true;
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
        for (const [portid, enabled] of Object.entries(this.clockOutputPorts)) {
          if (enabled) {
            this.send(event.data, portid);
          }
        }
      }

      if (
        this.isClockRunning &&
        this.clockHandler &&
        midiMessage === MIDI.MESSAGE.CLOCK
      ) {
        this.clockHandler(this.songposition);
        this.songposition++;
      }
    }

    const channel = event.data[0] & 0x0f;
    if (
      this.selectedInputPorts[portId] &&
      this.selectedInputPorts[portId].isSelected &&
      this.selectedInputPorts[portId].ch === channel
    ) {
      this.eventHandler(event);
    }
  }

  selectDevices(deviceIdInClock: string | null): void {
    console.log('MIDI: selectDevices(), inClock', deviceIdInClock);
    this.deviceIdInClock = deviceIdInClock;
    if (deviceIdInClock == MIDI.INTERNAL_PORT_ID) {
      internalClock.setHandler(this.onMIDIMessage.bind(this));
    } else {
      internalClock.setHandler(null as any);
    }
    this.midiAccess?.inputs.forEach((entry: any) => {
      entry.onmidimessage = undefined;
    });
    this.deviceInClock = this.midiAccess?.inputs.get(this.deviceIdInClock);
    if (this.deviceInClock) {
      this.deviceInClock.onmidimessage = this.onMIDIMessage.bind(this);
    }
    Object.values(this.selectedInputPorts).forEach((inputDef) => {
      if (inputDef.isSelected) {
        const deviceIn = this.midiAccess?.inputs.get(inputDef.id);
        if (deviceIn) {
          deviceIn.onmidimessage = this.onMIDIMessage.bind(this);
        }
      }
    });
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
   * Send MIDI message to given portId
   */
  send(msg: Uint8Array, portId: string): void {
    if (!portId || portId == MIDI.INTERNAL_PORT_ID) {
      // do nothing
    } else {
      const deviceOut = this.knownPorts[portId];
      if (deviceOut) {
        deviceOut.send(msg);
      }
    }
  }

  /**
   * Send MIDI message to all used ports.
   */
  sendToAllUsedPorts(msg: Uint8Array): void {
    this.usedPorts.forEach((portId) => {
      const deviceOut = this.knownPorts[portId];
      if (deviceOut) {
        deviceOut.send(msg);
      }
    });
  }

  sendToAllClockReceiverPorts(msg: Uint8Array): void {
    for (const [portid, enabled] of Object.entries(this.clockOutputPorts)) {
      if (enabled) {
        const deviceOut = this.knownPorts[portid];
        if (deviceOut) {
          deviceOut.send(msg);
        }
      }
    }
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
    const deviceOut = this.knownPorts[portId];
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
    console.log(
      'MIDI: Used ports updated. Used:',
      this.usedPorts,
      ', clock:',
      this.clockOutputPorts
    );
  }

  updateClockOutputReceiver(portid: string, enabled: boolean): void {
    this.clockOutputPorts[portid] = enabled;
    if (this.updateClockReceiverHandler) {
      this.updateClockReceiverHandler(this.outputPortsRegistered);
    }
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

function toHex(d: number, pad?: number): string {
  return ('0000' + Number(d).toString(16)).slice(pad ? -pad : -2).toUpperCase();
}

function toBinary(d: number, pad?: number): string {
  return ('0000000000000000' + Number(d).toString(2))
    .slice(pad ? -pad : -2)
    .toUpperCase();
}

export = MIDI;
