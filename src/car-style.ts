// The drift look for every car: a livery laid onto the paint, drift wheels and stance, a windscreen banner, a
// front lip, tow straps and a rear wing fitted to the body. The stock look is the car as modelled.
//
// The packed models have no texture coordinates, so the livery is projected by position instead: one picture
// for each side of the car and one seen from above, blended by which way the surface faces.

import {
  BoxGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  ExtrudeGeometry,
  Group,
  type Material,
  Mesh,
  MeshStandardMaterial,
  Shape,
  SRGBColorSpace,
  type Texture,
} from 'three';
import { clamp } from './math';

export type CarStyle = 'stock' | 'drift';
export const CAR_STYLES: readonly (readonly [style: CarStyle, label: string])[] = [
  ['stock', 'Stock'],
  ['drift', 'Drift'],
];

/** Where the body is, in car space and metres: the model's origin sits on the ground between the axles. */
export interface CarBox {
  rear: number;
  front: number;
  halfWidth: number;
  height: number;
  /** Lowest edge of the side windows. */
  beltline: number;
  frontAxle: number;
  rearAxle: number;
  wheelRadius: number;
}

/** Points of the body shell, in car space, for fitting parts to it. */
export type BodyPoints = ArrayLike<number>;

interface DriftLook {
  /** Rim colour, metalness and roughness. */
  rim: [colour: number, metalness: number, roughness: number];
  cage: number;
  banner: string;
  number: string;
  /** Rear wing: height of the posts, chord and span as a share of the car's width; null for none. */
  wing: { posts: number; chord: number; span: number; plates: boolean } | null;
  /** Front and rear camber, in degrees. */
  camber: [front: number, rear: number];
  livery: (paint: LiveryPainter) => void;
}

const FONT = '"Saira Semi Condensed", "Arial Narrow", "Helvetica Neue", Arial, sans-serif';

