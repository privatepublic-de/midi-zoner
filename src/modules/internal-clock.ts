interface ClockMessage {
  data: Uint8Array;
}

type ClockHandler = (msg: ClockMessage) => void;

const audioContext = new AudioContext();
const clockMSG: ClockMessage = { data: Uint8Array.from([0xf8]) };
const startMSG: ClockMessage = { data: Uint8Array.from([0xfa]) };
const scheduleAheadTime = 0.1;
let tempo = 60 / 120 / 24; // defaults to 120bpm
let nextClockTime = 0.0; // when the next note is due.
let startTime = 0;
let tickHandler: ClockHandler | null = null;
let timerID: ReturnType<typeof setTimeout> | null = null;
// let hasStarted = false;

const scheduleClock = (): void => {
  let currentTime = audioContext.currentTime;
  currentTime -= startTime;
  while (nextClockTime < currentTime + scheduleAheadTime) {
    // if (hasStarted) {
    //   hasStarted = false;
    //   setTimeout(function () {
    //     tickHandler?.(startMSG);
    //     // tickHandler?.(clockMSG);
    //   }, currentTime + nextClockTime);
    // }
    tickHandler?.(clockMSG);
    nextClockTime += tempo;
  }
  timerID = setTimeout(scheduleClock, 0);
};

function setHandler(clockHandler: ClockHandler): void {
  // hasStarted = true;
  tickHandler = clockHandler;
  // startTime = audioContext.currentTime + 0.005;
  // nextClockTime = 0;
}

function start(clockHandler: ClockHandler): void {
  // hasStarted = true;
  tickHandler = clockHandler;
  // startTime = audioContext.currentTime + 0.005;
  // nextClockTime = 0;
}

function stop(): void {
  // tickHandler = null;
  // clearTimeout(timerID);
}

function setBPM(bpm: number): void {
  tempo = 60 / bpm / 24;
}

startTime = audioContext.currentTime + 0.005;
scheduleClock();

export = {
  setHandler,
  setBPM
};
