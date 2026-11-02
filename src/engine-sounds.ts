// How each car sounds: its engine and exhaust as the synth builds them, and the turbo, gearbox and tune on top.
// Pipe lengths are typical of each engine's usual drift build, not measured from a particular car.

import type { EngineSpec } from './engine-synth';

export interface CarSound {
  engine: EngineSpec;
  turbo: null | {
    /** Compressor whistle from no boost to full boost, Hz; twin turbos whistle as a pair, slightly apart. */
    whistle: [low: number, high: number];
    twin: boolean;
    /** What the boost does when the throttle shuts: vents through a blow-off valve, or surges back and flutters. */
    lift: 'vent' | 'flutter';
    /** An external wastegate with its own screamer pipe. */
    screamer: boolean;
  };
  /** Straight-cut gears, which whine. */
  dogBox: boolean;
  /** Pops and bangs on the overrun and the limiter, 0 to 1: how rich and retarded the tune runs off throttle. */
  pops: number;
}

export const CAR_SOUNDS: Record<string, CarSound> = {
  // SR20DET-style turbo four on a big single turbo: equal-length tubular manifold into a 3-inch straight-through
  // exhaust, a blow-off valve vented to air and a wastegate screamer pipe; a tune that pops and bangs.
  retro: {
    engine: {
      firing: [1, 3, 4, 2],
      idle: 950,
      redline: 7500,
      evo: 118,
      ivc: 612,
      overlap: 52,
      primaries: [0.55, 0.57, 0.56, 0.55],
      groups: [[1, 2, 3, 4]],
      secondary: 0,
      turbo: { perGroup: false, keep: 0.5 },
      downpipe: 0.8,
      pipe: 2.1,
      muffler: { length: 0.45, ratio: 1.7, packing: 0.45 },
      tail: 0.35,
      intake: { runner: 0.22, itb: false, level: 0.35 },
      jitter: [0.12, 0.04],
      lope: 0.45,
      tick: 0.55,
    },
    turbo: { whistle: [1150, 4600], twin: false, lift: 'vent', screamer: true },
    dogBox: true,
    pops: 0.9,
  },
  // 20-valve 4A-GE: four individual throttle bodies with open trumpets, a 4-2-1 header and a free-flowing exhaust.
  // Revs to 8000 and rasps; the induction is as loud as the exhaust.
  ae86: {
    engine: {
      firing: [1, 3, 4, 2],
      idle: 950,
      redline: 8000,
      evo: 124,
      ivc: 604,
      overlap: 56,
      primaries: [0.78, 0.81, 0.82, 0.79],
      groups: [
        [1, 4],
        [2, 3],
      ],
      secondary: 0.46,
      downpipe: 0,
      pipe: 1.8,
      muffler: { length: 0.4, ratio: 2.1, packing: 0.35 },
      tail: 0.45,
      intake: { runner: 0.31, itb: true, level: 1.15 },
      jitter: [0.13, 0.035],
      lope: 0.35,
      tick: 0.8,
    },
    turbo: null,
    dogBox: false,
    pops: 0.45,
  },
  // RB26DETT: six throttle bodies behind the plenum, front and rear three cylinders each on their own turbo, into a
  // big single exhaust. Smooth and high-pitched; the turbos soften the exhaust and flutter when the throttle shuts.
  r32: {
    engine: {
      firing: [1, 5, 3, 6, 2, 4],
      idle: 950,
      redline: 8000,
      evo: 120,
      ivc: 610,
      overlap: 46,
      primaries: [0.36, 0.31, 0.38, 0.37, 0.3, 0.36],
      groups: [
        [1, 2, 3],
        [4, 5, 6],
      ],
      secondary: 0,
      turbo: { perGroup: true, keep: 0.55 },
      downpipe: 0.7,
      pipe: 2.4,
      muffler: { length: 0.5, ratio: 1.6, packing: 0.5 },
      tail: 0.4,
      intake: { runner: 0.2, itb: false, level: 0.25 },
      jitter: [0.08, 0.03],
      lope: 0.15,
      tick: 0.5,
    },
    turbo: { whistle: [2100, 7400], twin: true, lift: 'flutter', screamer: false },
    dogBox: false,
    pops: 0.5,
  },
  // S54: six individual throttle bodies in a carbon airbox, 6-into-2-into-1 headers, a straight-through exhaust.
  // A hard metallic howl at the top, intake honk in the cabin, crackles on the overrun.
  e30: {
    engine: {
      firing: [1, 5, 3, 6, 2, 4],
      idle: 900,
      redline: 8000,
      evo: 122,
      ivc: 606,
      overlap: 60,
      primaries: [0.52, 0.5, 0.53, 0.51, 0.49, 0.52],
      groups: [
        [1, 2, 3],
        [4, 5, 6],
      ],
      secondary: 0.55,
      downpipe: 0,
      pipe: 1.6,
      muffler: { length: 0.45, ratio: 2, packing: 0.4 },
      tail: 0.4,
      intake: { runner: 0.28, itb: true, level: 0.9 },
      jitter: [0.09, 0.03],
      lope: 0.25,
      tick: 0.6,
    },
    turbo: null,
    dogBox: false,
    pops: 0.6,
  },
};

export const carSound = (id: string): CarSound => CAR_SOUNDS[id] ?? CAR_SOUNDS.retro;
