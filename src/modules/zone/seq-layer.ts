/** MIDI clock resolution: pulses (ticks) per quarter note */
export const PPQ = 24;

export type DivTick = 192 | 144 | 96 | 72 | 64 | 48 | 36 | 32 | 24 | 18 | 16 | 12 | 9 | 8 | 6 | 4 | 3 | 2;

export const DIV_TICKS: DivTick[] = [
  192, // 2/1
  144, // 1/1.
  96, // 1/1
  72, // 1/2.
  64, // 1/1t
  48, // 1/2
  36, // 1/4.
  32, // 1/2t
  24, // 1/4
  18, // 1/8.
  16, // 1/4t
  12, // 1/8
  9, // 1/16.
  8, // 1/8t
  6, // 1/16
  4, // 1/16t
  3, // 1/32
  2 // 1/32t
];

/**
 * Swing delay in ms for a step (sequencer) or pattern position (arp): off-beat
 * positions (1, 3, 5...) are delayed by up to half a step, on-beats return 0.
 */
export function swingOffsetMs(index: number, swingAmount: number, stepTicks: number, tickIntervalMs: number): number {
  if (index % 2 === 0) return 0;
  return swingAmount * stepTicks * 0.5 * tickIntervalMs;
}
