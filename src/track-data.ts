// Sogn Motorsportklubb's drift track at Kaupangerskogen, Sogndal: a 1988 kart track turned drift track.
// Everything here is in pixels of the aerial photo it was traced from, unless noted. The centreline and widths
// were re-measured in 2026 against OpenStreetMap way 516158930 (© OpenStreetMap contributors, ODbL) and an aerial
// photo (Esri World Imagery); heights come from Kartverket's terrain model, in terrain-data.ts.

/** Metres per photo pixel, from fitting the trace to the OpenStreetMap track: a 477 m lap, as the club's "just under 500 m". */
export const METRES_PER_PX = 0.1695;
/**
 * Track widths are in photo pixels too: about 9 m, as a kart track, wider round the bottom hairpin where the asphalt
 * runs out to the wall. Taken from two surveys of the aerial photo and the median of the two with 9 m, as neither
 * survey is right everywhere (shade, gravel the colour of asphalt), then narrowed where a wall or building is close.
 */
export const WIDTH_PER_PX = METRES_PER_PX;
const PHOTO_W = 1170;
const PHOTO_H = 1743;

/** Ground map size in metres. */
export const MAP_W = PHOTO_W * METRES_PER_PX;
export const MAP_D = PHOTO_H * METRES_PER_PX;

/** World origin, measured from the photo's top left corner, in metres. */
export const ORIGIN_X = 430 * METRES_PER_PX;
export const ORIGIN_Z = 720 * METRES_PER_PX;

export const photoX = (px: number): number => px * METRES_PER_PX - ORIGIN_X;
export const photoZ = (py: number): number => py * METRES_PER_PX - ORIGIN_Z;

type PhotoPoint = readonly [x: number, y: number];

/** Centreline control points every 10 m, closed loop from the start line: [x, y, track width]. */
export const CENTRELINE: readonly (readonly [x: number, y: number, width: number])[] = [
  [366, 761, 53],
  [354, 817, 58],
  [349, 873, 58],
  [377, 926, 54],
  [405, 978, 54],
  [424, 1035, 54],
  [451, 1087, 52],
  [479, 1139, 49],
  [511, 1191, 53],
  [546, 1238, 56],
  [580, 1286, 56],
  [635, 1310, 56],
  [695, 1267, 56],
  [675, 1195, 56],
  [625, 1160, 55],
  [583, 1118, 62],
  [553, 1066, 68],
  [537, 1008, 60],
  [524, 951, 54],
  [500, 898, 53],
  [475, 844, 53],
  [476, 785, 53],
  [488, 727, 54],
  [503, 672, 53],
  [514, 615, 52],
  [506, 556, 53],
  [466, 512, 53],
  [420, 474, 50],
  [415, 416, 65],
  [435, 363, 68],
  [437, 302, 62],
  [427, 244, 45],
  [397, 201, 44],
  [360, 168, 44],
  [316, 139, 51],
  [263, 150, 53],
  [240, 202, 53],
  [237, 261, 53],
  [226, 319, 50],
  [208, 376, 44],
  [210, 439, 55],
  [260, 481, 61],
  [321, 483, 56],
  [372, 507, 42],
  [384, 562, 50],
  [382, 620, 53],
  [374, 679, 50],
  [370, 739, 50],
];

/** Kerbs, each traced as a short stroke; the side and exact range are worked out against the centreline. */
export const KERB_STROKES: readonly (readonly PhotoPoint[])[] = [
  [
    [255, 186],
    [276, 176],
    [300, 173],
  ],
  [
    [404, 238],
    [408, 265],
    [406, 292],
  ],
  [
    [462, 560],
    [490, 590],
    [505, 630],
    [510, 672],
  ],
  [
    [527, 868],
    [535, 900],
    [532, 932],
  ],
  [
    [399, 872],
    [402, 910],
    [406, 950],
  ],
  [
    [330, 548],
    [350, 553],
    [368, 566],
  ],
  [
    [545, 1188],
    [560, 1220],
    [573, 1250],
  ],
  [
    [238, 360],
    [235, 400],
    [237, 445],
  ],
];

