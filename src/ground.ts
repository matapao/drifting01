import { clamp, pick, rand, seededRandom, TAU } from './math';
import type { SurfaceKind } from './state';
import { edgePoint, forEachKerb, track } from './track';
import {
  EDGE_LINE_COLOUR,
  GROUND_COLOURS,
  MAP_D,
  MAP_W,
  MASK_SCALE,
  ORIGIN_X,
  ORIGIN_Z,
  PAINT_SCALE,
  photoX,
  photoZ,
  SIDE_ROAD,
  START_LINE_CP,
} from './track-data';

export interface Surface {
  mu: number;
  drag: number;
  kind: SurfaceKind;
}

const SURFACES: Record<SurfaceKind, Surface> = {
  tarmac: { mu: 1, drag: 0, kind: 'tarmac' },
  kerb: { mu: 0.92, drag: 0.02, kind: 'kerb' },
  gravel: { mu: 0.6, drag: 0.28, kind: 'gravel' },
  grass: { mu: 0.45, drag: 0.45, kind: 'grass' },
};

// Bits in the mask. ROADSIDE covers the asphalt plus a margin, where nothing solid may stand.
const TARMAC = 1;
const KERB = 2;
const ROADSIDE = 4;

const MASK_W = Math.round(MAP_W * MASK_SCALE);
const MASK_H = Math.round(MAP_D * MASK_SCALE);

let mask!: Uint8Array;
let groundPixels!: Uint8ClampedArray;
let groundW = 0;
let groundH = 0;

function strokeCentreline(ctx: CanvasRenderingContext2D, scale: number, widen = 0): void {
  const { N, X, Z, HW } = track;
  ctx.lineCap = 'round';
  for (let i = 0; i < N; i++) {
    const next = (i + 1) % N;
    ctx.lineWidth = scale * (HW[i] * 2 + widen);
    ctx.beginPath();
    ctx.moveTo((X[i] + ORIGIN_X) * scale, (Z[i] + ORIGIN_Z) * scale);
    ctx.lineTo((X[next] + ORIGIN_X) * scale, (Z[next] + ORIGIN_Z) * scale);
    ctx.stroke();
  }
}

/** Rasterises the track into the surface mask and keeps the ground map's pixels for lookups. */
export function buildMask(groundMap: HTMLImageElement): void {
  const canvas = document.createElement('canvas');
  canvas.width = MASK_W;
  canvas.height = MASK_H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, MASK_W, MASK_H);
  ctx.strokeStyle = 'rgb(0,0,255)';
  strokeCentreline(ctx, MASK_SCALE, 7);
  ctx.globalCompositeOperation = 'lighter';
  ctx.strokeStyle = 'rgb(255,0,0)';
  strokeCentreline(ctx, MASK_SCALE, 0);
  ctx.globalCompositeOperation = 'source-over';
  const toMask = (x: number, z: number): [number, number] => [(x + ORIGIN_X) * MASK_SCALE, (z + ORIGIN_Z) * MASK_SCALE];
  forEachKerb((inner, outer) => {
    ctx.beginPath();
    inner.forEach(([x, z], i) => (i ? ctx.lineTo(...toMask(x, z)) : ctx.moveTo(...toMask(x, z))));
    for (let i = outer.length - 1; i >= 0; i--) ctx.lineTo(...toMask(outer[i][0], outer[i][1]));
    ctx.closePath();
    ctx.fillStyle = 'rgb(255,255,255)';
    ctx.fill();
  });

  const pixels = ctx.getImageData(0, 0, MASK_W, MASK_H).data;
  mask = new Uint8Array(MASK_W * MASK_H);
  for (let i = 0; i < MASK_W * MASK_H; i++) {
    const r = pixels[i * 4];
    const g = pixels[i * 4 + 1];
    const b = pixels[i * 4 + 2];
    mask[i] = (r > 127 ? TARMAC : 0) | (g > 127 ? KERB : 0) | (b > 127 || r > 127 ? ROADSIDE : 0);
  }
  // WebKit caps total canvas memory and leaves canvases blank past it, so scratch canvases go as soon as they're read.
  canvas.width = canvas.height = 0;

  const mapCanvas = document.createElement('canvas');
  groundW = groundMap.width;
  groundH = groundMap.height;
  mapCanvas.width = groundW;
  mapCanvas.height = groundH;
  const mapCtx = mapCanvas.getContext('2d', { willReadFrequently: true })!;
  mapCtx.drawImage(groundMap, 0, 0);
  groundPixels = mapCtx.getImageData(0, 0, groundW, groundH).data;
  mapCanvas.width = mapCanvas.height = 0;
}

