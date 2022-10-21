const internalClock = require('./internal-clock');

/**
 * Web MIDI interface handler
 */
class MIDI {
  static NOTENAMES = [
    'C',
    'C#',
    'D',
    'D#',
    'E',
    'F',
    'F#',
    'G',
    'G#',
    'A',
    'A#',
    'B'
  ];
  static MESSAGE = {
    NOTE_OFF: 0x80,
    NOTE_ON: 0x90,
    NOTE_PRESSURE: 0xa0,
    CONTROLLER: 0xb0,
    PGM_CHANGE: 0xc0,
    CHANNEL_PRESSURE: 0xd0,
    PITCH_BEND: 0xe0,
    SYSTEM_EXCLUSIVE: 0xf0,
    SONG_POS: 0xf2,
    SONG_SELECT: 0xf3,
    TUNE_REQUEST: 0xf6,
    CLOCK: 0xf8,
    START: 0xfa,
    CONTINUE: 0xfb,
    STOP: 0xfc
  };
  constructor({
    completeHandler,
    updatePortsHandler,
    eventHandler,
    clockHandler,
    transportHandler,
    panicHandler
  }) {
    console.log('MIDI: Initializing...');
    this.panicHandler = panicHandler;
    this.eventHandler = eventHandler;
    this.transportHandler = transportHandler;
    this.clockHandler = clockHandler;
    this.midiAccess = null;
    this.deviceIdIn = localStorage.getItem('midiInId');
    this.deviceIdInClock = localStorage.getItem('midiInClockId');
    this.knownPorts = {};
    this.usedPorts = new Set();
    this.clockOutputPorts = {};
    this.songposition = 0;
    this.isClockRunning = false;
    this.hasClock = false;
    setInterval(() => {
      this.hasClock = false;
    }, 1000);
    let trueReported = false;
    const reportStatus = (available, msg, inputPorts, outputPorts) => {
      if ((available && !trueReported) || !available) {
        trueReported = available;
        if (completeHandler) {
          completeHandler(available, msg);
        }
        if (updatePortsHandler) {
          updatePortsHandler(inputPorts, outputPorts);
        }
      } else {
        if (updatePortsHandler) {
          updatePortsHandler(inputPorts, outputPorts);
        }
      }
    };
    const onMIDISuccess = (midiAccess) => {
      console.log('MIDI: ready');
      this.midiAccess = midiAccess;
      const initResult = listInputsAndOutputs();
      this.selectDevices(this.deviceIdIn, this.deviceIdInClock);
      this.midiAccess.onstatechange = onStateChange;
      reportStatus(
        initResult.success,
        initResult.message,
        initResult.inputs,
        initResult.outputs
      );
    };
    const onMIDIFailure = (msg) => {
      console.log('MIDI: Failed to get MIDI access - ' + msg);
      reportStatus(false, 'No MIDI available');
    };
    const onStateChange = (e) => {
      const port = e.port;
      const state = e.port.state;
      if (state === 'disconnected') {
        delete this.knownPorts[port.id];
        const initResult = listInputsAndOutputs();
        reportStatus(
          initResult.success,
          initResult.message,
          initResult.inputs,
          initResult.outputs
        );
      } else if (state === 'connected') {
        if (!this.knownPorts[port.id]) {
          const initResult = listInputsAndOutputs();
          reportStatus(
            initResult.success,
            initResult.message,
            initResult.inputs,
            initResult.outputs
          );
        }
      }
    };
    const listInputsAndOutputs = () => {
      let selectedIn = null;
      let selectedInClock = null;
      let countIn = 0;
      let countOut = 0;

      const sortPortsComparator = (a, b) => {
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
      const sortedInputs = Array.from(this.midiAccess.inputs).sort(
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

      const sortedOutputs = Array.from(this.midiAccess.outputs).sort(
        sortPortsComparator
      );
      sortedOutputs.forEach((entry) => {
        const output = entry[1];
        this.knownPorts[output.id] = output;
        countOut++;
      });
      console.log('MIDI: ', countIn, 'inputs,', countOut, 'outputs');
      const mapDescriptor = (port) => {
        let sName = port[1].name;
        // let words = sName.split(' ');
        // if (words.length > 1) {
        //   for (let i = 0; i < words.length; i++) {
        //     if (words[i].length > 7) {
        //       words[i] = words[i].substr(0, 6) + '…';
        //     }
        //   }
        // }
        // sName = words.join(' ');
        if (sName.length > 20) {
          sName =
            sName.substr(0, 20 / 2) +
            '…' +
            sName.substr(sName.length - 20 / 2, 20 / 2);
        }
        return {
          id: port[1].id,
          name: sName, //`${port[1].name}`, //`${name}`,
          isSelectedInput: port[1].id == selectedIn,
          isSelectedClockInput: port[1].id == selectedInClock
        };
      };
      const inputDescriptors = sortedInputs.map(mapDescriptor);
      const outputDescriptors = sortedOutputs.map(mapDescriptor);
      if (countIn == 0 || countOut == 0) {
        let message;
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
    if ('function' === typeof window.navigator.requestMIDIAccess) {
      console.log('MIDI: System has MIDI support.');
      navigator
        .requestMIDIAccess({ sysex: true })
        .then(onMIDISuccess, onMIDIFailure);
    } else {
      console.log('MIDI: System has *no* MIDI support.');
      reportStatus(false, 'Sorry, browser has no MIDI support.');
    }
  }

  onMIDIMessage(event) {
    if (this.deviceInClock === this.deviceIn) {
      this.onMIDIClockMessage(event);
    }
    this.eventHandler(event);
  }

  onMIDIClockMessage(event) {
    if (event.data[0] === MIDI.MESSAGE.CLOCK) {
      this.hasClock = true;
    }
    if (
      this.isClockRunning &&
      this.clockHandler &&
      event.data[0] === MIDI.MESSAGE.CLOCK
    ) {
      this.clockHandler(this.songposition);
      this.songposition++;
    }
    if (event.data[0] === MIDI.MESSAGE.START) {
      // start
      this.isClockRunning = true;
      if (this.transportHandler) {
        this.transportHandler(true);
      }
    } else if (event.data[0] === MIDI.MESSAGE.STOP) {
      this.isClockRunning = false;
      this.songposition = 0;
      if (this.transportHandler) {
        this.transportHandler(false);
      }
    }
    if (
      event.data[0] === MIDI.MESSAGE.CLOCK ||
      event.data[0] === MIDI.MESSAGE.START ||
      event.data[0] === MIDI.MESSAGE.STOP
    ) {
      for (const [portid, enabled] of Object.entries(this.clockOutputPorts)) {
        if (enabled) {
          this.send(event.data, portid);
        }
      }
    }
  }

  selectDevices(deviceIdIn, deviceIdInClock) {
    this.deviceIdIn = deviceIdIn;
    this.deviceIdInClock = deviceIdInClock;
    this.deviceIn = this.midiAccess.inputs.get(this.deviceIdIn);
    this.deviceInClock = this.midiAccess.inputs.get(this.deviceIdInClock);
    if (this.deviceIn) {
      this.midiAccess.inputs.forEach((entry) => {
        entry.onmidimessage = undefined;
      });
      this.deviceIn.onmidimessage = this.onMIDIMessage.bind(this);
      if (this.deviceInClock) {
        if (this.deviceIn !== this.deviceInClock) {
          this.deviceInClock.onmidimessage = this.onMIDIClockMessage.bind(this);
        }
      }
    } else {
      console.log('MIDI: No input device selected!');
    }
  }

  /**
   * Send MIDI messages "all sound off" (0x78), "reset controllers" (0x79), "all notes off" (0x7b)
   * to all currently used ports on all 16 MIDI channels.
   */
  panic() {
    for (var i = 0; i < 16; i++) {
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
   * @param {Uint8Array} msg
   * @param {*} portId
   */
  send(msg, portId) {
    if (!portId || portId === '*') {
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
   * @param {Uint8Array} msg
   */
  sendToAllUsedPorts(msg) {
    this.usedPorts.forEach((portId) => {
      const deviceOut = this.knownPorts[portId];
      if (deviceOut) {
        deviceOut.send(msg);
      }
    });
  }

  /**
   * Send MIDI clock tick message (0xf8) to all used ports.
   */
  sendClock() {
    this.sendToAllUsedPorts(clockMSG);
  }

  /**
   * Send MIDI start message (0xfa) to all used ports.
   */
  sendStart() {
    this.sendToAllUsedPorts(startMSG);
  }

  /**
   * Send MIDI stop message (0xfc) and song position start (0xf2, 0, 0) to all used ports.
   */
  sendStop() {
    this.sendToAllUsedPorts(stopMSG);
    this.sendToAllUsedPorts(songPosStart);
  }

  /**
   * Send program change message (0xc0) to given port.
   * @param {*} portId
   * @param {Number} channel (0-based)
   * @param {Number} no Program number 0-127
   */
  sendProgramChange(portId, channel, no) {
    const deviceOut = this.knownPorts[portId];
    if (deviceOut) {
      deviceOut.send(Uint8Array.from([channel + MIDI.MESSAGE.PGM_CHANGE, no]));
    }
  }

  /**
   * Starts internal MIDI clock and sends MIDI start message
   * if MIDI controller's sendInternalClock is set to true.
   * @see MIDI.setSendClock
   */
  startClock() {
    if (this.deviceIdInClock === '*') {
      this.sendStart();
      internalClock.start(this.onMIDIClockMessage.bind(this));
    }
    this.songposition = 0;
    this.isClockRunning = true;
  }

  /**
   * Stops internal MIDI clock and send MIDI stop message
   * if MIDI controller's sendInternalClock is set to true.
   * @see MIDI.setSendClock
   */
  stopClock() {
    if (this.deviceIdInClock === '*') {
      this.sendStop();
      internalClock.stop();
    }
    this.isClockRunning = false;
  }

  setInternalBPM(v) {
    internalClock.setBPM(v);
  }

  /**
   * Update list of used ports. This list is used for
   * all "sendToAllPorts" methods.
   * @param {Set} set
   */
  updateUsedPorts(set) {
    this.usedPorts = set;
    console.log('MIDI: Used ports updated', this.usedPorts);
  }

  updateClockOutputReceiver(portid, enabled) {
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

function toHex(d, pad) {
  return ('0000' + Number(d).toString(16)).slice(pad ? -pad : -2).toUpperCase();
}
function toBinary(d, pad) {
  return ('0000000000000000' + Number(d).toString(2))
    .slice(pad ? -pad : -2)
    .toUpperCase();
}

module.exports = MIDI;
