const MidiClock = require('./clock');

/**
 * Web MIDI interface handler
 */
class MIDI {
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
    stoppedHandler,
    panicHandler
  }) {
    console.log('MIDI: Initializing...');
    this.panicHandler = panicHandler;
    this.eventHandler = eventHandler;
    this.stoppedHandler = stoppedHandler;
    this.clockHandler = clockHandler;
    this.sendInternalClock = false;
    this.midiAccess = null;
    this.deviceIdIn = localStorage.getItem('midiInId');
    this.deviceIdInClock = localStorage.getItem('midiInClockId');
    this.knownPorts = {};
    this.usedPorts = new Set();
    this.songposition = 0;
    this.isClockRunning = false;
    this.internalClock = MidiClock(() => {
      if (!this.deviceInClock && this.clockHandler) {
        if (this.sendInternalClock) {
          this.sendClock();
        }
        if (this.isClockRunning) {
          this.clockHandler(this.songposition);
        }
        this.songposition++;
      }
    });
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
        let input = entry[1];
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
        let output = entry[1];
        this.knownPorts[output.id] = output;
        countOut++;
      });
      console.log('MIDI: ', countIn, 'inputs,', countOut, 'outputs');
      const mapDescriptor = (port) => {
        return {
          id: port[1].id,
          name: `${port[1].name} (${port[1].manufacturer})`,
          isSelectedInput: port[1].id == selectedIn,
          isSelectedClockInput: port[1].id == selectedInClock
        };
      };
      const inputDescriptors = sortedInputs.map(mapDescriptor);
      const outputDescriptors = sortedOutputs.map(mapDescriptor);
      // this.internalClock.start();
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
    this.eventHandler(event);
  }

  onMIDIClockMessage(event) {
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
    } else if (event.data[0] === MIDI.MESSAGE.STOP) {
      this.isClockRunning = false;
      this.songposition = 0;
      if (stoppedHandler) {
        this.stoppedHandler();
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
        this.deviceInClock.onmidimessage = this.onMIDIClockMessage.bind(this);
        this.internalClock.stop();
      } else {
        // this.internalClock.start();
      }
    } else {
      console.log('MIDI: No input device selected!');
    }
  }

  hasInput() {
    return typeof this.deviceIn !== 'undefined';
  }
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
  send(msg, portId) {
    if (!portId || portId === '*') {
      // do nothing
    } else {
      const deviceOut = this.knownPorts[portId];
      if (deviceOut) {
        deviceOut.send(msg);
      } else {
        console.log('MIDI: Unknown output port', portId);
      }
    }
  }
  sendToAllUsedPorts(msg) {
    this.usedPorts.forEach((portId) => {
      const deviceOut = this.knownPorts[portId];
      if (deviceOut) {
        deviceOut.send(msg);
      }
    });
  }
  sendClock() {
    this.sendToAllUsedPorts(clockMSG);
  }
  sendStart() {
    this.sendToAllUsedPorts(startMSG);
  }
  sendStop() {
    this.sendToAllUsedPorts(stopMSG);
    this.sendToAllUsedPorts(songPosStart);
  }
  sendProgramChange(portId, channel, no) {
    const deviceOut = this.knownPorts[portId];
    if (deviceOut) {
      deviceOut.send(Uint8Array.from([channel + MIDI.MESSAGE.PGM_CHANGE, no]));
    }
  }
  startClock(v) {
    this.songposition = 0;
    this.isClockRunning = true;
    this.internalClock.start();
    if (this.sendInternalClock) {
      this.sendStart();
    }
  }
  stopClock(v) {
    this.isClockRunning = false;
    if (!this.deviceInClock) {
      this.internalClock.stop();
    }
    if (this.sendInternalClock) {
      this.sendStop();
    }
  }
  setSendClock(v) {
    this.sendInternalClock = v;
  }
  setInternalClockTempo(bpm) {
    this.internalClock.setTempo(bpm);
  }
  updateUsedPorts(set) {
    this.usedPorts = set;
    console.log('MIDI: Used ports updated', this.usedPorts);
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
