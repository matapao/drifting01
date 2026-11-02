// Ground height over the map. The hillside comes from the samples in terrain-data.ts; the track itself is graded
// like a real one: a smooth profile along it, level across it, blending into the hillside past the edges.
// Plain data, so physics can use it too.

import { clamp, lerp } from './math';
import { TERRAIN_COLS, TERRAIN_DM, TERRAIN_ROWS, TERRAIN_STEP_PX } from './terrain-data';
import { track } from './track';
import { MAP_D, MAP_W, METRES_PER_PX, ORIGIN_X, ORIGIN_Z } from './track-data';

/** Spacing of the terrain samples in metres. */
const STEP = TERRAIN_STEP_PX * METRES_PER_PX;
const sample = (col: number, row: number) => TERRAIN_DM[row * TERRAIN_COLS + col] / 10;

/** The natural ground, bilinear between samples. Past the map it keeps the edge height. */
function hillsideAt(x: number, z: number): number {
  const fx = clamp((x + ORIGIN_X) / STEP, 0, TERRAIN_COLS - 1.0001);
  const fz = clamp((z + ORIGIN_Z) / STEP, 0, TERRAIN_ROWS - 1.0001);
  const col = Math.floor(fx);
  const row = Math.floor(fz);
  const tx = fx - col;
  const tz = fz - row;
  const top = sample(col, row) + (sample(col + 1, row) - sample(col, row)) * tx;
  const bottom = sample(col, row + 1) + (sample(col + 1, row + 1) - sample(col, row + 1)) * tx;
  return top + (bottom - top) * tz;
}

/** Metres between the graded heights, which are worked out once for the whole map. */
const CELL = 1;
const COLS = Math.ceil(MAP_W / CELL) + 1;
const ROWS = Math.ceil(MAP_D / CELL) + 1;
/** Past the asphalt edge, the ground is the track's height for `SHOULDER` metres, then blends to the hillside. */
const SHOULDER = 1;
const BLEND = 6;
/** The track's profile is smoothed over about this many metres either side. */
const PROFILE_SMOOTHING = 8;

const graded = gradeTrack();

function gradeTrack(): Float32Array {
  const { N, X, Z, HW } = track;
  const step = track.length / N;

  // A smooth profile along the track, as a road is built: no bumps from the terrain samples or the banks beside it.
  const raw = Array.from({ length: N }, (_, i) => hillsideAt(X[i], Z[i]));
  const span = Math.round(PROFILE_SMOOTHING / step);
  const profile = raw.map((_, i) => {
    let sum = 0;
    let weights = 0;
    for (let k = -span; k <= span; k++) {
      const w = Math.exp(-((k / span) ** 2) * 2);
      sum += raw[(i + k + N) % N] * w;
      weights += w;
    }
    return sum / weights;
  });

  // Each cell takes a weighted blend of the profile heights of nearby stations, so where two stretches run side
  // by side the ground between them ramps from one to the other rather than stepping.
  const sum = new Float32Array(COLS * ROWS);
  const weight = new Float32Array(COLS * ROWS);
  const edge = new Float32Array(COLS * ROWS).fill(Infinity);
  for (let i = 0; i < N; i++) {
    const reach = HW[i] + SHOULDER + BLEND;
    const c0 = Math.max(0, Math.floor((X[i] + ORIGIN_X - reach) / CELL));
    const c1 = Math.min(COLS - 1, Math.ceil((X[i] + ORIGIN_X + reach) / CELL));
    const r0 = Math.max(0, Math.floor((Z[i] + ORIGIN_Z - reach) / CELL));
    const r1 = Math.min(ROWS - 1, Math.ceil((Z[i] + ORIGIN_Z + reach) / CELL));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const d = Math.hypot(c * CELL - ORIGIN_X - X[i], r * CELL - ORIGIN_Z - Z[i]);
        if (d > reach) continue;
        const cell = r * COLS + c;
        const w = Math.exp(-((d / 2.5) ** 2));
        sum[cell] += profile[i] * w;
        weight[cell] += w;
        edge[cell] = Math.min(edge[cell], d - HW[i]);
      }
    }
  }

  const heights = new Float32Array(COLS * ROWS);
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const cell = r * COLS + c;
      const hillside = hillsideAt(c * CELL - ORIGIN_X, r * CELL - ORIGIN_Z);
      if (!weight[cell]) {
        heights[cell] = hillside;
        continue;
      }
      const t = clamp((edge[cell] - SHOULDER) / BLEND, 0, 1);
      heights[cell] = lerp(sum[cell] / weight[cell], hillside, t * t * (3 - 2 * t));
    }
  }
  return heights;
}

/** Ground height in metres at a world position. */
export function heightAt(x: number, z: number): number {
  const fx = (x + ORIGIN_X) / CELL;
  const fz = (z + ORIGIN_Z) / CELL;
  if (fx < 0 || fz < 0 || fx >= COLS - 1 || fz >= ROWS - 1) return hillsideAt(x, z);
  const col = Math.floor(fx);
  const row = Math.floor(fz);
  const tx = fx - col;
  const tz = fz - row;
  const at = (c: number, r: number) => graded[r * COLS + c];
  const top = at(col, row) + (at(col + 1, row) - at(col, row)) * tx;
  const bottom = at(col, row + 1) + (at(col + 1, row + 1) - at(col, row + 1)) * tx;
  return top + (bottom - top) * tz;
}

/** How much the ground rises per metre along x and along z, averaged over a car's length. */
export function slopeAt(x: number, z: number): [number, number] {
  const d = 1.5;
  return [(heightAt(x + d, z) - heightAt(x - d, z)) / (2 * d), (heightAt(x, z + d) - heightAt(x, z - d)) / (2 * d)];
}
