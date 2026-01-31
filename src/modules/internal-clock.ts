interface ClockMessage {
  data: Uint8Array;
  timestamp?: number;
}

type ClockHandler = (msg: ClockMessage) => void;

const audioContext = new AudioContext();
const clockMSG: ClockMessage = { data: Uint8Array.from([0xf8]) };
const scheduleAheadTime = 0.05; // 50ms lookahead
let tempo = 60 / 120 / 24; // defaults to 120bpm
let nextClockTime = 0.0; // when the next tick is due (relative to startTime)
let startTime = 0;
let tickHandler: ClockHandler | null = null;
let timerID: ReturnType<typeof setTimeout> | null = null;

const scheduleClock = (): void => {
  const currentTime = audioContext.currentTime - startTime;

  while (nextClockTime < currentTime + scheduleAheadTime) {
    // Calculate precise future timestamp (ms) for Web MIDI scheduling
    const offsetMs = (nextClockTime - currentTime) * 1000;
    const timestamp = performance.now() + Math.max(0, offsetMs);

    tickHandler?.({ data: clockMSG.data, timestamp });
    nextClockTime += tempo;
  }

  timerID = setTimeout(scheduleClock, 0);
};

function setHandler(clockHandler: ClockHandler | null): void {
  tickHandler = clockHandler;
}

function setBPM(bpm: number): void {
  tempo = 60 / bpm / 24;
}

startTime = audioContext.currentTime + 0.005;
scheduleClock();

export { setHandler, setBPM };
