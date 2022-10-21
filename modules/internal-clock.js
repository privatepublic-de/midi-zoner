const audioContext = new AudioContext();
const clockMSG = { data: Uint8Array.from([0xf8]) };
const startMSG = { data: Uint8Array.from([0xfa]) };
const scheduleAheadTime = 0.1;
let tempo = 60 / 120 / 24; // defaults to 120bpm
let nextClockTime = 0.0; // when the next note is due.
let startTime = 0;
let tickHandler = null;
let timerID = null;
let hasStarted = false;

const scheduleClock = function () {
  let currentTime = audioContext.currentTime;
  currentTime -= startTime;
  while (nextClockTime < currentTime + scheduleAheadTime) {
    if (hasStarted) {
      hasStarted = false;
      setTimeout(function () {
        tickHandler?.(startMSG);
        tickHandler?.(clockMSG);
      }, currentTime + nextClockTime);
    }
    advanceClock();
  }
  timerID = setTimeout(scheduleClock, 0);
};

function advanceClock() {
  tickHandler?.(clockMSG);
  nextClockTime += tempo;
}

function start(clockHandler) {
  hasStarted = true;
  tickHandler = clockHandler;
  isRunning = true;
  startTime = audioContext.currentTime + 0.005;
  nextClockTime = 0;
  scheduleClock();
}

function stop() {
  tickHandler = null;
  clearTimeout(timerID);
}

function setBPM(bpm) {
  tempo = 60 / bpm / 24;
}

module.exports = {
  start,
  stop,
  setBPM
};
