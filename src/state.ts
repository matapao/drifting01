// Shared mutable state. Plain data only, so every other module can import it without cycles.
import { LAP_DIRECTION } from './track-data';

export type SurfaceKind = 'tarmac' | 'kerb' | 'gravel' | 'grass';
/** What the car can hit: the three kinds of barrier, a building, or the hillside and anything else solid. */
export type HitKind = 'rail' | 'concrete' | 'tyres' | 'building' | 'solid';

/** What the driver is asking for this frame, whatever the input device. */
export interface Controls {
  steer: number;
  gas: number;
  brake: number;
  hand: boolean;
  analog: boolean;
  assist: boolean;
}

export const controls: Controls = { steer: 0, gas: 0, brake: 0, hand: false, analog: false, assist: true };

export const car = {
  x: 0,
  z: 0,
  /** Heading; 0 faces +z. */
  th: 0,
  vx: 0,
  vz: 0,
  /** Yaw rate. */
  r: 0,
  /** Front wheel steer angle. */
  delta: 0,
  /** 1 to 5, or -1 for reverse. */
  gear: 1,
  rpm: 900,
  /** Throttle opening, 0 to 1, after the driver's foot and any gear change. */
  throttle: 0,
  /** Turbo pressure, 0 to 1. */
  boost: 0,
  /** Rear wheelspin, from 0 for none. */
  spin: 0,
  /** Wheel speeds in rad/s: front right, front left, and the locked rear axle. */
  omega: [0, 0, 0],
  /** Body-frame acceleration, smoothed. */
  axb: 0,
  ayb: 0,
  shiftT: 0,
  slipR: 0,
  slipF: 0,
  surf: ['tarmac', 'tarmac', 'tarmac', 'tarmac'] as SurfaceKind[],
  wheelRot: [0, 0, 0, 0],
  impact: 0,
  onKerb: 0,
  /** The rev limiter is cutting the fuel. */
  cut: false,
  /** How fast each contact patch slides over the ground, and its slip as a multiple of the slip of peak grip. */
  slide: [0, 0, 0, 0],
  slip: [0, 0, 0, 0],
  /** Load on each wheel. */
  load: [0, 0, 0, 0],
  /** Speed along a wall while rubbing it, easing to 0 after, and what the car last touched. */
  scrape: 0,
  hitKind: 'rail' as HitKind,
};

export const store = {
  get<T>(key: string, fallback: T): T {
    try {
      const raw = localStorage.getItem('drifting01.' + key);
      return raw == null ? fallback : (JSON.parse(raw) as T);
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown): void {
    try {
      localStorage.setItem('drifting01.' + key, JSON.stringify(value));
    } catch {
      // Storage can be unavailable; the game just forgets between visits.
    }
  },
};

/** Where a car's best lap or best score is kept: apart for each way round, as the times don't compare. */
export const recordKey = (kind: 'lap' | 'score', car: string): string =>
  `kaupanger.${LAP_DIRECTION < 0 ? 'clockwise.' : ''}${kind}.${car}`;

export const options = { assist: true, sound: true, shadows: true, color: 0, car: 'retro' };
Object.assign(options, store.get('opt', {}));

export const app = {
  mode: 'menu' as 'menu' | 'play',
  cam: store.get('cam', 0),
  started: false,
};

export interface Chain {
  pts: number;
  t: number;
  idle: number;
  mult: number;
}

export const game = {
  idx: 0,
  startIdx: 0,
  lapStart: null as number | null,
  lap: 1,
  sec: [false, false],
  best: store.get<number | null>(recordKey('lap', options.car), null),
  last: null as number | null,
  lapScore: 0,
  bestScore: store.get<number | null>(recordKey('score', options.car), null),
  chain: null as Chain | null,
  offT: 0,
  now: 0,
  lapValid: true,
  lat: 0,
  angle: 0,
};
