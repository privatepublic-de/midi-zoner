const DOM = require('./domutils');
const MidiClock = require('./clock');

const MIDI_MESSAGE = {
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

/**
 * Web MIDI interface handler
 */
function MIDI({ completeHandler, eventHandler, clockHandler, panicHandler }) {
  console.log('MIDI: Initializing...');
  const self = this;
  self.panicHandler = panicHandler;
  self.sendInternalClock = false;
  self.midiAccess = null;
  self.deviceIdIn = null;
  self.deviceIdInClock = null;
  self.deviceIdOut = null;
  self.knownInputIds = {};
  self.knownOutputIds = {};
  self.songposition = 0;
  self.isInternalClockRunning = false;
  self.internalClock = MidiClock(() => {
    if (!self.deviceInClock && clockHandler) {
      if (self.isInternalClockRunning) {
        clockHandler(self.songposition);
      }
      if (self.sendInternalClock) {
        self.sendClock();
      }
      self.songposition++;
    }
  });
  let select_in = DOM.element('#midiInDeviceId');
  let select_in_clock = DOM.element('#midiClockInDeviceId');
  let select_out = DOM.element('#midiOutDeviceId');
  DOM.element('#midiPanic').addEventListener('click', () => {
    self.panic();
  });
  const optionNoDevice = '<option value="">(No devices)</option>';
  const knownPorts = {};

  let trueReported = false;

  const reportStatus = function(available, msg) {
    if (completeHandler) {
      if ((available && !trueReported) || !available) {
        trueReported = available;
        completeHandler(available, msg);
      }
    }
  };

  const onMIDISuccess = function(midiAccess) {
    console.log('MIDI ready!');
    self.midiAccess = midiAccess;
    const initResult = listInputsAndOutputs();
    selectDevices();
    self.midiAccess.onstatechange = onStateChange;
    reportStatus(initResult.success, initResult.message);
  };
  const onMIDIFailure = function(msg) {
    console.log('MIDI: Failed to get MIDI access - ' + msg);
    reportStatus(false, 'No MIDI available');
  };
  const onStateChange = function(e) {
    const port = e.port;
    const state = e.port.state;
    if (state === 'disconnected') {
      knownPorts[port.id] = false;
      const initResult = listInputsAndOutputs();
      selectDevices();
      reportStatus(initResult.success, initResult.message);
    } else if (state === 'connected') {
      if (!knownPorts[port.id]) {
        const initResult = listInputsAndOutputs();
        selectDevices();
        reportStatus(initResult.success, initResult.message);
      }
    }
  };
  const listInputsAndOutputs = function() {
    let selectedIn = null;
    let selectedInClock = null;
    let selectedOut = null;
    let countIn = 0;
    let countOut = 0;
    DOM.empty(select_in);
    for (let entry of self.midiAccess.inputs) {
      let input = entry[1];
      // if (!knownPorts[input.id]) {
      //   console.log(
      //     'MIDI: Input device',
      //     input.name,
      //     input.manufacturer,
      //     input.state
      //   );
      // }
      knownPorts[input.id] = true;
      if (input.id == localStorage.getItem('midiInId')) {
        selectedIn = input.id;
      }
      if (input.id == localStorage.getItem('midiInClockId')) {
        selectedInClock = input.id;
      }
      DOM.addHTML(
        select_in,
        'beforeend',
        `<option value="${input.id}">${input.name}</option>`
      );
      DOM.addHTML(
        select_in_clock,
        'beforeend',
        `<option value="${input.id}">${input.name}</option>`
      );
      countIn++;
    }
    DOM.empty(select_out);
    for (let entry of self.midiAccess.outputs) {
      let output = entry[1];
      // if (!knownPorts[output.id]) {
      //   console.log(
      //     'MIDI: Output device',
      //     output.name,
      //     output.manufacturer,
      //     output.state
      //   );
      // }
      knownPorts[output.id] = true;
      if (output.id == localStorage.getItem('midiOutId')) {
        selectedOut = output.id;
      }
      DOM.addHTML(
        select_out,
        'beforeend',
        `<option value="${output.id}">${output.name}</option>`
      );
      countOut++;
    }
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
    self.internalClock.start();
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
      return { success: true, message };
    } else {
      return { success: true };
    }
  };
  function onMIDIMessage(event) {
    eventHandler(event, self.deviceOut);
  }
  function onMIDIClockMessage(event) {
    if (clockHandler && event.data[0] === MIDI_MESSAGE.CLOCK) {
      clockHandler(self.songposition);
      self.songposition++;
    }
    if (event.data[0] === MIDI_MESSAGE.START) {
      // start
      self.songposition = 0;
    }
  }

  function selectDevices() {
    self.deviceIdIn = DOM.find(select_in, 'option:checked')[0].value;
    self.deviceIdInClock = DOM.find(select_in_clock, 'option:checked')[0].value;
    self.deviceIdOut = DOM.find(select_out, 'option:checked')[0].value;
    self.deviceIn = self.midiAccess.inputs.get(self.deviceIdIn);
    self.deviceInClock = self.midiAccess.inputs.get(self.deviceIdInClock);
    self.deviceOut = self.midiAccess.outputs.get(self.deviceIdOut);
    if (self.deviceIn) {
      self.midiAccess.inputs.forEach(function(entry) {
        entry.onmidimessage = undefined;
      });
      self.deviceIn.onmidimessage = onMIDIMessage;
      if (self.deviceInClock) {
        self.deviceInClock.onmidimessage = onMIDIClockMessage;
      }
    } else {
      console.log('MIDI: No input device selected!');
    }
  }
  // go ahead, start midi
  let list = [select_in, select_in_clock, select_out];
  list.forEach(function(el) {
    el.addEventListener('change', () => {
      selectDevices();
      localStorage.setItem('midiInId', self.deviceIdIn);
      localStorage.setItem('midiInClockId', self.deviceIdInClock);
      localStorage.setItem('midiOutId', self.deviceIdOut);
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
    DOM.all('#midisettings select', function(el) {
      el.disabled = 'disabled';
    });
  }
}

MIDI.prototype.hasOutput = function() {
  return typeof this.deviceOut !== 'undefined';
};

MIDI.prototype.hasInput = function() {
  return typeof this.deviceIn !== 'undefined';
};

MIDI.prototype.panic = function() {
  if (this.hasOutput()) {
    for (var i = 0; i < 16; i++) {
      const msg = new Uint8Array(3);
      msg[0] = MIDI_MESSAGE.CONTROLLER + i;
      msg[2] = 0;
      msg[1] = 120; // all sound off
      this.deviceOut.send(msg);
      msg[1] = 121; // reset controllers
      this.deviceOut.send(msg);
      msg[1] = 123; // all notes off
      this.deviceOut.send(msg);
    }
    console.log('MIDI: Panic. Sent CC 120, 122, 123 to all channels');
  }
  if (this.panicHandler) this.panicHandler();
};

MIDI.prototype.send = function(msg) {
  if (this.hasOutput()) {
    this.deviceOut.send(msg);
  }
};

const clockMSG = Uint8Array.from([MIDI_MESSAGE.CLOCK]);
const startMSG = Uint8Array.from([MIDI_MESSAGE.START]);
const stopMSG = Uint8Array.from([MIDI_MESSAGE.STOP]);
const songPosStart = Uint8Array.from([MIDI_MESSAGE.SONG_POS, 0, 0]);

MIDI.prototype.sendClock = function() {
  if (this.hasOutput()) {
    this.deviceOut.send(clockMSG);
  }
};

MIDI.prototype.sendStart = function() {
  if (this.hasOutput()) {
    this.deviceOut.send(startMSG);
  }
};

MIDI.prototype.sendStop = function() {
  if (this.hasOutput()) {
    this.deviceOut.send(stopMSG);
    this.deviceOut.send(songPosStart);
  }
};

MIDI.prototype.startClock = function(v) {
  this.songposition = 0;
  this.isInternalClockRunning = true;
  this.internalClock.start();
  if (this.sendInternalClock) {
    this.sendStart();
  }
};

MIDI.prototype.stopClock = function(v) {
  this.isInternalClockRunning = false;
  if (!this.deviceInClock) {
    // this.internalClock.stop();
  }
  if (this.sendInternalClock) {
    this.sendStop();
  }
};

MIDI.prototype.setSendClock = function(v) {
  this.sendInternalClock = v;
};

MIDI.prototype.setInternalClockTempo = function(bpm) {
  this.internalClock.setTempo(bpm);
};

function toHex(d, pad) {
  return ('0000' + Number(d).toString(16)).slice(pad ? -pad : -2).toUpperCase();
}
function toBinary(d, pad) {
  return ('0000000000000000' + Number(d).toString(2))
    .slice(pad ? -pad : -2)
    .toUpperCase();
}

module.exports.MIDI = MIDI;
module.exports.MIDI_MESSAGE = MIDI_MESSAGE;
