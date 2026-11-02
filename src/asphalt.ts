// Fine asphalt for the track. The painted ground is about 11 cm a pixel, which makes tarmac look like coarse
// grit up close, so the road gets a tiling layer on top, in world space: a dense mix of 4 to 16 mm stones in
// dark binder with their relief for the light, plus a slow mottle so the tiling doesn't show. It only goes
// where the ground is asphalt: the track and the public road.

import {
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  type MeshStandardMaterial,
  RedFormat,
  RepeatWrapping,
  RGBAFormat,
} from 'three';
import { clamp, seededRandom } from './math';
import { renderer } from './stage';
import { track } from './track';
import { MAP_D, MAP_W, ORIGIN_X, ORIGIN_Z, photoX, photoZ, SIDE_ROAD } from './track-data';

/** Metres covered by one repeat of the stone texture, and of the mottle over it. */
const FINE_TILE = 1.6;
const MID_TILE = 11;
const FINE_SIZE = 512;
const MID_SIZE = 256;
/** Pixels per metre of the asphalt mask. */
const MASK_SCALE = 4;
/** Width of the public road's asphalt, as painted. */
const SIDE_ROAD_WIDTH = 7;

const wrap = (i: number, size: number) => ((i % size) + size) % size;

/**
 * Stones over binder. Blue is brightness against the painted colour (doubled, so the middle is 1), alpha is
 * roughness, and red and green are the surface's tilt along x and z, from the stones' height.
 */
function stoneTexture(): DataTexture {
  const size = FINE_SIZE;
  const random = seededRandom(86);
  const height = new Float32Array(size * size);
  const shade = new Float32Array(size * size);
  const rough = new Float32Array(size * size);
  // Binder and sand: dark, rough, and grainy at the scale of single pixels (3 mm).
  for (let i = 0; i < size * size; i++) {
    const grain = random();
    shade[i] = 0.6 + grain * 0.24;
    height[i] = grain * 0.22;
    rough[i] = 0.88 + random() * 0.08;
  }
  // Aggregate: worn stones show lighter and polished, a few dark ones and the odd near-white quartz.
  const mmPerPixel = (FINE_TILE * 1000) / size;
  const stones = Math.round(size * size * 0.08);
  for (let s = 0; s < stones; s++) {
    const cx = random() * size;
    const cy = random() * size;
    const radius = (2 + random() ** 1.8 * 6) / mmPerPixel;
    const stretch = 0.7 + random() * 0.6;
    const angle = random() * Math.PI;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const kind = random();
    const tone = kind < 0.12 ? 0.78 + random() * 0.18 : kind > 0.97 ? 1.6 + random() * 0.2 : 1.08 + random() * 0.4;
    const top = 0.5 + random() * 0.5;
    const polish = 0.55 + random() * 0.17;
    const reach = Math.ceil(radius * Math.max(stretch, 1 / stretch)) + 1;
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const px = Math.floor(cx) + dx;
        const py = Math.floor(cy) + dy;
        const ox = px + 0.5 - cx;
        const oy = py + 0.5 - cy;
        const u = (ox * cos + oy * sin) / (radius * stretch);
        const v = (-ox * sin + oy * cos) / (radius / stretch);
        const d2 = u * u + v * v;
        if (d2 >= 1) continue;
        const dome = Math.sqrt(1 - d2);
        const h = 0.2 + top * dome;
        const i = wrap(py, size) * size + wrap(px, size);
        if (h <= height[i]) continue;
        height[i] = h;
        shade[i] = tone * (0.88 + 0.12 * dome);
        rough[i] = polish;
      }
    }
  }
  // Pores between the stones, where the light doesn't reach.
  for (let p = 0; p < size * size * 0.012; p++) {
    const x = Math.floor(random() * size);
    const y = Math.floor(random() * size);
    for (const [dx, dy] of [
      [0, 0],
      [1, 0],
      [0, 1],
    ]) {
      if (dx + dy && random() < 0.5) continue;
      const i = wrap(y + dy, size) * size + wrap(x + dx, size);
      if (height[i] > 0.3) continue;
      height[i] = -0.25;
      shade[i] = 0.4;
      rough[i] = 0.96;
    }
  }

  let mean = 0;
  for (let i = 0; i < size * size; i++) mean += shade[i] / (size * size);
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      // Tilt from the height's slope. Rows run along +z, columns along +x.
      const sx = (height[y * size + wrap(x + 1, size)] - height[y * size + wrap(x - 1, size)]) / 2;
      const sz = (height[wrap(y + 1, size) * size + x] - height[wrap(y - 1, size) * size + x]) / 2;
      data[i * 4] = Math.round(clamp(0.5 - sx * 0.5, 0, 1) * 255);
      data[i * 4 + 1] = Math.round(clamp(0.5 - sz * 0.5, 0, 1) * 255);
      data[i * 4 + 2] = Math.round(clamp(shade[i] / mean / 2, 0, 1) * 255);
      data[i * 4 + 3] = Math.round(clamp(rough[i], 0, 1) * 255);
    }
  }
  return tiling(new DataTexture(data, size, size, RGBAFormat));
}