/** Drift builds of each car, styled after what they wear at events. No real brands or sponsors. */
const LOOKS: Record<string, DriftLook> = {
  // Pro-am: loud graphics, black wheels, big wing.
  retro: {
    rim: [0x151618, 0.3, 0.4],
    cage: 0xd8ff3a,
    banner: 'DRIFTING01',
    number: '07',
    wing: { posts: 0.24, chord: 0.3, span: 0.9, plates: true },
    camber: [-6.5, -1.5],
    livery(p) {
      const accent = p.pickAccent(['#c6ff2e', '#ff2f92', '#2fd8ff']);
      p.sides((s) => {
        // Black lower body with a rising edge, and two slashes from behind the front wheel up to the tail.
        s.poly('#141518', [[p.box.front + 0.2, 0], [p.box.front + 0.2, 0.3], [p.box.frontAxle, 0.33], [p.box.rear - 0.2, 0.62], [p.box.rear - 0.2, 0]]);
        s.poly(accent, [[p.box.frontAxle - 0.3, 0.33], [p.box.frontAxle - 0.56, 0.48], [p.box.rear + 0.18, 0.89], [p.box.rear + 0.26, 0.72]]);
        s.poly(p.contrast(), [[p.box.frontAxle - 0.36, 0.35], [p.box.frontAxle - 0.54, 0.455], [p.box.rear + 0.2, 0.86], [p.box.rear + 0.25, 0.75]]);
        s.poly(accent, [[p.box.frontAxle - 0.75, 0.52], [p.box.frontAxle - 0.85, 0.565], [p.box.rear + 0.9, 0.87], [p.box.rear + 0.95, 0.81]]);
        s.roundel(this.number, p.door(), p.box.beltline - 0.25, 0.17, p.contrast(), p.ink());
        s.block('SIDEWAYS', p.box.frontAxle + 0.05, 0.62, 0.42, 0.09, p.contrast(), p.ink());
        s.block('No.07', p.box.rearAxle - 0.12, p.box.beltline - 0.12, 0.3, 0.08, accent, '#111');
      });
      p.top((t) => t.stripe(-0.34, -0.12, accent));
    },
  },
  // Panda two-tone with a red pinstripe and slashes, a door roundel, bronze wheels, a spoiler on the hatch.
  ae86: {
    rim: [0x9a6a35, 0.3, 0.36],
    cage: 0xd23a2f,
    banner: 'HACHIROKU',
    number: '86',
    wing: { posts: 0.05, chord: 0.2, span: 0.82, plates: false },
    camber: [-5.5, -1],
    livery(p) {
      const lower = p.base.getHSL({ h: 0, s: 0, l: 0 }).l < 0.2 ? '#d9d8d2' : '#101113';
      p.sides((s) => {
        s.poly(lower, [[p.box.front + 0.2, -0.1], [p.box.front + 0.2, 0.57], [p.box.rear - 0.2, 0.57], [p.box.rear - 0.2, -0.1]]);
        s.poly('#d23a2f', [[p.box.front + 0.2, 0.58], [p.box.front + 0.2, 0.615], [p.box.rear - 0.2, 0.615], [p.box.rear - 0.2, 0.58]]);
        for (let k = 0; k < 3; k++) {
          const z = p.box.rearAxle + 0.55 - k * 0.16;
          s.poly('#d23a2f', [[z, 0.64], [z + 0.08, 0.64], [z - 0.12, p.box.beltline - 0.02], [z - 0.2, p.box.beltline - 0.02]]);
        }
        s.roundel(this.number, p.door() + 0.05, (0.64 + p.box.beltline) / 2, 0.1, p.contrast(), p.ink());
      });
    },
  },
  // Twin stripes over the top, a band down the sides, bronze wheels and a GT wing.
  r32: {
    rim: [0x9a6a35, 0.3, 0.36],
    cage: 0xf2c230,
    banner: 'DRIFTING01',
    number: '32',
    wing: { posts: 0.2, chord: 0.28, span: 0.88, plates: true },
    camber: [-6, -1.5],
    livery(p) {
      const stripe = p.contrast();
      const accent = p.pickAccent(['#f2c230', '#2fd8ff', '#ff5a2a']);
      p.top((t) => {
        t.stripe(-0.27, -0.08, stripe);
        t.stripe(0.08, 0.27, stripe);
      });
      p.sides((s) => {
        s.poly(stripe, [[p.box.front + 0.2, 0.34], [p.box.front + 0.2, 0.44], [p.box.rear - 0.2, 0.44], [p.box.rear - 0.2, 0.34]]);
        s.poly(accent, [[p.box.front + 0.2, 0.3], [p.box.front + 0.2, 0.33], [p.box.rear - 0.2, 0.33], [p.box.rear - 0.2, 0.3]]);
        s.number(this.number, p.door(), 0.67, 0.32, stripe, accent);
      });
    },
  },
  // Seventies touring car: three stripes along the sides and over the top, gold mesh-look wheels.
  e30: {
    rim: [0xb8963f, 0.35, 0.32],
    cage: 0xe8762c,
    banner: 'SIDEWAYS',
    number: '30',
    wing: { posts: 0.07, chord: 0.22, span: 0.84, plates: false },
    camber: [-6, -1.5],
    livery(p) {
      const bands = ['#f2a23a', '#d6342b', '#5a2d82'];
      p.sides((s) => {
        bands.forEach((colour, k) => {
          const y = 0.6 - k * 0.07;
          s.poly(colour, [[p.box.front + 0.2, y], [p.box.front + 0.2, y - 0.05], [p.box.rearAxle + 0.25, y - 0.05], [p.box.rearAxle - 0.1, y + 0.12], [p.box.rear - 0.2, y + 0.12], [p.box.rear - 0.2, y + 0.17], [p.box.rearAxle - 0.08, y + 0.17], [p.box.rearAxle + 0.27, y]]);
        });
        s.roundel(this.number, p.door(), p.box.beltline - 0.36, 0.15, p.contrast(), p.ink());
      });
      p.top((t) => bands.forEach((colour, k) => t.stripe(0.12 + k * 0.08, 0.17 + k * 0.08, colour)));
    },
  },
};

export const driftLookOf = (id: string): DriftLook => LOOKS[id] ?? LOOKS.retro;

interface SidePainter {
  poly(colour: string, points: [z: number, y: number][]): void;
  roundel(text: string, z: number, y: number, radius: number, fill: string, ink: string): void;
  block(text: string, z: number, y: number, width: number, height: number, fill: string, ink: string): void;
  number(text: string, z: number, y: number, height: number, fill: string, edge: string): void;
}

interface TopPainter {
  /** A stripe from nose to tail between two distances across the car, in metres from its middle. */
  stripe(from: number, to: number, colour: string): void;
}

