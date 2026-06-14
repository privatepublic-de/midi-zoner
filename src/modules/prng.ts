export function mulberry32(seed?: number): () => number {
  let s = seed !== undefined ? seed | 0 : (Date.now() ^ (Math.random() * 0xFFFFFFFF | 0));
  return function () {
    s = s + 0x6D2B79F5 | 0;
    let z = Math.imul(s ^ s >>> 15, 1 | s);
    z = z + Math.imul(z ^ z >>> 7, 61 | z) ^ z;
    return ((z ^ z >>> 14) >>> 0) / 4294967296;
  };
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
