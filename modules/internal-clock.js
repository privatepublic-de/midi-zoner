let audioContext = new AudioContext();
const clockMSG = { data: Uint8Array.from([0xf8]) };
let tempo; //tempo in 24ppq
let scheduleAheadTime = 0.1; // How far ahead to schedule audio (sec)
let nextClockTime = 0.0; // when the next note is due.
let startTime = 0;
let isRunning = false;
let tickHandler = null;

//schedules when the next clock should fire
const scheduleClock = function () {
  let currentTime = audioContext.currentTime;
  currentTime -= startTime;
  while (nextClockTime < currentTime + scheduleAheadTime) {
    advanceClock();
  }
  if (isRunning) {
    window.setTimeout(scheduleClock, 0);
  }
};

//move the clock forward by tempo intervals (24ppq)
function advanceClock() {
  tickHandler?.(clockMSG);
  nextClockTime += tempo;
}

nextClockTime = 0;
tempo = 60 / 120 / 24; // defaults to 120bpm

function start(clockHandler) {
  console.log('Start');
  if (!isRunning) {
    tickHandler = clockHandler;
    isRunning = true;
    startTime = audioContext.currentTime + 0.005;
    nextClockTime = 0.0;
    scheduleClock();
  }
}

function stop() {
  isRunning = false;
}

function setBPM(bpm) {
  tempo = 60 / bpm / 24;
}

module.exports = {
  start,
  stop,
  setBPM
};
