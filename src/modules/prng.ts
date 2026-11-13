export function mulberry32(seed?: number): () => number {
  let s = seed !== undefined ? seed | 0 : (Date.now() ^ (Math.random() * 0xFFFFFFFF | 0));
  return function () {
    s = s + 0x6D2B79F5 | 0;
    let z = Math.imul(s ^ s >>> 15, 1 | s);
    z = z + Math.imul(z ^ z >>> 7, 61 | z) ^ z;
    return ((z ^ z >>> 14) >>> 0) / 4294967296;
  };
}

/** A random seed for hashRoll() */
export function randomSeed(): number {
  return (Math.random() * 0xffffffff) | 0;
}

/** A fixed number in [0, 1) for a seed and three integers: the same inputs, the same roll */
export function hashRoll(seed: number, a: number, b: number, c: number): number {
  let h = seed ^ Math.imul(a + 1, 0x9e3779b1) ^ Math.imul(b + 1, 0x85ebca77) ^ Math.imul(c + 2, 0xc2b2ae3d);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export class BagShuffle {
  private bag: number[] = [];
  private size = 0;
  private rng: () => number;

  constructor(rng: () => number) {
    this.rng = rng;
  }

  next(n: number): number {
    if (n !== this.size) {
      this.size = n;
      this.bag = [];
    }
    if (n === 0) return 0;
    if (this.bag.length === 0) {
      for (let i = 0; i < n; i++) this.bag.push(i);
      for (let i = n - 1; i > 0; i--) {
        const j = Math.floor(this.rng() * (i + 1));
        const tmp = this.bag[i];
        this.bag[i] = this.bag[j];
        this.bag[j] = tmp;
      }
    }
    return this.bag.pop()!;
  }
}