export function maskAt(x: number, z: number): number {
  const mx = ((x + ORIGIN_X) * MASK_SCALE) | 0;
  const mz = ((z + ORIGIN_Z) * MASK_SCALE) | 0;
  return mx < 0 || mz < 0 || mx >= MASK_W || mz >= MASK_H ? -1 : mask[mz * MASK_W + mx];
}

/**
 * The ground map's channels at a world position, 0 to 1.
 * Red is forest (solid), green is grass, blue is paved or gravel.
 */
export function groundAt(x: number, z: number): [number, number, number] {
  const px = ((x + ORIGIN_X) / MAP_W) * groundW;
  const py = ((z + ORIGIN_Z) / MAP_D) * groundH;
  if (px < 0 || py < 0 || px >= groundW - 1 || py >= groundH - 1) return [1, 0, 0];
  const i = ((py | 0) * groundW + (px | 0)) * 4;
  return [groundPixels[i] / 255, groundPixels[i + 1] / 255, groundPixels[i + 2] / 255];
}

export function surfaceAt(x: number, z: number): Surface {
  const bits = maskAt(x, z);
  if (bits < 0) return SURFACES.grass;
  if (bits & KERB) return SURFACES.kerb;
  if (bits & TARMAC) return SURFACES.tarmac;
  const [r, g, b] = groundAt(x, z);
  return b >= g && b >= r ? SURFACES.gravel : SURFACES.grass;
}

export function solidAt(x: number, z: number): boolean {
  const bits = maskAt(x, z);
  if (bits < 0) return true;
  if (bits & ROADSIDE) return false;
  const [r, , b] = groundAt(x, z);
  return r > 0.6 && b < 0.3;
}

export const isRoadside = (x: number, z: number): boolean => {
  const bits = maskAt(x, z);
  return bits > 0 && (bits & ROADSIDE) !== 0;
};