export interface LiveryPainter {
  box: CarBox;
  base: Color;
  /** Black or white, whichever stands out on the paint; `ink` is the other one. */
  contrast(): string;
  ink(): string;
  /** The first accent that's far enough from the paint colour. */
  pickAccent(choices: string[]): string;
  /** Where the doors are, along the car. */
  door(): number;
  sides(draw: (s: SidePainter) => void): void;
  top(draw: (t: TopPainter) => void): void;
}

export interface Livery {
  /** Seen from the car's -x side and +x side, then from above. */
  sideA: Texture;
  sideB: Texture;
  top: Texture;
  banner: Texture;
  dispose(): void;
}

const SIDE_W = 1024;
const SIDE_H = 320;
const TOP_W = 384;
const TOP_H = 1024;

function canvas(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  return [c, c.getContext('2d')!];
}

function texture(c: HTMLCanvasElement): CanvasTexture {
  const t = new CanvasTexture(c);
  t.colorSpace = SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Draws a car's drift livery into the side, top and banner textures. */
export function paintLivery(id: string, colour: number, box: CarBox): Livery {
  const look = driftLookOf(id);
  const base = new Color(colour);
  const length = box.front - box.rear;
  const width = box.halfWidth * 2;
  const sideDraws: ((s: SidePainter) => void)[] = [];
  const topDraws: ((t: TopPainter) => void)[] = [];
  const luminance = (c: Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
  const painter: LiveryPainter = {
    box,
    base,
    contrast: () => (luminance(base) > 0.35 ? '#111214' : '#f2f1ec'),
    ink: () => (luminance(base) > 0.35 ? '#f2f1ec' : '#111214'),
    pickAccent(choices) {
      const far = choices.find((hex) => {
        const c = new Color(hex);
        return Math.abs(c.r - base.r) + Math.abs(c.g - base.g) + Math.abs(c.b - base.b) > 0.9;
      });
      return far ?? choices[0];
    },
    door: () => box.frontAxle - (box.frontAxle - box.rearAxle) * 0.42,
    sides: (draw) => void sideDraws.push(draw),
    top: (draw) => void topDraws.push(draw),
  };
  look.livery.call(look, painter);

  // Each side is drawn as seen from outside: on the -x side the nose is to the right, on the +x side to the left.
  const sx = SIDE_W / length;
  const sy = SIDE_H / box.height;
  const side = (flip: boolean): CanvasTexture => {
    const [c, ctx] = canvas(SIDE_W, SIDE_H);
    const toCanvas = (z: number, y: number): [number, number] => [
      flip ? (box.front - z) * sx : (z - box.rear) * sx,
      SIDE_H - y * sy,
    ];
    const text = (words: string, z: number, y: number, height: number, ink: string, edge?: string) => {
      const [cx, cy] = toCanvas(z, y);
      ctx.save();
      ctx.setTransform((sx * height) / 100, 0, 0, (sy * height) / 100, cx, cy);
      ctx.font = `italic 700 100px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      if (edge) {
        ctx.lineWidth = 9;
        ctx.strokeStyle = edge;
        ctx.strokeText(words, 0, 4);
      }
      ctx.fillStyle = ink;
      ctx.fillText(words, 0, 4);
      ctx.restore();
    };
    const painterFor: SidePainter = {
      poly(colour, points) {
        ctx.fillStyle = colour;
        ctx.beginPath();
        points.forEach(([z, y], i) => (i ? ctx.lineTo(...toCanvas(z, y)) : ctx.moveTo(...toCanvas(z, y))));
        ctx.closePath();
        ctx.fill();
      },
      roundel(words, z, y, radius, fill, ink) {
        const [cx, cy] = toCanvas(z, y);
        ctx.fillStyle = fill;
        ctx.beginPath();
        ctx.ellipse(cx, cy, radius * sx, radius * sy, 0, 0, Math.PI * 2);
        ctx.fill();
        text(words, z, y, radius * 1.15, ink);
      },
      block(words, z, y, w, h, fill, ink) {
        const [x0, y0] = toCanvas(z + (flip ? w / 2 : -w / 2), y + h / 2);
        ctx.fillStyle = fill;
        ctx.fillRect(x0, y0, w * sx, h * sy);
        text(words, z, y, h * 0.78, ink);
      },
      number(words, z, y, height, fill, edge) {
        text(words, z, y, height, fill, edge);
      },
    };
    for (const draw of sideDraws) draw(painterFor);
    return texture(c);
  };

  const [topCanvas, topCtx] = canvas(TOP_W, TOP_H);
  const topPainter: TopPainter = {
    stripe(from, to, colour) {
      topCtx.fillStyle = colour;
      const x0 = ((from + box.halfWidth) / width) * TOP_W;
      const x1 = ((to + box.halfWidth) / width) * TOP_W;
      topCtx.fillRect(Math.min(x0, x1), 0, Math.abs(x1 - x0), TOP_H);
    },
  };
  for (const draw of topDraws) draw(topPainter);

  // Banner across the top of the windscreen, read from in front of the car.
  const [bannerCanvas, bannerCtx] = canvas(512, 64);
  bannerCtx.fillStyle = '#0d0e10';
  bannerCtx.fillRect(0, 0, 512, 64);
  bannerCtx.font = `italic 700 46px ${FONT}`;
  bannerCtx.textAlign = 'center';
  bannerCtx.textBaseline = 'middle';
  bannerCtx.fillStyle = '#f2f1ec';
  bannerCtx.fillText(look.banner, 256, 35, 470);

  const textures = [side(false), side(true), texture(topCanvas), texture(bannerCanvas)];
  return {
    sideA: textures[0],
    sideB: textures[1],
    top: textures[2],
    banner: textures[3],
    dispose: () => textures.forEach((t) => t.dispose()),
  };
}

/** GLSL for the paint: the livery over the paint colour, and dark trim on the inside of the shell. */
export const LIVERY_PARS = /* glsl */ `
uniform sampler2D liverySideA;
uniform sampler2D liverySideB;
uniform sampler2D liveryTop;
uniform vec4 liveryBox; // rear, front, half width, height
uniform float liveryOn;
varying vec3 vCarPos;
varying vec3 vCarNormal;
vec4 liveryAt() {
  if (liveryOn < 0.5) return vec4(0.0);
  vec3 n = normalize(vCarNormal);
  float len = liveryBox.y - liveryBox.x;
  float along = (vCarPos.z - liveryBox.x) / len;
  float up = vCarPos.y / liveryBox.w;
  vec4 s = n.x < 0.0 ? texture2D(liverySideA, vec2(along, up)) : texture2D(liverySideB, vec2(1.0 - along, up));
  vec4 t = texture2D(liveryTop, vec2(vCarPos.x / (2.0 * liveryBox.z) + 0.5, along));
  float sideWeight = smoothstep(0.3, 0.6, abs(n.x));
  float topWeight = smoothstep(0.35, 0.7, n.y);
  vec4 c = vec4(s.rgb, s.a * sideWeight);
  c.rgb = mix(c.rgb, t.rgb, t.a * topWeight);
  c.a = max(c.a, t.a * topWeight);
  return c;
}
`;

export const LIVERY_VERTEX = /* glsl */ `
  vCarPos = position;
  vCarNormal = normal;
`;

/** Uniforms for `LIVERY_PARS`; with no livery the paint stays plain. */
export function liveryUniforms(livery: Livery | null, box: CarBox) {
  return {
    liverySideA: { value: livery?.sideA ?? null },
    liverySideB: { value: livery?.sideB ?? null },
    liveryTop: { value: livery?.top ?? null },
    liveryBox: { value: [box.rear, box.front, box.halfWidth, box.height] },
    liveryOn: { value: livery ? 1 : 0 },
  };
}

/** Inside of the shell: the back of the paint shows as dark headlining and door cards. */
export const CABIN_SIDE = /* glsl */ `
  if (!gl_FrontFacing) diffuseColor.rgb = vec3(0.045, 0.046, 0.05);
`;

/** Paint for a packed car: plain or with a livery, dark on its inside. */
export function bodyPaint(colour: number, livery: Livery | null, box: CarBox): MeshStandardMaterial {
  const material = new MeshStandardMaterial({ color: colour, roughness: 0.36, metalness: 0.25, side: DoubleSide });
  const uniforms = liveryUniforms(livery, box);
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vCarPos;\nvarying vec3 vCarNormal;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${LIVERY_VERTEX}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${LIVERY_PARS}`)
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
  vec4 livery = liveryAt();
  diffuseColor.rgb = mix(diffuseColor.rgb, livery.rgb, livery.a);
  ${CABIN_SIDE}`,
      );
  };
  material.customProgramCacheKey = () => 'drift-body-paint';
  return material;
}

/** Glass with the banner across the top of the windscreen, given the screen's top edge and half its width there. */
export function bannerGlass(glass: MeshStandardMaterial, banner: Texture, screenHalfWidth: number, screenTop: number): MeshStandardMaterial {
  const material = glass.clone();
  const uniforms = {
    bannerMap: { value: banner },
    bannerBox: { value: [screenHalfWidth, screenTop] },
  };
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vCarPos;\nvarying vec3 vCarNormal;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\n${LIVERY_VERTEX}`);
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
uniform sampler2D bannerMap;
uniform vec2 bannerBox;
varying vec3 vCarPos;
varying vec3 vCarNormal;`,
      )
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
  float bannerDepth = bannerBox.y - vCarPos.y;
  if (normalize(vCarNormal).z > 0.25 && bannerDepth < 0.06 && bannerDepth > -0.05) {
    vec4 ink = texture2D(bannerMap, vec2(vCarPos.x / (2.0 * bannerBox.x) + 0.5, 1.0 - max(bannerDepth, 0.0) / 0.06));
    diffuseColor = gl_FrontFacing ? vec4(ink.rgb, 1.0) : vec4(ink.rgb * 0.3, 0.62);
  }`,
      );
  };
  material.customProgramCacheKey = () => 'drift-banner-glass';
  return material;
}