export interface Barrier {
  /** Start and end, in metres along the lap from the start line. */
  from: number;
  to: number;
  /** -1 is the driver's right, 1 the left. The lap runs anticlockwise, so -1 is mostly the outside. */
  side: number;
  /** Distance outside the track edge, in metres. */
  off: number;
  kind: 'rail' | 'tyres' | 'concrete';
}

/**
 * Guardrails, concrete walls and tyre walls along the track edge, placed from the aerial photo and photos taken
 * at Kaupanger Driftweekend. Positions are good to a few metres.
 */
export const BARRIERS: readonly Barrier[] = [
  // Guardrail on the spectators' side, from the top loop down the long straight.
  { from: 405, to: 92, side: -1, off: 1.2, kind: 'rail' },
  // Tall concrete wall round the outside of the bottom hairpin.
  { from: 92, to: 140, side: -1, off: 1, kind: 'concrete' },
  // Guardrail round the tip of the island inside the hairpin.
  { from: 97, to: 125, side: 1, off: 1.2, kind: 'rail' },
  // Guardrails along the east edge, past the motocross track, and along the top.
  { from: 140, to: 245, side: -1, off: 1.2, kind: 'rail' },
  { from: 265, to: 318, side: -1, off: 1.2, kind: 'rail' },
  // Curved concrete wall round the outside of the top-left loop, with the forest behind.
  { from: 318, to: 398, side: -1, off: 1, kind: 'concrete' },
];

/** Walls between stretches of track that run side by side, as photo-pixel polylines. */
export const WALLS: readonly { kind: 'concrete' | 'tyres'; points: readonly PhotoPoint[] }[] = [
  // Down the grass strip between the long straight and the east side, to the hairpin.
  { kind: 'concrete', points: [[419, 785], [420, 810], [419, 833], [421, 854], [427, 871], [433, 888], [441, 905], [451, 928], [463, 956], [472, 986], [477, 1010], [482, 1033], [488, 1055], [495, 1074], [503, 1091], [512, 1109], [521, 1126], [534, 1143], [550, 1159], [567, 1177], [583, 1193], [595, 1209], [600, 1215]] },
  // Red and white belted tyres between the stretches that nearly touch at the top junction, down the middle
  // between them where they come within 15 m of each other.
  { kind: 'tyres', points: [[379, 476], [390, 486], [400, 500], [407, 514], [409, 521]] },
];

/** Spectator fences on the hillside behind the guardrail, as [from, to] metres along the lap, on the right. */
export const SPECTATOR_FENCES: readonly (readonly [from: number, to: number])[] = [[405, 80]];

/** The public road crossing the map. */
export const SIDE_ROAD: readonly PhotoPoint[] = [
  [520, 84],
  [760, 268],
  [930, 410],
  [1190, 620],
];

/** x, y, width m, depth m, rotation degrees, height m, wall colour, roof colour. */
export type Building = readonly [
  x: number,
  y: number,
  width: number,
  depth: number,
  rotation: number,
  height: number,
  wall: number,
  roof: number,
];

export const BUILDINGS: readonly Building[] = [
  [676, 540, 13, 9, -40, 5.2, 0x6d6a62, 0x2b2f33],
  [280, 722, 6, 10, -12, 3, 0xcfcac0, 0x8b8f92],
  // The hut by the start line, a metre further from the track than traced, to leave room for the guardrail.
  [327, 724, 2.6, 6.5, -8, 2.6, 0x6f7f8c, 0x5e6b75],
  [618, 585, 4, 6, -40, 3, 0x8a8478, 0x55524c],
  [930, 900, 2.5, 12, -14, 2.6, 0x9aa2a6, 0x7c8488],
  [410, 1360, 5, 5, 30, 3, 0x9a3a2a, 0x3a3634],
];

/** Where the start line sits along the centreline, in control points. */
export const START_LINE_CP = 0;

export const GROUND_COLOURS = { lot: '#7c7f83', road: '#606367', pave: '#9c9b96', grass: '#5d8a3a' };
export const EDGE_LINE_COLOUR = '#c9c7c0';

/** Canvas pixels per metre for the painted ground texture and the collision mask. */
export const PAINT_SCALE = 9;
export const MASK_SCALE = 4;
