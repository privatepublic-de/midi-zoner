'use strict';

/**
 * DOM utilities
 */
let DOM = {
  /**
   * Returns first matching element for selector string or selector itself if it's no string.
   * @param {*} selector
   */
  element: function(selector) {
    if (typeof selector === 'string') {
      return document.querySelector(selector);
    } else {
      return selector;
    }
  },
  /**
   * Find elements within rootElement. Applies optional handler function for each element.
   * @param {object} rootElement
   * @param {string} selector
   * @param {function} handler
   */
  find: function(rootElement, selector, handler) {
    const list = rootElement.querySelectorAll(selector);
    if (handler) {
      for (let i = 0; i < list.length; i++) {
        handler(list[i]);
      }
    }
    return list;
  },
  /**
   * Returns list of all elements matching selector. Applies optional handler function for each element.
   * @param {*} selector
   * @param {function} handler
   */
  all: function(selector, handler) {
    let list = [];
    if (selector) {
      if (typeof selector === 'string') {
        list = document.querySelectorAll(selector);
      } else if (selector.tagName) {
        list = [selector];
      } else {
        list = selector.length ? Array.from(selector) : [selector];
      }
    }
    if (handler) {
      for (let i = 0; i < list.length; i++) {
        handler(list[i]);
      }
    }
    return list;
  },
  /**
   * Attaches event listener function to all elements matching selector.
   * @param {*} selector
   * @param {string} eventName
   * @param {function} handler
   */
  on: function(selector, eventName, handler) {
    DOM.all(selector, function(el) {
      el.addEventListener(eventName, handler);
    });
  },
  /**
   * Attaches event listener function to all elements matching selector only within rootElement.
   * @param {object} rootElement
   * @param {string} selector
   * @param {string} eventName
   * @param {function} handler
   */
  attachInside: function(rootElement, selector, eventName, handler) {
    DOM.find(rootElement, selector, function(el) {
      DOM.on(el, eventName, handler);
    });
  },
  /**
   * Clears content of all elements matching selector.
   * @param {*} selector
   */
  empty: function(selector) {
    DOM.all(selector, function(el) {
      while (el.firstChild) {
        el.removeChild(el.firstChild);
      }
    });
  },
  /**
   * Sets style.display = 'none' for all matching elements.
   * @param {*} selector
   */
  hide: function(selector) {
    DOM.all(selector, function(el) {
      el.style.display = 'none';
    });
  },
  /**
   * Sets style.display = 'block' for all matching elements.
   * @param {*} selector
   */
  show: function(selector) {
    DOM.all(selector, function(el) {
      el.style.display = 'block';
    });
  },
  /**
   * Removes style class 'visible' from all matching elements.
   * @param {*} selector
   */
  unvisible: function(selector) {
    DOM.removeClass(selector, 'visible');
  },
  /**
   * Adds style class 'visible' to all matching elements.
   * @param {*} selector
   */
  visible: function(selector) {
    DOM.addClass(selector, 'visible');
  },
  /**
   * Adds style class to all matching elements.
   * @param {*} selector
   * @param {string} className
   */
  addClass: function(selector, className) {
    DOM.all(selector, function(el) {
      el.classList.add(className);
    });
  },
  /**
   * Removes style class from all matching elements.
   * @param {*} selector
   * @param {string} className
   */
  removeClass: function(selector, className) {
    if (className) {
      DOM.all(selector, function(el) {
        el.classList.remove(className);
      });
    } else {
      DOM.all(selector, function(el) {
        el.className = '';
      });
    }
  },
  /**
   * Adds HTML to matching element at given position.
   * @param {*} selector
   * @param {string} position ['beforebegin', 'afterbegin', 'beforeend', 'afterend']
   * @param {string} html
   */
  addHTML: function(selector, position, html) {
    let element = DOM.element(selector);
    element.insertAdjacentHTML(position, html);
    return element;
  },
  /**
   * Returns attribute value of first element in parent chain containing this attribute.
   * @param {object} el
   * @param {string} attrname
   */
  ancestorAttribute: function(el, attrname) {
    let element = el;
    let attrValue = null;
    while (element && !(attrValue = element.getAttribute(attrname))) {
      element = element.parentElement;
    }
    return attrValue;
  }
};

/**
 * Web MIDI interface handler
 */
function MIDI(completeHandler, eventHandler, clockHandler) {
  console.log('MIDI: Initializing...');
  const self = this;
  self.midiAccess = null;
  self.deviceIdIn = null;
  self.deviceIdInClock = null;
  self.deviceIdOut = null;
  self.knownInputIds = {};
  self.knownOutputIds = {};
  self.songposition = 0;
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
    listInputsAndOutputs();
    selectDevices();
    self.midiAccess.onstatechange = onStateChange;
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
      listInputsAndOutputs();
      selectDevices();
    } else if (state === 'connected') {
      if (!knownPorts[port.id]) {
        listInputsAndOutputs();
        selectDevices();
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
      if (!knownPorts[input.id]) {
        console.log(
          'MIDI: Input device',
          input.name,
          input.manufacturer,
          input.state
        );
      }
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
      if (!knownPorts[output.id]) {
        console.log(
          'MIDI: Output device',
          output.name,
          output.manufacturer,
          output.state
        );
      }
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
      reportStatus(false, message);
    } else {
      reportStatus(true);
    }
  };
  function onMIDIMessage(event) {
    eventHandler(event, self.deviceOut);
  }
  function onMIDIClockMessage(event) {
    if (clockHandler && event.data[0] === 0xf8) {
      clockHandler(self.songposition);
      self.songposition++;
    }
    if (event.data[0] === 0xfa) {
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
      msg[0] = 0xb0 + i;
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
};

MIDI.prototype.send = function(msg) {
  if (this.hasOutput()) {
    this.deviceOut.send(msg);
  }
};

const clockMSG = Uint8Array.from([0xf8]);
const startMSG = Uint8Array.from([0xfa]);
const stopMSG = Uint8Array.from([0xfc]);

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
  }
};

function toHex(d, pad) {
  return ('0000' + Number(d).toString(16)).slice(pad ? -pad : -2).toUpperCase();
}
function toBinary(d, pad) {
  return ('0000000000000000' + Number(d).toString(2))
    .slice(pad ? -pad : -2)
    .toUpperCase();
}

function hslToRgb(h, s, l) {
  var r, g, b;

  if (s == 0) {
    r = g = b = l; // achromatic
  } else {
    var hue2rgb = function hue2rgb(p, q, t) {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };

    var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    var p = 2 * l - q;
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }

  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}