/** Paints the ground texture: the map recoloured, then roads, asphalt wear, edge lines and the start line. */
export function paintGround(groundMap: HTMLImageElement): HTMLCanvasElement {
  const width = Math.round(MAP_W * PAINT_SCALE);
  const height = Math.round(MAP_D * PAINT_SCALE);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const scale = PAINT_SCALE;
  const toX = (x: number) => (x + ORIGIN_X) * scale;
  const toZ = (z: number) => (z + ORIGIN_Z) * scale;

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(groundMap, 0, 0, width, height);

  const image = ctx.getImageData(0, 0, width, height);
  const px = image.data;
  const forest = [46, 64, 38];
  const grass = [93, 138, 58];
  const paved = [156, 155, 150];
  const noise = seededRandom(11);
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i] / 255;
    const g = px[i + 1] / 255;
    const b = px[i + 2] / 255;
    const sum = r + g + b || 1;
    const grain = (noise() - 0.5) * 14;
    px[i] = (forest[0] * r + grass[0] * g + paved[0] * b) / sum + grain;
    px[i + 1] = (forest[1] * r + grass[1] * g + paved[1] * b) / sum + grain;
    px[i + 2] = (forest[2] * r + grass[2] * g + paved[2] * b) / sum + grain;
    px[i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);

  // Soft patches, then fine speckle.
  for (let i = 0; i < 900; i++) {
    const x = Math.random() * width;
    const y = Math.random() * height;
    const radius = rand(30, 140);
    const patch = ctx.createRadialGradient(x, y, 0, x, y, radius);
    patch.addColorStop(0, Math.random() < 0.5 ? 'rgba(40,70,25,0.22)' : 'rgba(140,170,80,0.16)');
    patch.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = patch;
    ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  }
  const speckle = ['rgba(30,60,20,0.5)', 'rgba(120,160,70,0.5)', 'rgba(80,120,45,0.5)', 'rgba(170,168,160,0.35)'];
  for (let i = 0; i < width * height * 0.006; i++) {
    ctx.fillStyle = pick(speckle);
    ctx.fillRect(Math.random() * width, Math.random() * height, 2, 2);
  }

  const sideRoad = SIDE_ROAD.map(([x, y]): [number, number] => [photoX(x), photoZ(y)]);
  const strokeSideRoad = (lineWidth: number, style: string, dash?: number[]) => {
    ctx.save();
    ctx.strokeStyle = style;
    ctx.lineWidth = lineWidth * scale;
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'round';
    if (dash) ctx.setLineDash(dash.map((d) => d * scale));
    ctx.beginPath();
    sideRoad.forEach(([x, z], i) => (i ? ctx.lineTo(toX(x), toZ(z)) : ctx.moveTo(toX(x), toZ(z))));
    ctx.stroke();
    ctx.restore();
  };
  strokeSideRoad(10.2, GROUND_COLOURS.pave);
  strokeSideRoad(7.4, EDGE_LINE_COLOUR);
  strokeSideRoad(7, GROUND_COLOURS.road);
  strokeSideRoad(0.12, 'rgba(232,196,64,0.9)', [3, 3]);

  ctx.strokeStyle = GROUND_COLOURS.road;
  strokeCentreline(ctx, scale, 0);

  paintAsphaltWear(ctx, width, height, toX, toZ);

  ctx.lineWidth = 0.18 * scale;
  ctx.strokeStyle = EDGE_LINE_COLOUR;
  for (const side of [-1, 1]) {
    ctx.beginPath();
    for (let i = 0; i <= track.N; i++) {
      const [x, z] = edgePoint(i % track.N, side);
      if (i) ctx.lineTo(toX(x), toZ(z));
      else ctx.moveTo(toX(x), toZ(z));
    }
    ctx.stroke();
  }

  paintStartLine(ctx, toX, toZ);
  return canvas;
}

