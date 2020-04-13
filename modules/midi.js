const DOM = require('./domutils');
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
    this.sendInternalClock = false;
    this.midiAccess = null;
    this.deviceIdIn = null;
    this.deviceIdInClock = null;
    this.deviceIdOut = null;
    this.knownPorts = {};
    this.usedPorts = new Set();
    this.songposition = 0;
    this.isClockRunning = false;
    this.internalClock = MidiClock(() => {
      if (!this.deviceInClock && clockHandler) {
        if (this.sendInternalClock) {
          this.sendClock();
        }
        if (this.isClockRunning) {
          clockHandler(this.songposition);
        }
        this.songposition++;
      }
    });
    const select_in = DOM.element('#midiInDeviceId');
    const select_in_clock = DOM.element('#midiClockInDeviceId');
    const select_out = DOM.element('#midiOutDeviceId');
    DOM.element('#midiPanic').addEventListener('click', () => {
      this.panic();
    });
    const optionNoDevice = '<option value="">(No devices)</option>';
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
      selectDevices();
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
        selectDevices();
        reportStatus(
          initResult.success,
          initResult.message,
          initResult.inputs,
          initResult.outputs
        );
      } else if (state === 'connected') {
        if (!this.knownPorts[port.id]) {
          const initResult = listInputsAndOutputs();
          selectDevices();
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
      let selectedOut = null;
      let countIn = 0;
      let countOut = 0;
      DOM.empty(select_in);
      DOM.empty(select_in_clock);
      DOM.addHTML(
        select_in_clock,
        'beforeend',
        '<option value="*INTERNAL*">INTERNAL</option>'
      );
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
        if (!this.knownPorts[input.id]) {
          console.log(
            'MIDI: in :',
            input.name,
            input.manufacturer,
            input.version
          );
        }
        this.knownPorts[input.id] = input;
        if (input.id == localStorage.getItem('midiInId')) {
          selectedIn = input.id;
        }
        if (input.id == localStorage.getItem('midiInClockId')) {
          selectedInClock = input.id;
        }
        DOM.addHTML(
          select_in,
          'beforeend',
          `<option value="${input.id}">${input.name} (${input.manufacturer})</option>`
        );
        DOM.addHTML(
          select_in_clock,
          'beforeend',
          `<option value="${input.id}">${input.name} (${input.manufacturer})</option>`
        );
        countIn++;
      });

      DOM.empty(select_out);
      const sortedOutputs = Array.from(this.midiAccess.outputs).sort(
        sortPortsComparator
      );
      sortedOutputs.forEach((entry) => {
        let output = entry[1];
        if (!this.knownPorts[output.id]) {
          console.log(
            'MIDI: out:',
            output.name,
            output.manufacturer,
            output.version
          );
        }
        this.knownPorts[output.id] = output;
        if (output.id == localStorage.getItem('midiOutId')) {
          selectedOut = output.id;
        }
        DOM.addHTML(
          select_out,
          'beforeend',
          `<option value="${output.id}">${output.name} (${output.manufacturer})</option>`
        );
        countOut++;
      });
      if (selectedIn) {
        select_in.value = selectedIn;
      }
      if (selectedOut) {
        select_out.value = selectedOut;
      }
      if (selectedInClock) {
        select_in_clock.value = selectedInClock;
      }
      console.log('MIDI: ', countIn, 'inputs,', countOut, 'outputs');
      const mapDescriptor = (port) => {
        return {
          id: port[1].id,
          name: `${port[1].name} (${port[1].manufacturer})`,
          isDefault: port[1].id == selectedIn || port[1].id == selectedOut
        };
      };
      const inputDescriptors = sortedInputs.map(mapDescriptor);
      const outputDescriptors = sortedOutputs.map(mapDescriptor);
      // this.internalClock.start();
      if (countIn == 0 || countOut == 0) {
        let message;
        if (countIn > 0 && countOut == 0) {
          message = 'No MIDI output devices';
          DOM.addHTML(select_out, 'beforeend', optionNoDevice);
        } else if (countIn == 0 && countOut > 0) {
          message = 'No MIDI input devices';
          DOM.addHTML(select_in, 'beforeend', optionNoDevice);
        } else {
          message = 'No MIDI devices';
          DOM.addHTML(select_out, 'beforeend', optionNoDevice);
          DOM.addHTML(select_in, 'beforeend', optionNoDevice);
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
    const onMIDIMessage = (event) => {
      eventHandler(event, this.deviceOut);
    };
    const onMIDIClockMessage = (event) => {
      if (
        this.isClockRunning &&
        clockHandler &&
        event.data[0] === MIDI.MESSAGE.CLOCK
      ) {
        clockHandler(this.songposition);
        this.songposition++;
      }
      if (event.data[0] === MIDI.MESSAGE.START) {
        // start
        this.isClockRunning = true;
      } else if (event.data[0] === MIDI.MESSAGE.STOP) {
        this.isClockRunning = false;
        this.songposition = 0;
        if (stoppedHandler) {
          stoppedHandler();
        }
      }
    };
    const selectDevices = () => {
      this.deviceIdIn = DOM.find(select_in, 'option:checked')[0].value;
      this.deviceIdInClock = DOM.find(
        select_in_clock,
        'option:checked'
      )[0].value;
      this.deviceIdOut = DOM.find(select_out, 'option:checked')[0].value;
      this.deviceIn = this.midiAccess.inputs.get(this.deviceIdIn);
      this.deviceInClock = this.midiAccess.inputs.get(this.deviceIdInClock);
      this.deviceOut = this.midiAccess.outputs.get(this.deviceIdOut);
      if (this.deviceIn) {
        this.midiAccess.inputs.forEach((entry) => {
          entry.onmidimessage = undefined;
        });
        this.deviceIn.onmidimessage = onMIDIMessage;
        if (this.deviceInClock) {
          this.deviceInClock.onmidimessage = onMIDIClockMessage;
          this.internalClock.stop();
        } else {
          // this.internalClock.start();
        }
      } else {
        console.log('MIDI: No input device selected!');
      }
    };
    // go ahead, start midi
    const list = [select_in, select_in_clock, select_out];
    list.forEach((el) => {
      el.addEventListener('change', () => {
        selectDevices();
        localStorage.setItem('midiInId', this.deviceIdIn);
        localStorage.setItem('midiInClockId', this.deviceIdInClock);
        localStorage.setItem('midiOutId', this.deviceIdOut);
      });
    });
    if ('function' === typeof window.navigator.requestMIDIAccess) {
      console.log('MIDI: System has MIDI support.');
      navigator
        .requestMIDIAccess({ sysex: true })
        .then(onMIDISuccess, onMIDIFailure);
    } else {
      console.log('MIDI: System has *no* MIDI support.');
      reportStatus(false, 'Sorry, browser has no MIDI support.');
      DOM.addClass('#midisettings', 'unsupported');
      DOM.all('#midisettings select', function (el) {
        el.disabled = 'disabled';
      });
    }
  }
  hasOutput() {
    return typeof this.deviceOut !== 'undefined';
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
      if (this.hasOutput()) {
        this.deviceOut.send(msg);
      }
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
      const deviceOut =
        portId == '*' ? this.deviceOut : this.knownPorts[portId];
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