const highest = (points: BodyPoints, test: (x: number, y: number, z: number) => boolean): number => {
  let top = -Infinity;
  for (let i = 0; i < points.length; i += 3) {
    if (test(points[i], points[i + 1], points[i + 2]) && points[i + 1] > top) top = points[i + 1];
  }
  return top;
};

/** The deck at the back of the car, where a wing's posts stand: height at a point along the car. */
function deckHeight(points: BodyPoints, z: number, halfWidth: number): number {
  return highest(points, (x, _y, pz) => Math.abs(pz - z) < 0.06 && Math.abs(x) < halfWidth * 0.55);
}

/** An inverted aerofoil, chord along -z (leading edge forward), as a shape in the z-y plane. */
function aerofoil(chord: number, thickness: number): Shape {
  const shape = new Shape();
  const steps = 14;
  const top: [number, number][] = [];
  const bottom: [number, number][] = [];
  for (let k = 0; k <= steps; k++) {
    const t = k / steps;
    // NACA-style thickness with the camber turned upside down, as on a wing that pushes down.
    const half = 5 * thickness * (0.2969 * Math.sqrt(t) - 0.126 * t - 0.3516 * t * t + 0.2843 * t ** 3 - 0.1036 * t ** 4);
    const camber = -0.06 * Math.sin(Math.PI * t) * 0.5;
    top.push([t * chord, (camber + half) * chord]);
    bottom.push([t * chord, (camber - half) * chord]);
  }
  shape.moveTo(...top[0]);
  top.slice(1).forEach((p) => shape.lineTo(...p));
  bottom.reverse().forEach((p) => shape.lineTo(...p));
  shape.closePath();
  return shape;
}

