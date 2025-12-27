declare module 'seedrandom' {
  interface PRNG {
    (): number;
    quick(): number;
    int32(): number;
    double(): number;
    state(): object;
  }

  function seedrandom(seed?: string, options?: { entropy?: boolean; global?: boolean; state?: object }): PRNG;
  export = seedrandom;
}
