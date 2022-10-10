let audioContext = new AudioContext();
let tempo; //tempo in 24ppq
let scheduleAheadTime = 0.1; // How far ahead to schedule audio (sec)
let nextClockTime = 0.0; // when the next note is due.
let startTime = 0;
let beatCounter = 0; // Tracks beats in 24ppq, so up to 192 for 8 steps
let beatDiv = 8; // Divisons of the beat to play
let stepNum = 0; // Tracks current step (up to 8 steps by default)
let isRunning = false;

//schedules when the next clock should fire
const scheduleClock = function () {
  let currentTime = audioContext.currentTime;
  currentTime -= startTime;
  while (nextClockTime < currentTime + scheduleAheadTime) {
    setTimeout(function () {
      //send midi clock start only the first beat!
      //timeout needed to avoid quick first pulse
    }, currentTime + nextClockTime);
    advanceClock();
  }
  if (isRunning) {
    window.setTimeout(() => scheduleClock, 0);
  }
};

//move the clock forward by tempo intervals (24ppq)
function advanceClock() {
  //send midi clock signal
  console.log('clock', isRunning);
  //advance beat
  beatCounter++;
  if (beatCounter >= 192) {
    beatCounter = 0;
  }

  //calculate divisions per step
  if (beatCounter % beatDiv == 0) {
    stepNum++;
    if (stepNum >= 8) {
      stepNum = 0;
    }
  }
  //the next clock will be at the next tempo marker
  nextClockTime += tempo;
}

nextClockTime = 0;
tempo = 60 / 120 / 24; // defaults to 120bpm

function start() {
  console.log('Start');
  if (!isRunning) {
    isRunning = true;
    startTime = audioContext.currentTime + 0.005;
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
