/**
 * Lines for scripts/chords-check.mjs: traditional tunes (public domain melodies, written out
 * from memory, so some are approximations: what matters is the kind of line, its key, mode and
 * meter), a few exercises, and takes as played.
 *
 * A written tune: `bars` separated by |, each note "Name[octave]:beats" (a quarter = 1 beat in
 * every meter, octave 4 when left out), "r:beats" a rest. `pickup`: the first group is an
 * upbeat of that many beats (it ends where bar 1 starts). A played take: `notes` as
 * [tick, length, pitch, velocity] at 24 ticks a quarter, and its `length` in ticks.
 * `keys`: the keys a listener would accept (tonic and mode, as keyName() writes them).
 */
export const TUNES = [
  {
    name: 'Amazing Grace',
    meter: { n: 3, d: 4 },
    keys: ['G Ionian'],
    pickup: 1,
    bars: 'D:1 | G:2 B:0.5 G:0.5 | B:2 A:1 | G:2 E:1 | D:2 D:1 | G:2 B:0.5 G:0.5 | B:2 A:1 | D5:3 | D5:2 B:1 | D5:2 B:0.5 G:0.5 | B:2 A:1 | G:2 E:1 | D:2 D:1 | G:2 B:0.5 G:0.5 | B:2 A:1 | G:3 | r:3'
  },
  {
    name: 'Clementine (approx.)',
    meter: { n: 3, d: 4 },
    keys: ['C Ionian'],
    pickup: 1,
    bars: 'C:0.75 C:0.25 | C:1 G3:2 | E:0.75 E:0.25 E:1 C:1 | C:0.75 E:0.25 G:1.5 G:0.5 | F:0.75 E:0.25 D:2 | D:0.75 E:0.25 F:1.5 F:0.5 | E:0.75 D:0.25 E:1 C:1 | C:0.75 E:0.25 D:1.5 G3:0.5 | B3:0.75 D:0.25 C:2'
  },
  {
    name: 'Silent Night',
    meter: { n: 6, d: 8 },
    keys: ['C Ionian'],
    bars: 'G:1.5 A:0.5 G:1 | E:3 | G:1.5 A:0.5 G:1 | E:3 | D5:2 D5:1 | B:3 | C5:2 C5:1 | G:3 | A:2 A:1 | C5:1.5 B:0.5 A:1 | G:1.5 A:0.5 G:1 | E:3 | A:2 A:1 | C5:1.5 B:0.5 A:1 | G:1.5 A:0.5 G:1 | E:3 | D5:2 D5:1 | F5:1.5 D5:0.5 B:1 | C5:3 | E5:3 | C5:1 G:1 E:1 | G:1.5 F:0.5 D:1 | C:3 | r:3'
  },
  {
    name: 'Scarborough Fair (approx.)',
    meter: { n: 3, d: 4 },
    keys: ['D Dorian', 'D Aeolian'],
    bars: 'D:2 D:1 | A:2 A:1 | E:1.5 F:0.5 E:1 | D:3 | r:1 A:1 C5:1 | D5:2 C5:1 | A:1 B:1 G:1 | A:3 | r:2 D5:1 | D5:2 D5:1 | C5:2 A:1 | A:1 G:1 F:1 | E:1 C:2 | D:2 A:1 | G:1 F:1 E:1 | D:3'
  },
  {
    name: 'Drunken Sailor',
    meter: { n: 4, d: 4 },
    keys: ['D Dorian', 'D Aeolian'],
    bars: 'A:1 A:0.5 A:0.5 A:1 D:0.5 F:0.5 | G:1 G:0.5 G:0.5 G:1 C:0.5 E:0.5 | A:1 A:0.5 A:0.5 A:1 D:0.5 F:0.5 | C5:1 A:1 G:1 E:1 | D:2 D:2 | r:4 | A:1 A:0.5 A:0.5 A:1 D:0.5 F:0.5 | G:1 G:0.5 G:0.5 G:1 C:0.5 E:0.5 | A:1 A:0.5 A:0.5 A:1 B:0.5 C#5:0.5 | C5:1 A:1 G:1 E:1 | D:2 D:2 | r:4'
  },
  {
    name: 'Old Joe Clark (approx.)',
    meter: { n: 4, d: 4 },
    keys: ['A Mixolydian'],
    bars: 'E:0.5 E:0.5 E:0.5 F#:0.5 G:1 F#:0.5 E:0.5 | D:1 B3:1 B3:1 C#:0.5 D:0.5 | E:0.5 E:0.5 E:0.5 F#:0.5 G:1 A:1 | B:1 G:1 A:2 | C#5:1 C#5:1 C#5:0.5 B:0.5 A:1 | G:1 G:1 G:1 B:1 | C#5:1 C#5:1 C#5:0.5 B:0.5 A:1 | B:1 G:1 A:2'
  },
  {
    name: 'God Rest Ye Merry Gentlemen',
    meter: { n: 4, d: 4 },
    keys: ['E Aeolian', 'E Dorian'],
    bars: 'E:1 E:1 B:1 B:1 | A:1 G:1 F#:1 E:1 | D:1 E:1 F#:1 G:1 | A:1 B:3 | E:1 E:1 B:1 B:1 | A:1 G:1 F#:1 E:1 | D:1 E:1 F#:1 G:1 | A:1 B:3 | B:1 C5:1 A:1 B:1 | C5:1 D5:1 E5:1 B:1 | A:1 G:1 E:1 F#:1 | G:2 A:1 B:1 | C5:1 B:1 A:1 G:1 | F#:1 E:1 D:2 | E:1 A:1 G:1 A:1 | B:1 C5:1 B:1 A:1 | G:1 F#:1 E:2 | r:4'
  },
  {
    name: 'Joshua Fit the Battle (approx.)',
    meter: { n: 4, d: 4 },
    keys: ['D Aeolian', 'D Dorian'],
    bars: 'D:1 E:0.5 F:0.5 G:1 A:1 | A:1 G:0.5 F:0.5 A:2 | A:1 G:0.5 F:0.5 A:2 | A:1 G:0.5 F:0.5 E:2 | D:1 E:0.5 F:0.5 G:1 A:1 | A:1 G:0.5 F:0.5 A:1 F:1 | E:1 C#:1 D:1 E:1 | D:4'
  },
  {
    name: 'Frère Jacques',
    meter: { n: 4, d: 4 },
    keys: ['F Ionian'],
    bars: 'F:1 G:1 A:1 F:1 | F:1 G:1 A:1 F:1 | A:1 Bb:1 C5:2 | A:1 Bb:1 C5:2 | C5:0.5 D5:0.5 C5:0.5 Bb:0.5 A:1 F:1 | C5:0.5 D5:0.5 C5:0.5 Bb:0.5 A:1 F:1 | F:1 C:1 F:2 | F:1 C:1 F:2'
  },
  {
    name: 'When the Saints',
    meter: { n: 4, d: 4 },
    keys: ['C Ionian'],
    bars: 'C:1 E:1 F:1 G:1 | G:4 | r:1 C:1 E:1 F:1 | G:4 | r:1 C:1 E:1 F:1 | G:2 E:2 | C:2 E:2 | D:4 | r:1 E:1 E:1 D:1 | C:3 C:1 | E:2 G:2 | G:1 F:3 | r:1 E:1 F:1 G:1 | E:2 C:2 | D:2 C:2 | C:4'
  },
  {
    name: 'Auld Lang Syne',
    meter: { n: 4, d: 4 },
    keys: ['F Ionian'],
    pickup: 1,
    bars: 'C:1 | F:1.5 F:0.5 F:1 A:1 | G:1.5 F:0.5 G:1 A:1 | F:1.5 F:0.5 A:1 C5:1 | D5:3 D5:1 | C5:1.5 A:0.5 A:1 F:1 | G:1.5 F:0.5 G:1 A:1 | F:1.5 D:0.5 D:1 C:1 | F:3 r:1'
  },
  {
    name: 'Twinkle Twinkle',
    meter: { n: 4, d: 4 },
    keys: ['C Ionian'],
    bars: 'C:1 C:1 G:1 G:1 | A:1 A:1 G:2 | F:1 F:1 E:1 E:1 | D:1 D:1 C:2 | G:1 G:1 F:1 F:1 | E:1 E:1 D:2 | G:1 G:1 F:1 F:1 | E:1 E:1 D:2 | C:1 C:1 G:1 G:1 | A:1 A:1 G:2 | F:1 F:1 E:1 E:1 | D:1 D:1 C:2'
  },
  {
    name: '12-bar blues riff',
    meter: { n: 4, d: 4 },
    keys: ['C Mixolydian', 'C Dorian', 'C Ionian'],
    bars: 'C:1 E:0.5 G:0.5 A:0.5 Bb:0.5 A:0.5 G:0.5 | C:1 E:0.5 G:0.5 A:0.5 Bb:0.5 A:0.5 G:0.5 | C:1 E:0.5 G:0.5 A:0.5 Bb:0.5 A:0.5 G:0.5 | C:1 E:0.5 G:0.5 A:0.5 Bb:0.5 A:0.5 G:0.5 | F:1 A:0.5 C5:0.5 D5:0.5 Eb5:0.5 D5:0.5 C5:0.5 | F:1 A:0.5 C5:0.5 D5:0.5 Eb5:0.5 D5:0.5 C5:0.5 | C:1 E:0.5 G:0.5 A:0.5 Bb:0.5 A:0.5 G:0.5 | C:1 E:0.5 G:0.5 A:0.5 Bb:0.5 A:0.5 G:0.5 | G:1 B:0.5 D5:0.5 E5:0.5 F5:0.5 E5:0.5 D5:0.5 | F:1 A:0.5 C5:0.5 D5:0.5 Eb5:0.5 D5:0.5 C5:0.5 | C:1 E:0.5 G:0.5 A:0.5 Bb:0.5 A:0.5 G:0.5 | G:1 B:0.5 D5:0.5 F5:2'
  },
  {
    name: 'Exercise: chromatic neighbours',
    meter: { n: 4, d: 4 },
    keys: ['C Ionian'],
    bars: 'C5:1 B:0.5 C5:0.5 G:1 Ab:0.5 G:0.5 | E:1 D#:0.5 E:0.5 G:2 | F:1 E:0.5 F:0.5 A:1 G#:0.5 A:0.5 | G:1 F#:0.5 G:0.5 B:1 C5:1 | C5:1 B:0.5 C5:0.5 G:1 Ab:0.5 G:0.5 | E:1 D#:0.5 E:0.5 G:2 | D:1 C#:0.5 D:0.5 F:1 B3:1 | C:4'
  },
  {
    name: 'Exercise: neighbour tones in A minor',
    meter: { n: 4, d: 4 },
    keys: ['A Aeolian'],
    bars: 'A:0.5 G#:0.5 A:1 C5:1 E5:1 | E:0.5 D#:0.5 E:1 A:2 | A:0.5 G#:0.5 A:1 C5:1 B:1 | A:4 | E5:1 D5:1 C5:1 B:1 | C5:0.5 B:0.5 C5:1 A:2 | G#:1 B:1 E5:2 | A:4'
  },
  {
    name: 'Greensleeves (take, as played)',
    meter: { n: 4, d: 4 },
    keys: ['E Aeolian', 'E Dorian'],
    length: 33 * 96,
    // three beats in each 96-tick 4/4 bar, with rushed downbeats
    notes: [
      [72.0,26.5,64,69], [97.0,61.0,67,69], [156.0,25.0,69,69], [178.5,73.0,71,65], [251.0,15.0,72,45], [262.0,28.0,71,90], [288.0,64.0,66,53], [288.5,68.0,69,95],
      [352.0,31.0,66,90], [381.0,68.0,62,81], [447.0,21.5,64,81], [466.0,18.0,66,73], [481.5,61.0,67,69], [540.0,24.0,64,69], [567.0,70.0,64,73], [635.0,13.5,63,69],
      [646.5,25.5,64,90], [671.0,69.0,66,61], [671.0,78.0,63,57], [758.0,84.0,59,65], [841.0,24.0,64,95], [865.0,65.0,67,90], [928.0,23.0,69,90], [950.0,5.0,67,57],
      [954.0,67.0,71,90], [1021.0,15.0,72,81], [1031.0,26.0,71,95], [1056.0,63.0,66,69], [1056.0,54.0,69,81], [1127.5,16.0,64,53], [1141.5,74.0,62,69], [1214.0,21.0,64,65],
      [1233.5,19.0,66,65], [1250.0,50.0,67,65], [1295.5,24.0,66,57], [1317.5,26.0,64,73], [1341.0,40.5,63,65], [1379.5,34.0,61,73], [1411.0,29.0,63,48], [1439.0,83.0,64,73],
      [1525.0,104.0,64,73], [1632.5,78.0,71,18], [1632.5,78.0,74,81], [1633.0,84.0,67,57], [1726.5,34.5,71,18], [1727.5,34.0,67,69], [1728.0,41.0,74,95], [1764.0,30.5,73,81],
      [1792.0,32.0,71,73], [1822.0,64.0,69,73], [1884.0,28.0,66,53], [1911.0,70.0,62,69], [1981.0,21.5,64,69], [2000.0,18.0,66,53], [2016.5,58.0,67,65], [2077.0,7.0,64,65],
      [2099.0,63.0,64,65], [2161.5,15.0,63,73], [2175.0,26.0,64,61], [2208.0,78.0,63,48], [2208.0,67.0,66,57], [2293.0,106.0,59,73], [2400.0,30.0,71,18], [2400.0,31.0,74,73],
      [2400.5,36.0,67,69], [2439.0,7.5,67,65], [2439.0,7.0,71,18], [2440.0,8.0,74,69], [2461.5,9.0,71,18], [2462.0,8.5,74,95], [2463.0,9.0,67,65], [2485.5,9.0,71,18],
      [2485.5,10.5,74,95], [2486.0,28.5,67,90], [2508.5,10.0,74,90], [2531.0,8.5,74,81], [2542.0,23.5,73,81], [2565.0,27.0,71,69], [2591.0,52.0,69,81], [2640.0,25.0,66,95],
      [2664.0,14.5,64,65], [2677.0,74.0,62,48], [2749.0,22.0,64,65], [2768.0,17.0,66,57], [2783.5,66.0,67,69], [2845.0,21.0,66,90], [2865.0,19.5,64,73], [2880.0,39.0,63,69],
      [2918.0,31.5,61,95], [2949.5,26.0,63,57], [2976.0,77.0,64,90], [3060.0,69.0,64,95],
    ]
  }
];