/** Aggregate, patches, cracks and rubber lines, drawn on a layer clipped to the asphalt. */
function paintAsphaltWear(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  toX: (x: number) => number,
  toZ: (z: number) => number,
): void {
  const scale = PAINT_SCALE;
  let minX = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < track.N; i++) {
    minX = Math.min(minX, toX(track.X[i]) - 80);
    maxX = Math.max(maxX, toX(track.X[i]) + 80);
    minZ = Math.min(minZ, toZ(track.Z[i]) - 80);
    maxZ = Math.max(maxZ, toZ(track.Z[i]) + 80);
  }
  const spanX = maxX - minX;
  const spanZ = maxZ - minZ;

  // Both scratch canvases stay in memory rather than on the GPU, like the ground itself.
  const layer = document.createElement('canvas');
  layer.width = width;
  layer.height = height;
  const wear = layer.getContext('2d', { willReadFrequently: true })!;
  // Sizes below are in metres, times `scale` pixels. The grain itself isn't painted here: asphalt.ts lays
  // millimetre stones over the whole road, so the paint only carries what's bigger than a hand.
  const { N, X, Z, HW, TX, TZ, NX, NZ, K } = track;
  const at = (i: number, lateral: number): [number, number] => [toX(X[i] + NX[i] * lateral), toZ(Z[i] + NZ[i] * lateral)];

  // Weathering in broad, soft patches.
  for (let i = 0; i < 420; i++) {
    const grey = pick([46, 60, 128]);
    wear.fillStyle = `rgba(${grey},${grey + 1},${grey + 3},0.1)`;
    wear.beginPath();
    wear.ellipse(minX + Math.random() * spanX, minZ + Math.random() * spanZ, rand(2, 8) * scale, rand(1.2, 4.4) * scale, rand(0, 3), 0, TAU);
    wear.fill();
  }

  // Repairs: squarish patches cut along the track, a shade off the surface round them, with a seam.
  for (let n = 0; n < 22; n++) {
    const i = Math.floor(Math.random() * N);
    const along = rand(1.2, 4.5) * scale;
    const across = rand(1, 3.2) * scale;
    wear.save();
    wear.translate(...at(i, rand(-0.6, 0.6) * HW[i]));
    wear.rotate(Math.atan2(TZ[i], TX[i]));
    wear.fillStyle = Math.random() < 0.4 ? `rgba(150,150,148,${rand(0.05, 0.1)})` : `rgba(30,31,34,${rand(0.06, 0.13)})`;
    wear.fillRect(-along / 2, -across / 2, along, across);
    wear.strokeStyle = 'rgba(16,16,18,0.4)';
    wear.lineWidth = 0.05 * scale;
    wear.strokeRect(-along / 2, -across / 2, along, across);
    wear.restore();
  }

  // Sealed cracks: wandering bands of black sealant a few centimetres wide, mostly across the track.
  wear.lineCap = 'round';
  wear.lineJoin = 'round';
  for (let n = 0; n < 170; n++) {
    const i = Math.floor(Math.random() * N);
    const across = Math.random() < 0.6;
    let x = X[i] + NX[i] * rand(-1, 1) * HW[i];
    let z = Z[i] + NZ[i] * rand(-1, 1) * HW[i];
    let heading = Math.atan2(across ? NZ[i] : TZ[i], across ? NX[i] : TX[i]) + rand(-0.3, 0.3);
    wear.strokeStyle = `rgba(14,14,16,${rand(0.35, 0.6)})`;
    wear.lineWidth = rand(0.04, 0.08) * scale;
    wear.beginPath();
    wear.moveTo(toX(x), toZ(z));
    for (let s = 6 + Math.floor(Math.random() * 10); s > 0; s--) {
      heading += rand(-0.45, 0.45);
      const step = rand(0.25, 0.7);
      x += Math.cos(heading) * step;
      z += Math.sin(heading) * step;
      wear.lineTo(toX(x), toZ(z));
    }
    wear.stroke();
  }

  // Rubber from drifting: black arcs where the rear tyres slide through each corner, in from the outside, past
  // the inside at the clipping point and out wide again; heavier through the tight ones. The fronts leave less.
  const bend = Array.from({ length: N }, (_, i) => {
    let sum = 0;
    for (let o = -12; o <= 12; o++) sum += K[(i + o + N) % N];
    return sum / 25;
  });
  const apexes: number[] = [];
  for (let i = 0; i < N; i++) {
    const k = Math.abs(bend[i]);
    if (k < 0.035) continue;
    let peak = true;
    for (let o = -40; o <= 40 && peak; o++) if (o && Math.abs(bend[(i + o + N) % N]) > k) peak = false;
    if (peak) apexes.push(i);
  }
  const stride = track.length / N;
  for (const apex of apexes) {
    const inside = Math.sign(bend[apex]);
    const weight = clamp(Math.abs(bend[apex]) * 9, 0.45, 1.2);
    for (let run = 0; run < 34; run++) {
      const entry = Math.round(rand(14, 30) / stride);
      const exit = Math.round(rand(14, 30) / stride);
      const enter = rand(0.25, 0.75);
      const clip = rand(0.2, 0.7);
      const leave = rand(0.3, 0.85);
      const shift = rand(-0.3, 0.3);
      const alpha = rand(0.035, 0.075) * weight;
      for (const [wheel, outward, strength] of [
        [-0.72, 0, 1],
        [0.72, 0, 1],
        [-0.72, 0.35, 0.35],
        [0.72, 0.35, 0.35],
      ]) {
        wear.strokeStyle = `rgba(16,16,18,${(alpha * strength).toFixed(3)})`;
        wear.lineWidth = rand(0.2, 0.26) * scale;
        wear.beginPath();
        for (let k = -entry; k <= exit; k += 2) {
          const i = (apex + k + N) % N;
          const t = k < 0 ? -k / entry : k / exit;
          const share = clip + ((k < 0 ? -enter : -leave) - clip) * t ** 1.6 - outward;
          const lateral = clamp((share * HW[i] + shift) * inside + wheel, -HW[i] + 0.15, HW[i] - 0.15);
          if (k === -entry) wear.moveTo(...at(i, lateral));
          else wear.lineTo(...at(i, lateral));
        }
        wear.stroke();
      }
    }
  }

  // A few sets of doughnuts where the track is wide.
  for (let n = 0; n < 4; n++) {
    let i = Math.floor(Math.random() * N);
    for (let tries = 0; tries < 50 && HW[i] < 4.6; tries++) i = Math.floor(Math.random() * N);
    const [cx, cz] = at(i, rand(-0.3, 0.3) * HW[i]);
    for (const radius of [rand(2.3, 2.8), rand(3.6, 4.1)]) {
      wear.strokeStyle = `rgba(16,16,18,${rand(0.05, 0.09).toFixed(3)})`;
      wear.lineWidth = 0.24 * scale;
      wear.beginPath();
      wear.ellipse(cx, cz, radius * scale, radius * scale * rand(0.9, 1), rand(0, 3), 0, TAU);
      wear.stroke();
    }
  }

  // Keep only what lies on the asphalt. The road goes onto its own mask first, applied in one go: clipping
  // stroke by stroke kept only the last segment, and past a thousand strokes browsers wipe the whole canvas.
  const road = document.createElement('canvas');
  road.width = width;
  road.height = height;
  const roadCtx = road.getContext('2d', { willReadFrequently: true })!;
  roadCtx.strokeStyle = '#000';
  strokeCentreline(roadCtx, scale, 0);
  wear.globalCompositeOperation = 'destination-in';
  wear.drawImage(road, 0, 0);
  road.width = road.height = 0;
  ctx.drawImage(layer, 0, 0);
  layer.width = layer.height = 0;
}

