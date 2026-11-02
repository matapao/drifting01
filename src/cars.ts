// The cars in the picker: engine, weight and gearing for each, and where its model came from.
// Body sizes, wheelbase, track and tyre size are not listed here: they come from each car's model.

/**
 * The packed model cars. Their licences allow them only inside the game, so they're left out of the public
 * source; a checkout without them offers the Pro-am car alone.
 */
const PACKED = import.meta.glob<string>('./assets/cars/*.car', { query: '?url', import: 'default', eager: true });
const packedModel = (id: string): string | null => PACKED[`./assets/cars/${id}.car`] ?? null;

export interface CarSpec {
  id: string;
  name: string;
  blurb: string;
  /** Packed model, or null for the textured retro car. */
  model: string | null;
  /** Mass with driver. */
  m: number;
  /** Share of the weight on the front wheels. */
  frontShare: number;
  /** Centre of mass height. */
  H: number;
  gears: number[];
  final: number;
  rev: number;
  redline: number;
  /** Engine torque in Nm by rpm, at full boost for a turbo engine. */
  torque: [rpm: number, nm: number][];
  turbo: boolean;
  power: string;
  /** Where the model came from. */
  credit: { title: string; author: string; url: string; licence: string };
}

const ALL_CARS: CarSpec[] = [
  {
    id: 'retro',
    name: 'Pro-am',
    blurb: 'A typical pro-am build: turbo, locked diff, 450 hp.',
    model: null,
    m: 1250,
    frontShare: 0.52,
    H: 0.48,
    // A 240SX five-speed; its 4.08 final drive on 205/55R16 tyres gears the same as 3.7 on these smaller ones.
    gears: [3.32, 1.9, 1.31, 1, 0.76],
    final: 3.7,
    rev: 3.38,
    redline: 7500,
    torque: [
      [1000, 200],
      [2000, 320],
      [3000, 470],
      [4000, 550],
      [4500, 560],
      [5500, 540],
      [6800, 470],
      [7500, 420],
    ],
    turbo: true,
    power: '450 hp',
    credit: {
      title: 'Retro Car With Interior (PSX asset)',
      author: 'Bricchi Games',
      url: 'https://bricchi-games.itch.io/retro-car-with-interior',
      licence: 'CC BY 4.0',
    },
  },
  {
    id: 'ae86',
    name: 'AE86',
    blurb: 'Light and short of power: carry speed and use the handbrake.',
    model: packedModel('ae86'),
    // A Trueno GT-Apex with the 20-valve 4A-GE swap: 165 hp at 7800 rpm.
    m: 960,
    frontShare: 0.53,
    H: 0.47,
    gears: [3.587, 2.022, 1.384, 1, 0.861],
    final: 4.3,
    rev: 3.484,
    redline: 8000,
    torque: [
      [1000, 95],
      [2000, 118],
      [3000, 132],
      [4000, 145],
      [5000, 157],
      [5600, 162],
      [6500, 158],
      [7800, 148],
      [8200, 128],
    ],
    turbo: false,
    power: '165 hp',
    credit: {
      title: '1986 Toyota Sprinter Trueno AE86 From Initial D',
      author: 'raddysa71arxi',
      url: 'https://www.cgtrader.com/free-3d-models/car/antique-car/1986-toyota-sprinter-trueno-ae86-from-initial-d',
      licence: 'CGTrader Royalty Free (no AI)',
    },
  },
  {
    id: 'r32',
    name: 'R32',
    blurb: 'Big twin-turbo six, converted to rear drive like most drift R32s.',
    model: packedModel('r32'),
    // An RB26 on bigger turbos, about 500 hp, with the four-wheel drive taken out.
    m: 1380,
    frontShare: 0.57,
    H: 0.5,
    gears: [3.214, 1.925, 1.302, 1, 0.752],
    final: 4.111,
    rev: 3.369,
    redline: 8000,
    torque: [
      [1000, 200],
      [2000, 330],
      [3000, 480],
      [4000, 560],
      [4500, 570],
      [5500, 560],
      [7000, 502],
      [7800, 440],
    ],
    turbo: true,
    power: '500 hp',
    credit: {
      title: 'Nissan Skyline R32 GTR',
      author: '13lue',
      url: 'https://www.cgtrader.com/free-3d-models/car/sport-car/nissan-skyline-r32-gtr-d4a3090d-61b3-4e1b-881b-9008ea7b7880',
      licence: 'CGTrader Royalty Free (no AI)',
    },
  },
  {
    id: 'e30',
    name: 'E30',
    blurb: 'Revvy straight-six swap, no turbo: keep it near the limiter.',
    model: packedModel('e30'),
    // An M3 shell with the later M3's S54 six: 343 hp at 7900 rpm, about 1,200 kg.
    m: 1200,
    frontShare: 0.51,
    H: 0.48,
    gears: [3.83, 2.2, 1.4, 1, 0.81],
    final: 3.91,
    rev: 3.46,
    redline: 8000,
    torque: [
      [1000, 170],
      [2000, 250],
      [3000, 300],
      [4000, 340],
      [4900, 365],
      [6000, 355],
      [7000, 335],
      [7900, 308],
      [8200, 280],
    ],
    turbo: false,
    power: '340 hp',
    credit: {
      title: 'M3 e30',
      author: 'fadhilelouali6',
      url: 'https://www.cgtrader.com/3d-models/car/sport-car/m3-e30',
      licence: 'CGTrader Royalty Free',
    },
  },
];

/** The cars this build can show: the Pro-am always, the model cars when their files are here. */
export const CARS: CarSpec[] = ALL_CARS.filter((spec) => spec.id === 'retro' || spec.model);

export const carById = (id: string): CarSpec => CARS.find((car) => car.id === id) ?? CARS[0];

/** A car's body as the physics needs it, measured from its model. Lengths along the car are from its model origin. */
export interface CarShape {
  frontAxle: number;
  rearAxle: number;
  /** Half the track. */
  halfTrack: number;
  RW: number;
  width: number;
  nose: number;
  tail: number;
  length: number;
}

/** The retro car model, measured at its 4.73 m length. */
export const RETRO_SHAPE: CarShape = {
  frontAxle: 1.281,
  rearAxle: -1.123,
  halfTrack: 0.709,
  RW: 0.289,
  width: 1.709,
  nose: 2.365,
  tail: -2.365,
  length: 4.73,
};