/** Smooth noise that wraps at the edges, from a coarse random lattice. */
function wrappingNoise(size: number, cells: number, random: () => number): Float32Array {
  const lattice = Array.from({ length: cells * cells }, () => random());
  const out = new Float32Array(size * size);
  const smooth = (t: number) => t * t * (3 - 2 * t);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const gx = (x / size) * cells;
      const gy = (y / size) * cells;
      const x0 = Math.floor(gx);
      const y0 = Math.floor(gy);
      const tx = smooth(gx - x0);
      const ty = smooth(gy - y0);
      const at = (i: number, j: number) => lattice[wrap(j, cells) * cells + wrap(i, cells)];
      const top = at(x0, y0) + (at(x0 + 1, y0) - at(x0, y0)) * tx;
      const bottom = at(x0, y0 + 1) + (at(x0 + 1, y0 + 1) - at(x0, y0 + 1)) * tx;
      out[y * size + x] = top + (bottom - top) * ty;
    }
  }
  return out;
}

/** Slow variation over metres: older and newer patches of the same surface. Red is tone, green roughness. */
function mottleTexture(): DataTexture {
  const size = MID_SIZE;
  const random = seededRandom(1988);
  const layers = [4, 8, 16, 32].map((cells) => [wrappingNoise(size, cells, random), wrappingNoise(size, cells, random)]);
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    let tone = 0;
    let rough = 0;
    let weight = 0;
    layers.forEach(([a, b], octave) => {
      const w = 0.55 ** octave;
      tone += a[i] * w;
      rough += b[i] * w;
      weight += w;
    });
    data[i * 4] = Math.round(clamp((tone / weight - 0.5) * 1.8 + 0.5, 0, 1) * 255);
    data[i * 4 + 1] = Math.round(clamp((rough / weight - 0.5) * 1.8 + 0.5, 0, 1) * 255);
    data[i * 4 + 2] = 0;
    data[i * 4 + 3] = 255;
  }
  return tiling(new DataTexture(data, size, size, RGBAFormat));
}

function tiling(texture: DataTexture): DataTexture {
  texture.wrapS = texture.wrapT = RepeatWrapping;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  texture.needsUpdate = true;
  return texture;
}

/** Where the ground is asphalt, laid out like the painted ground so both use the same coordinates. */
function asphaltMask(): DataTexture {
  const width = Math.round(MAP_W * MASK_SCALE);
  const height = Math.round(MAP_D * MASK_SCALE);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const toX = (x: number) => (x + ORIGIN_X) * MASK_SCALE;
  const toZ = (z: number) => (z + ORIGIN_Z) * MASK_SCALE;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = '#fff';
  ctx.lineCap = 'round';
  const { N, X, Z, HW } = track;
  for (let i = 0; i < N; i++) {
    const next = (i + 1) % N;
    ctx.lineWidth = HW[i] * 2 * MASK_SCALE;
    ctx.beginPath();
    ctx.moveTo(toX(X[i]), toZ(Z[i]));
    ctx.lineTo(toX(X[next]), toZ(Z[next]));
    ctx.stroke();
  }
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'round';
  ctx.lineWidth = SIDE_ROAD_WIDTH * MASK_SCALE;
  ctx.beginPath();
  SIDE_ROAD.forEach(([px, py], i) => (i ? ctx.lineTo(toX(photoX(px)), toZ(photoZ(py))) : ctx.moveTo(toX(photoX(px)), toZ(photoZ(py)))));
  ctx.stroke();

  const pixels = ctx.getImageData(0, 0, width, height).data;
  canvas.width = canvas.height = 0;
  // The painted ground is uploaded with its top row last; match it.
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = (height - 1 - y) * width;
    for (let x = 0; x < width; x++) data[row + x] = pixels[(y * width + x) * 4];
  }
  const texture = new DataTexture(data, width, height, RedFormat);
  texture.unpackAlignment = 1;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

/** Adds the fine asphalt to the ground's material, which paints the whole map from one texture. */
export function addAsphaltDetail(material: MeshStandardMaterial): void {
  const uniforms = {
    asphaltStones: { value: stoneTexture() },
    asphaltMottle: { value: mottleTexture() },
    asphaltMask: { value: asphaltMask() },
    /** How strongly the stones' relief catches the light. */
    asphaltRelief: { value: 0.6 },
  };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vAsphaltXZ;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n  vAsphaltXZ = (modelMatrix * vec4(transformed, 1.0)).xz;');
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform sampler2D asphaltStones;
uniform sampler2D asphaltMottle;
uniform sampler2D asphaltMask;
uniform float asphaltRelief;
varying vec2 vAsphaltXZ;`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
  float asphalt = texture2D(asphaltMask, vMapUv).r;
  vec4 stones = texture2D(asphaltStones, vAsphaltXZ / ${FINE_TILE.toFixed(2)});
  vec4 mottle = texture2D(asphaltMottle, mat2(0.8, -0.6, 0.6, 0.8) * vAsphaltXZ / ${MID_TILE.toFixed(1)});
  diffuseColor.rgb *= mix(1.0, stones.b * 2.0 * (0.86 + 0.28 * mottle.r), asphalt);`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `#include <roughnessmap_fragment>
  roughnessFactor = mix(roughnessFactor, clamp(stones.a + (mottle.g - 0.5) * 0.16, 0.3, 1.0), asphalt);`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        `#include <normal_fragment_maps>
  vec2 asphaltTilt = (stones.rg * 2.0 - 1.0) * asphaltRelief * asphalt;
  normal = normalize(normal + (viewMatrix * vec4(asphaltTilt.x, 0.0, asphaltTilt.y, 0.0)).xyz);`,
      );
  };
  material.customProgramCacheKey = () => 'drift-asphalt-ground';
}