function paintStartLine(
  ctx: CanvasRenderingContext2D,
  toX: (x: number) => number,
  toZ: (z: number) => number,
): void {
  const scale = PAINT_SCALE;
  const i = track.idxOfCP(START_LINE_CP);
  const [ax, az] = edgePoint(i, 1);
  const [bx, bz] = edgePoint(i, -1);
  ctx.strokeStyle = 'rgba(240,240,236,0.92)';
  ctx.lineWidth = 0.5 * scale;
  ctx.beginPath();
  ctx.moveTo(toX(ax), toZ(az));
  ctx.lineTo(toX(bx), toZ(bz));
  ctx.stroke();

  // Two rows of chequers just past the line.
  const tx = track.TX[i];
  const tz = track.TZ[i];
  const nx = track.NX[i];
  const nz = track.NZ[i];
  const halfWidth = track.HW[i];
  for (let col = 0; col < Math.floor((halfWidth * 2) / 0.5); col++) {
    for (let row = 1; row < 3; row++) {
      if ((col + row) % 2) continue;
      const x = track.X[i] + nx * (-halfWidth + 0.25 + col * 0.5) + tx * (0.25 + row * 0.5);
      const z = track.Z[i] + nz * (-halfWidth + 0.25 + col * 0.5) + tz * (0.25 + row * 0.5);
      ctx.fillStyle = 'rgba(240,240,236,0.9)';
      ctx.save();
      ctx.translate(toX(x), toZ(z));
      ctx.rotate(Math.atan2(nz, nx));
      ctx.fillRect(-0.25 * scale, -0.25 * scale, 0.5 * scale, 0.5 * scale);
      ctx.restore();
    }
  }
}
