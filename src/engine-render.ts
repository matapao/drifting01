// Renders a car's engine sounds with the engine model: seamless loops across the rev range on and off the throttle,
// a few exhaust pops, and the starter catching. Runs in a worker when a car is picked; no DOM here either.

import { type Drive, EngineModel, type EngineSpec, random, SYNTH_RATE } from './engine-synth';

export interface EngineLoop {
  rpm: number;
  /** The exhaust, and the engine bay: intake, valve gear and the block. */
  exhaust: Float32Array;
  bay: Float32Array;
}

export interface EngineBank {
  rate: number;
  /** Loops at these revs, under full load and on a shut throttle (idling lightly at the bottom, fuel cut above). */
  on: EngineLoop[];
  off: EngineLoop[];
  /** Single bangs in the exhaust, from a crack to a deep double thump. */
  pops: Float32Array[];
  /** Cranking, catching and settling to idle, as exhaust and engine bay. */
  starter: [Float32Array, Float32Array];
  /** Seconds into the starter when the engine catches. */
  catchAt: number;
}

/** The revs to loop at: close together low down, where the sound changes fastest, then every 500 rpm. */
export function loopRevs(spec: EngineSpec): number[] {
  const revs = [Math.round(spec.idle * 0.85), spec.idle, 1250, 1600, 2000];
  for (let rpm = 2500; rpm <= spec.redline + 500; rpm += 500) revs.push(rpm);
  return revs;
}

/** Boost the turbo can make at these revs with the throttle open, 0 to 1, as the physics has it. */
const boostAt = (rpm: number) => Math.min(1, Math.max(0, (rpm - 1800) / 2200));

/** The engine at these revs: full load, or the throttle shut. */
function driveAt(spec: EngineSpec, rpm: number, on: boolean): Drive {
  if (on) return { rpm, load: spec.turbo ? 1 + 0.45 * boostAt(rpm) : 1, burn: 1, throttle: 1 };
  // Shut throttle: near idle it still burns a little to keep running; above, the fuel is cut on the overrun.
  const idling = Math.max(0, Math.min(1, (spec.idle * 1.8 - rpm) / (spec.idle * 0.8)));
  return { rpm, load: 0.14 + 0.08 * idling, burn: idling, throttle: 0.03 };
}

/**
 * One loop of whole engine cycles, about half a second long (nearer a second at idle, where a short loop's
 * repeating lope would show). The variation repeats with the loop, and it's taken after a run-up long enough for
 * the pipes to settle, so the end joins the start without a seam.
 */
export function renderLoop(spec: EngineSpec, revs: number, on: boolean, seed: number): EngineLoop {
  const seconds = revs < 1400 ? 0.9 : 0.5;
  const cycles = Math.max(2, Math.round((seconds * revs) / 120));
  const length = Math.round((cycles * 120 * SYNTH_RATE) / revs);
  const rpm = (cycles * 120 * SYNTH_RATE) / length;
  const model = new EngineModel(spec);
  model.periodic(cycles, length, seed);
  const drive = driveAt(spec, rpm, on);
  const runUp = Math.max(1, Math.ceil((0.25 * SYNTH_RATE) / length));
  const scratch = [new Float32Array(length), new Float32Array(length)];
  for (let k = 0; k < runUp; k++) model.run(scratch[0], scratch[1], 0, length, drive);
  const loop = { rpm, exhaust: new Float32Array(length), bay: new Float32Array(length) };
  model.run(loop.exhaust, loop.bay, 0, length, drive);
  return loop;
}

/** A bang in the exhaust: fuel lighting in the hot pipe. `sharpness` in samples to the peak; a second, smaller one. */
function renderPop(spec: EngineSpec, sharpness: number, second: number, seed: number): Float32Array {
  const length = Math.round(SYNTH_RATE * 0.35);
  const inject = new Float32Array(length);
  const r = random(seed);
  const bang = (at: number, size: number) => {
    for (let i = 0; at + i < length && i < sharpness * 30; i++) {
      const t = i / sharpness;
      inject[at + i] += size * (t * Math.exp(1 - t) + 0.35 * (r() * 2 - 1) * Math.exp(-i / (SYNTH_RATE * 0.004)));
    }
  };
  bang(40, 1);
  if (second) bang(40 + Math.round(second * SYNTH_RATE), 0.55);
  const model = new EngineModel(spec);
  const exhaust = new Float32Array(length);
  const bay = new Float32Array(length);
  // Revs 0: the engine itself is silent, only the pipes ring.
  model.run(exhaust, bay, 0, length, { rpm: 0, load: 0, burn: 0, throttle: 0 }, inject);
  return exhaust;
}