/** Wing, front lip and tow straps, fitted to the body. Everything is in car space. */
export function aeroParts(id: string, points: BodyPoints, box: CarBox, materials: { carbon: Material; red: Material }): Group {
  const look = driftLookOf(id);
  const parts = new Group();

  if (look.wing) {
    const { posts, chord, span, plates } = look.wing;
    const mountZ = box.rear + 0.22;
    const deck = deckHeight(points, mountZ, box.halfWidth);
    if (Number.isFinite(deck)) {
      const wingSpan = box.halfWidth * 2 * span;
      const plane = new ExtrudeGeometry(aerofoil(chord, 0.12), { depth: wingSpan, bevelEnabled: false, curveSegments: 1 });
      // Shape x runs back along the car, shape y up, and the extrusion across it.
      plane.rotateY(Math.PI / 2);
      plane.translate(-wingSpan / 2, 0, 0);
      const wing = new Mesh(plane, materials.carbon);
      // Leading edge forward of the posts, trailing edge kicked up.
      wing.rotation.x = 0.14;
      wing.position.set(0, deck + posts, mountZ + chord * 0.55);
      wing.castShadow = true;
      parts.add(wing);
      if (posts > 0.08) {
        for (const x of [-0.42, 0.42]) {
          const post = new Mesh(new BoxGeometry(0.025, posts + 0.03, 0.13), materials.carbon);
          post.position.set(x * box.halfWidth * 1.25, deck + posts / 2 - 0.01, mountZ + 0.05);
          parts.add(post);
        }
      } else {
        // A low spoiler sits on a riser rather than posts.
        const riser = new Mesh(new BoxGeometry(wingSpan * 0.96, posts + 0.02, 0.05), materials.carbon);
        riser.position.set(0, deck + posts / 2, mountZ + 0.06);
        parts.add(riser);
      }
      if (plates) {
        for (const side of [-1, 1]) {
          const plate = new Mesh(new BoxGeometry(0.012, 0.2, chord * 1.25), materials.carbon);
          plate.position.set((side * wingSpan) / 2, deck + posts + 0.01, mountZ + chord * 0.45);
          parts.add(plate);
        }
      }
    }
  }

  // Front lip: a plate under the bumper, following its outline, standing a few centimetres proud.
  let bottom = Infinity;
  for (let i = 0; i < points.length; i += 3) {
    if (points[i + 2] > box.front - 0.45 && Math.abs(points[i]) < box.halfWidth * 0.8) bottom = Math.min(bottom, points[i + 1]);
  }
  if (Number.isFinite(bottom)) {
    const slices = 17;
    const outline: [number, number][] = [];
    for (let k = 0; k < slices; k++) {
      const x = (k / (slices - 1) - 0.5) * 2 * box.halfWidth * 0.9;
      let edge = -Infinity;
      for (let i = 0; i < points.length; i += 3) {
        if (Math.abs(points[i] - x) < 0.06 && points[i + 1] < bottom + 0.1 && points[i + 2] > box.front - 0.6) edge = Math.max(edge, points[i + 2]);
      }
      if (Number.isFinite(edge)) outline.push([x, edge]);
    }
    if (outline.length > 4) {
      const lip = new Shape();
      outline.forEach(([x, z], k) => (k ? lip.lineTo(x, z + 0.05) : lip.moveTo(x, z + 0.05)));
      for (let k = outline.length - 1; k >= 0; k--) lip.lineTo(outline[k][0], outline[k][1] - 0.22);
      lip.closePath();
      const plate = new ExtrudeGeometry(lip, { depth: 0.014, bevelEnabled: false, curveSegments: 1 });
      // Shape x across, shape y along the car; extruded downwards.
      plate.rotateX(Math.PI / 2);
      const mesh = new Mesh(plate, materials.carbon);
      mesh.position.y = bottom + 0.012;
      parts.add(mesh);

      // A red tow strap off-centre at the front, and one at the back.
      const front = new Mesh(new BoxGeometry(0.035, 0.012, 0.13), materials.red);
      front.position.set(-box.halfWidth * 0.42, bottom + 0.05, outline[Math.floor(outline.length * 0.29)][1] + 0.02);
      front.rotation.x = 0.5;
      parts.add(front);
    }
  }
  let tail = Infinity;
  for (let i = 0; i < points.length; i += 3) {
    if (points[i + 2] < box.rear + 0.4 && Math.abs(points[i]) < box.halfWidth * 0.8) tail = Math.min(tail, points[i + 1]);
  }
  if (Number.isFinite(tail)) {
    const strap = new Mesh(new BoxGeometry(0.035, 0.012, 0.13), materials.red);
    strap.position.set(box.halfWidth * 0.38, tail + 0.06, box.rear + 0.02);
    strap.rotation.x = -0.5;
    parts.add(strap);
  }
  return parts;
}

/** Wheel and cage finishes for the drift look. */
export function driftFinishes(id: string): { rim: MeshStandardMaterial; cage: MeshStandardMaterial } {
  const look = driftLookOf(id);
  const [colour, metalness, roughness] = look.rim;
  return {
    rim: new MeshStandardMaterial({ color: colour, metalness, roughness }),
    cage: new MeshStandardMaterial({ color: look.cage, roughness: 0.45, metalness: 0.2 }),
  };
}

/** Camber in radians for a wheel, by axle and side: the top of the wheel leans in. */
export function camberOf(id: string, wheel: number, sideX: number): number {
  const [front, rear] = driftLookOf(id).camber;
  const degrees = wheel < 2 ? front : rear;
  return clamp(-degrees, 0, 12) * (Math.PI / 180) * Math.sign(sideX || 1);
}