/**
 * The starter cranking at about 200 rpm, each compression stroke slowing it, until the engine catches, flares to
 * about 1700 rpm and settles to idle. The starter motor's gear whine goes in the engine bay.
 */
function renderStarter(spec: EngineSpec): { out: [Float32Array, Float32Array]; catchAt: number } {
  const catchAt = 0.75;
  const length = Math.round(SYNTH_RATE * 2.4);
  const out: [Float32Array, Float32Array] = [new Float32Array(length), new Float32Array(length)];
  const model = new EngineModel(spec);
  model.periodic(64, SYNTH_RATE, 7);
  const block = 64;
  let cyclePhase = 0;
  let gearPhase = 0;
  const r = random(11);
  for (let at = 0; at < length; at += block) {
    const t = at / SYNTH_RATE;
    const count = Math.min(block, length - at);
    let rpm: number;
    let burn = 0;
    if (t < catchAt) {
      // Compression strokes, one per cylinder per cycle, each slowing the crank.
      rpm = 205 * (1 + 0.25 * Math.sin(2 * Math.PI * cyclePhase * model.n));
    } else {
      const since = t - catchAt;
      burn = Math.min(1, since / 0.12);
      const flare = since < 0.28 ? 205 + (1700 - 205) * (since / 0.28) ** 0.7 : spec.idle + (1700 - spec.idle) * Math.exp(-(since - 0.28) / 0.35);
      rpm = flare;
    }
    cyclePhase = (cyclePhase + (rpm / 120) * (count / SYNTH_RATE)) % 1;
    model.run(out[0], out[1], at, count, { rpm, load: t < catchAt ? 0.1 : 0.3, burn, throttle: t < catchAt ? 0.02 : 0.15 });
    // The starter: ring gear teeth meshing with the pinion, until it lets go just after the catch and spins down.
    const engaged = t < catchAt + 0.08;
    const spinDown = engaged ? 1 : Math.exp(-(t - catchAt - 0.08) / 0.12);
    const mesh = engaged ? (rpm / 60) * 120 : (205 / 60) * 120 * (1 + 0.6 * (1 - spinDown));
    for (let i = 0; i < count; i++) {
      gearPhase += mesh / SYNTH_RATE;
      const ramp = Math.min(1, (at + i) / (SYNTH_RATE * 0.05));
      const whine = Math.sin(2 * Math.PI * gearPhase) + 0.5 * Math.sin(4 * Math.PI * gearPhase) + 0.3 * Math.sin(6 * Math.PI * gearPhase);
      out[1][at + i] += 0.06 * ramp * spinDown * whine * (1 + 0.4 * (r() * 2 - 1));
    }
  }
  return { out, catchAt };
}

/** Scales a set of buffers together so the loudest peak is `peak`. */
function normalise(buffers: Float32Array[], peak: number): void {
  let max = 1e-9;
  for (const b of buffers) for (let i = 0; i < b.length; i++) max = Math.max(max, Math.abs(b[i]));
  const scale = peak / max;
  for (const b of buffers) for (let i = 0; i < b.length; i++) b[i] *= scale;
}

export function renderBank(spec: EngineSpec): EngineBank {
  const revs = loopRevs(spec);
  const on = revs.map((rpm, i) => renderLoop(spec, rpm, true, 101 + i));
  const off = revs.map((rpm, i) => renderLoop(spec, rpm, false, 301 + i));
  const pops = [
    renderPop(spec, 5, 0, 1),
    renderPop(spec, 8, 0.035, 2),
    renderPop(spec, 12, 0, 3),
    renderPop(spec, 18, 0.05, 4),
  ];
  const starter = renderStarter(spec);
  // The loops keep their natural levels against each other: one scale for all the exhausts, one for the bays.
  const exhausts = [...on, ...off].map((l) => l.exhaust);
  const bays = [...on, ...off].map((l) => l.bay);
  const exhaustScale = peakOf(on.map((l) => l.exhaust));
  const bayScale = peakOf(on.map((l) => l.bay));
  scaleBy(exhausts, 0.5 / exhaustScale);
  scaleBy(bays, 0.5 / bayScale);
  scaleBy([starter.out[0]], 0.5 / exhaustScale);
  scaleBy([starter.out[1]], 0.5 / bayScale);
  normalise(pops, 0.8);
  return { rate: SYNTH_RATE, on, off, pops, starter: starter.out, catchAt: starter.catchAt };
}

function peakOf(buffers: Float32Array[]): number {
  let max = 1e-9;
  for (const b of buffers) for (let i = 0; i < b.length; i++) max = Math.max(max, Math.abs(b[i]));
  return max;
}

function scaleBy(buffers: Float32Array[], scale: number): void {
  for (const b of buffers) for (let i = 0; i < b.length; i++) b[i] *= scale;
}
