// Everything the car sounds like. The engine plays loops rendered from a model of each car's engine and exhaust
// (engine-synth.ts), crossfaded by revs and load; turbo, gearbox, tyres, ground, wind and impacts are synthesised
// live on top, and the mix shifts with the camera: exhaust behind the car, intake and turbo from the cabin.

import { type CameraName, cameraName } from './camera';
import { type EngineBank, renderBank } from './engine-render';
import { carSound, type CarSound } from './engine-sounds';
import { clamp, lerp } from './math';
import { CAR } from './physics';
import { app, car, type HitKind, options } from './state';

declare global {
  interface Window {
    webkitAudioContext?: typeof AudioContext;
  }
}

/** How loud each part is from each camera, and how dull: a lowpass in Hz on the exhaust and the engine bay. */
interface Mix {
  level: number;
  exhaust: number;
  exhaustTone: number;
  /** Cabin boom on the exhaust, dB at 90 Hz. */
  boom: number;
  bay: number;
  bayTone: number;
  turbo: number;
  tyres: number;
  tyreTone: number;
  ground: number;
  wind: number;
  gears: number;
}

const MIXES: Record<CameraName, Mix> = {
  Chase: { level: 1, exhaust: 1, exhaustTone: 14000, boom: 0, bay: 0.45, bayTone: 5000, turbo: 0.55, tyres: 1, tyreTone: 9000, ground: 1, wind: 0.5, gears: 0.4 },
  'Far chase': { level: 0.85, exhaust: 0.9, exhaustTone: 8000, boom: 0, bay: 0.32, bayTone: 3500, turbo: 0.4, tyres: 0.85, tyreTone: 6500, ground: 0.8, wind: 0.4, gears: 0.25 },
  // Inside: the exhaust comes through the body, dull and boomy; intake, turbo and gearbox are right there.
  Inside: { level: 0.95, exhaust: 0.6, exhaustTone: 1500, boom: 7, bay: 0.95, bayTone: 4200, turbo: 0.9, tyres: 0.5, tyreTone: 2600, ground: 0.7, wind: 0.3, gears: 1 },
  // On the bonnet: over the intake and the turbo, the exhaust out of the way behind.
  Bonnet: { level: 1, exhaust: 0.5, exhaustTone: 2600, boom: 2, bay: 1.15, bayTone: 9000, turbo: 1, tyres: 0.75, tyreTone: 5000, ground: 0.8, wind: 0.75, gears: 0.6 },
  Overhead: { level: 0.7, exhaust: 0.8, exhaustTone: 5000, boom: 0, bay: 0.3, bayTone: 2500, turbo: 0.3, tyres: 0.75, tyreTone: 4500, ground: 0.6, wind: 0.15, gears: 0.15 },
};

/** The overrun is far quieter than full throttle; brought up so lifting doesn't sound like the engine stopped. */
const OFF_LOAD_GAIN = 2.4;
/** A voice nobody has needed for this long is stopped. */
const VOICE_LINGER = 0.3;

interface Voice {
  source: AudioBufferSourceNode;
  gain: GainNode;
  loopRpm: number;
  quietSince: number;
}

interface Engine {
  id: string;
  sound: CarSound;
  bank: EngineBank | null;
  on: AudioBuffer[];
  off: AudioBuffer[];
  pops: AudioBuffer[];
  starter: AudioBuffer | null;
}

interface Graph {
  ctx: BaseAudioContext;
  master: GainNode;
  /** Loops and the starter go in here and are split: exhaust on channel 0, engine bay on channel 1. */
  engineIn: GainNode;
  exhaust: GainNode;
  boom: BiquadFilterNode;
  exhaustTone: BiquadFilterNode;
  bay: GainNode;
  bayTone: BiquadFilterNode;
  /** Pops join the exhaust after its level, so the camera still shapes them. */
  popIn: GainNode;
  wastegate: GainNode;
  /** Old two-oscillator engine, heard only until a car's loops are ready. */
  standIn: { gain: GainNode; saw: OscillatorNode; sub: OscillatorNode; tone: BiquadFilterNode };
  turbo: GainNode;
  whistle: { gain: GainNode; a: OscillatorNode; b: OscillatorNode; air: BiquadFilterNode; airGain: GainNode };
  whoosh: { gain: GainNode; filter: BiquadFilterNode };
  gears: GainNode;
  whine: { gain: GainNode; a: OscillatorNode; b: OscillatorNode };
  tyres: GainNode;
  tyreTone: BiquadFilterNode;
  axles: Axle[];
  ground: GainNode;
  gravel: { gain: GainNode; crunch: AudioBufferSourceNode; crunchGain: GainNode };
  grass: { gain: GainNode; filter: BiquadFilterNode };
  kerb: { gain: GainNode; osc: OscillatorNode };
  wind: { gain: GainNode; filter: BiquadFilterNode };
  scrape: { gain: GainNode; a: BiquadFilterNode; b: BiquadFilterNode; kind: HitKind | null };
  impacts: GainNode;
  noise: AudioBuffer;
  ping: AudioBuffer;
}

/** One axle's tyres: a narrow-band squeal with a tone in it, and a broadband roar for big slides and wheelspin. */
interface Axle {
  squeal: GainNode;
  bandA: BiquadFilterNode;
  bandB: BiquadFilterNode;
  tone: OscillatorNode;
  toneGain: GainNode;
  roar: GainNode;
  roarFilter: BiquadFilterNode;
}

let ctx: AudioContext | null = null;
let graph: Graph | null = null;
let engine: Engine | null = null;
let worker: Worker | null = null;
const voices = new Map<string, Voice>();

// What happened last frame, to catch changes.
let lastThrottle = 0;
let peakThrottle = 0;
let peakAt = 0;
let lastGear = 1;
let lastCut = false;
let shaft = 0;
let lastVent = -1;
let lastLimiterPop = -1;
let starterPending = true;
let starterSource: AudioBufferSourceNode | null = null;
let starterGain: GainNode | null = null;
/** Until then the loops stay down and the starter does the talking. */
let holdLoopsUntil = 0;
const scheduledPops: AudioBufferSourceNode[] = [];
let wobble = 0;

/** Starts rendering a car's engine as soon as it's picked, so it's ready by the time the car drives. */
export function prepareEngine(id: string): void {
  if (engine?.id === id) return;
  const sound = carSound(id);
  engine = { id, sound, bank: null, on: [], off: [], pops: [], starter: null };
  starterPending = true;
  stopVoices();
  const accept = (bankId: string, bank: EngineBank) => {
    if (engine?.id !== bankId) return;
    engine.bank = bank;
    if (graph) buildBuffers(graph.ctx);
  };
  const renderHere = () => setTimeout(() => accept(id, renderBank(sound.engine)), 30);
  try {
    worker ??= new Worker(new URL('./engine-worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<{ id: string; bank: EngineBank }>) => accept(event.data.id, event.data.bank);
    worker.onerror = () => {
      worker = null;
      renderHere();
    };
    worker.postMessage({ id });
  } catch {
    renderHere();
  }
}

function buildBuffers(context: BaseAudioContext): void {
  const bank = engine?.bank;
  if (!engine || !bank) return;
  // getChannelData().set rather than copyToChannel, which older Safari lacks.
  const stereo = (a: Float32Array, b: Float32Array) => {
    const buffer = context.createBuffer(2, a.length, bank.rate);
    buffer.getChannelData(0).set(a);
    buffer.getChannelData(1).set(b);
    return buffer;
  };
  engine.on = bank.on.map((loop) => stereo(loop.exhaust, loop.bay));
  engine.off = bank.off.map((loop) => stereo(loop.exhaust, loop.bay));
  engine.pops = bank.pops.map((pop) => {
    const buffer = context.createBuffer(1, pop.length, bank.rate);
    buffer.getChannelData(0).set(pop);
    return buffer;
  });
  engine.starter = stereo(bank.starter[0], bank.starter[1]);
}

/** Builds the synth on first use (it has to follow a user gesture) and resumes it after that. */
export function startAudio(): void {
  if (ctx) {
    void ctx.resume();
    return;
  }
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext!)();
  } catch {
    return;
  }
  attachAudio(ctx);
}

/** Builds the whole graph on a context. startAudio makes a real one; a test can pass an offline one. */
export function attachAudio(context: BaseAudioContext): void {
  graph = buildGraph(context);
  if (engine?.bank) buildBuffers(context);
  applySoundOption();
}

export function suspendAudio(): void {
  void ctx?.suspend();
}

export function applySoundOption(): void {
  if (graph) graph.master.gain.setTargetAtTime(options.sound ? 0.9 : 0, graph.ctx.currentTime, 0.05);
}

function buildGraph(c: BaseAudioContext): Graph {
  const gain = (value = 0, to?: AudioNode) => {
    const g = c.createGain();
    g.gain.value = value;
    if (to) g.connect(to);
    return g;
  };
  const filter = (type: BiquadFilterType, frequency: number, q = 0.7, to?: AudioNode) => {
    const f = c.createBiquadFilter();
    f.type = type;
    f.frequency.value = frequency;
    f.Q.value = q;
    if (to) f.connect(to);
    return f;
  };
  const oscillator = (type: OscillatorType, to: AudioNode) => {
    const o = c.createOscillator();
    o.type = type;
    o.connect(to);
    o.start();
    return o;
  };

  // Two seconds of white noise, shared by every noisy sound, each starting somewhere else in it.
  const noise = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
  const noiseData = noise.getChannelData(0);
  for (let i = 0; i < noiseData.length; i++) noiseData[i] = Math.random() * 2 - 1;
  const noiseFrom = (offset: number) => {
    const source = c.createBufferSource();
    source.buffer = noise;
    source.loop = true;
    source.start(0, offset);
    return source;
  };

  const compressor = c.createDynamicsCompressor();
  // Holds the loudest moments (a bang on the limiter with a wall hit) under full scale.
  compressor.threshold.value = -9;
  compressor.knee.value = 6;
  compressor.ratio.value = 10;
  compressor.attack.value = 0.002;
  compressor.release.value = 0.2;
  compressor.connect(c.destination);
  const master = gain(options.sound ? 0.9 : 0, compressor);

  // Engine: loops split into exhaust and engine bay, each shaped by the camera. Below 45 Hz an idle is all
  // thump no speaker plays, which only eats headroom.
  const engineOut = gain(0.85, filter('highpass', 45, 0.7, master));
  const exhaustTone = filter('lowpass', 14000, 0.6, engineOut);
  const boom = c.createBiquadFilter();
  boom.type = 'peaking';
  boom.frequency.value = 90;
  boom.Q.value = 0.9;
  boom.gain.value = 0;
  boom.connect(exhaustTone);
  const exhaust = gain(1, boom);
  const popIn = gain(1, boom);
  const bayTone = filter('lowpass', 5000, 0.6, engineOut);
  const bay = gain(0.45, bayTone);
  const split = c.createChannelSplitter(2);
  split.connect(exhaust, 0);
  split.connect(bay, 1);
  const engineIn = gain(1, split);

  // A wastegate screamer pipe dumps exhaust straight out, unsilenced: the exhaust note, rasped up.
  const wastegate = gain(0, master);
  const shaper = c.createWaveShaper();
  const curve = new Float32Array(512);
  for (let i = 0; i < curve.length; i++) curve[i] = Math.tanh((i / 256 - 1) * 3);
  shaper.curve = curve;
  shaper.connect(wastegate);
  exhaust.connect(filter('highpass', 650, 0.7, shaper));

  const standInTone = filter('lowpass', 900, 2.5, engineIn);
  const standInGain = gain(0, standInTone);
  const standIn = { gain: standInGain, saw: oscillator('sawtooth', standInGain), sub: oscillator('square', gain(0.35, standInGain)), tone: standInTone };

  // Turbo: the compressor's whistle (a tone and a band of air round it) and the rush of intake air.
  const turbo = gain(0.55, master);
  const whistleGain = gain(0, turbo);
  const whistle = {
    gain: whistleGain,
    a: oscillator('sine', whistleGain),
    b: oscillator('sine', whistleGain),
    air: filter('bandpass', 3000, 9),
    airGain: gain(0, turbo),
  };
  whistle.air.connect(whistle.airGain);
  noiseFrom(0.31).connect(whistle.air);
  const whooshGain = gain(0, turbo);
  const whoosh = { gain: whooshGain, filter: filter('bandpass', 1800, 0.8, whooshGain) };
  noiseFrom(0.77).connect(whoosh.filter);

  // Straight-cut gears whine with the revs.
  const gears = gain(0.4, master);
  const whineGain = gain(0, gears);
  const whine = { gain: whineGain, a: oscillator('triangle', whineGain), b: oscillator('triangle', whineGain) };

  // Tyres, front and rear.
  const tyreTone = filter('lowpass', 9000, 0.6, master);
  const tyres = gain(1, tyreTone);
  const tyreNoise = noiseFrom(0.05);
  const axles: Axle[] = [0, 1].map((k) => {
    const squeal = gain(0, tyres);
    const bandA = filter('bandpass', 1100, 18, squeal);
    const bandB = filter('bandpass', 1650, 11, squeal);
    const toneGain = gain(0, squeal);
    const tone = oscillator('sine', toneGain);
    const roar = gain(0, tyres);
    const roarFilter = filter('bandpass', 1500, 0.6, roar);
    const source = k ? noiseFrom(1.13) : tyreNoise;
    source.connect(bandA);
    source.connect(bandB);
    source.connect(roarFilter);
    return { squeal, bandA, bandB, tone, toneGain, roar, roarFilter };
  });

  // Ground: gravel crunch and stones, grass swishing, the kerb drumming under the tyres.
  const ground = gain(1, master);
  const gravelGain = gain(0, ground);
  noiseFrom(0.53).connect(filter('bandpass', 2600, 0.6, gravelGain));
  const crunchGain = gain(0, ground);
  const crunch = c.createBufferSource();
  crunch.buffer = grains(c);
  crunch.loop = true;
  crunch.connect(filter('lowpass', 5000, 0.5, crunchGain));
  crunch.start();
  const grassGain = gain(0, ground);
  const grassFilter = filter('lowpass', 700, 0.5, grassGain);
  noiseFrom(1.41).connect(grassFilter);
  const kerbGain = gain(0, ground);
  const kerbOsc = oscillator('square', filter('lowpass', 180, 0.8, kerbGain));

  const windGain = gain(0, master);
  const windFilter = filter('lowpass', 400, 0.5, windGain);
  noiseFrom(0.97).connect(windFilter);

  const scrapeGain = gain(0, master);
  const scrapeA = filter('bandpass', 3200, 3, scrapeGain);
  const scrapeB = filter('bandpass', 5100, 4, scrapeGain);
  const scrapeNoise = noiseFrom(1.67);
  scrapeNoise.connect(scrapeA);
  scrapeNoise.connect(scrapeB);

  const impacts = gain(0.55, master);

  return {
    ctx: c,
    master,
    engineIn,
    exhaust,
    boom,
    exhaustTone,
    bay,
    bayTone,
    popIn,
    wastegate,
    standIn,
    turbo,
    whistle,
    whoosh,
    gears,
    whine,
    tyres,
    tyreTone,
    axles,
    ground,
    gravel: { gain: gravelGain, crunch, crunchGain },
    grass: { gain: grassGain, filter: grassFilter },
    kerb: { gain: kerbGain, osc: kerbOsc },
    wind: { gain: windGain, filter: windFilter },
    scrape: { gain: scrapeGain, a: scrapeA, b: scrapeB, kind: null },
    impacts,
    noise,
    ping: ping(c),
  };
}

/** Gravel: stones knocking together, as a loop of short random clicks, played faster the faster the car goes. */
function grains(c: BaseAudioContext): AudioBuffer {
  const buffer = c.createBuffer(1, Math.round(c.sampleRate * 1.5), c.sampleRate);
  const data = buffer.getChannelData(0);
  for (let g = 0; g < 260; g++) {
    const at = Math.floor(Math.random() * data.length);
    const size = Math.random() ** 2;
    const decay = c.sampleRate * (0.0008 + Math.random() * 0.003);
    for (let i = 0; i < decay * 5 && at + i < data.length; i++) data[at + i] += size * (Math.random() * 2 - 1) * Math.exp(-i / decay);
  }
  return buffer;
}

/** A stone flicked up against the floor: a short metallic ping. */
function ping(c: BaseAudioContext): AudioBuffer {
  const buffer = c.createBuffer(1, Math.round(c.sampleRate * 0.08), c.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    const t = i / c.sampleRate;
    data[i] = (Math.sin(2 * Math.PI * 3300 * t) + 0.6 * Math.sin(2 * Math.PI * 5150 * t) + 0.3 * Math.sin(2 * Math.PI * 7900 * t)) * Math.exp(-t / 0.012) * 0.5;
  }
  return buffer;
}

function stopVoices(): void {
  for (const voice of voices.values()) {
    try {
      voice.source.stop();
    } catch {
      // Already stopped.
    }
    voice.gain.disconnect();
  }
  voices.clear();
  starterSource?.stop();
  starterSource = null;
}

/** Sets a loop's level and pitch, starting it if it isn't playing. */
function voice(key: string, buffer: AudioBuffer, loopRpm: number, level: number, rpm: number, now: number, fast: boolean): void {
  if (!graph) return;
  let v = voices.get(key);
  if (!v && level > 0.0005) {
    const source = graph.ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.playbackRate.value = rpm / loopRpm;
    const g = graph.ctx.createGain();
    g.gain.value = 0;
    source.connect(g).connect(graph.engineIn);
    // Somewhere new in the loop each time, so two loops in a crossfade don't line up the same way.
    source.start(now, Math.random() * buffer.duration);
    v = { source, gain: g, loopRpm, quietSince: -1 };
    voices.set(key, v);
  }
  if (!v) return;
  v.gain.gain.setTargetAtTime(level, now, fast ? 0.006 : 0.025);
  v.source.playbackRate.setTargetAtTime(rpm / loopRpm, now, 0.012);
  if (level > 0.0005) v.quietSince = -1;
  else if (v.quietSince < 0) v.quietSince = now;
  else if (now - v.quietSince > VOICE_LINGER) {
    v.source.stop();
    v.gain.disconnect();
    voices.delete(key);
  }
}

function playPop(level: number, when: number): void {
  if (!graph || !engine?.pops.length) return;
  const source = graph.ctx.createBufferSource();
  source.buffer = engine.pops[Math.floor(Math.random() * engine.pops.length)];
  source.playbackRate.value = 0.88 + Math.random() * 0.3;
  const g = graph.ctx.createGain();
  g.gain.value = level;
  source.connect(g).connect(graph.popIn);
  source.start(when);
  scheduledPops.push(source);
  source.onended = () => {
    g.disconnect();
    scheduledPops.splice(scheduledPops.indexOf(source), 1);
  };
}

/** Unburnt fuel lighting in the exhaust after a lift from high revs: a string of pops, tailing off. */
function popBurst(strength: number, now: number): void {
  const count = Math.round(strength * (2 + Math.random() * 5));
  let at = now + 0.03 + Math.random() * 0.05;
  for (let k = 0; k < count; k++) {
    playPop(strength * (0.35 + 0.65 * Math.random()) * 0.82 ** k, at);
    at += 0.03 + Math.random() * 0.14;
  }
}

/** A blow-off valve venting: a hiss falling in pitch, with the valve's own chirp at the start. */
function vent(strength: number, now: number): void {
  if (!graph) return;
  const c = graph.ctx;
  const length = 0.22 + strength * 0.45;
  const source = c.createBufferSource();
  source.buffer = graph.noise;
  source.loop = true;
  const band = c.createBiquadFilter();
  band.type = 'bandpass';
  band.Q.value = 1.3;
  band.frequency.setValueAtTime(4300, now);
  band.frequency.exponentialRampToValueAtTime(1500, now + length);
  const g = c.createGain();
  const peak = 0.25 + strength * 0.5;
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(peak, now + 0.01);
  g.gain.exponentialRampToValueAtTime(peak * 0.4, now + length * 0.5);
  g.gain.exponentialRampToValueAtTime(0.0001, now + length);
  source.connect(band).connect(g).connect(graph.turbo);
  source.start(now, Math.random() * 1.5);
  source.stop(now + length);
  const chirp = c.createOscillator();
  chirp.frequency.setValueAtTime(3100, now);
  chirp.frequency.exponentialRampToValueAtTime(1300, now + 0.07);
  const cg = c.createGain();
  cg.gain.setValueAtTime(0.0001, now);
  cg.gain.exponentialRampToValueAtTime(0.06 * strength, now + 0.005);
  cg.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);
  chirp.connect(cg).connect(graph.turbo);
  chirp.start(now);
  chirp.stop(now + 0.09);
}

/**
 * Compressor surge with no blow-off valve: the trapped boost pushes back through the compressor in pulses,
 * fast at first and slowing as the pressure goes ("stu-tu-tu").
 */
function flutter(strength: number, now: number): void {
  if (!graph) return;
  const c = graph.ctx;
  const length = 0.35 + strength * 0.4;
  const steps = Math.round(length * 1000);
  const envelope = new Float32Array(steps);
  let t = 0;
  while (t < length) {
    const rate = 24 - 11 * (t / length);
    const size = (0.5 + 0.5 * Math.random()) * (1 - t / length) ** 1.3;
    for (let i = 0; i < 9 && Math.round((t + i / 1000) * 1000) < steps; i++) {
      envelope[Math.round((t + i / 1000) * 1000)] = size * Math.exp(-i / 3);
    }
    t += 1 / rate;
  }
  const source = c.createBufferSource();
  source.buffer = graph.noise;
  source.loop = true;
  const band = c.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.value = 850 + 250 * strength;
  band.Q.value = 2.2;
  const g = c.createGain();
  g.gain.value = 0;
  g.gain.setValueCurveAtTime(envelope.map((v) => v * (0.5 + 0.6 * strength)), now, length);
  source.connect(band).connect(g).connect(graph.turbo);
  source.start(now, Math.random() * 1.5);
  source.stop(now + length + 0.05);
}

/** A gear change: the dog rings clacking in, or the synchro's softer clunk. */
function clunk(dogBox: boolean, now: number): void {
  if (!graph) return;
  const c = graph.ctx;
  const thump = c.createOscillator();
  thump.frequency.setValueAtTime(110, now);
  thump.frequency.exponentialRampToValueAtTime(55, now + 0.06);
  const tg = c.createGain();
  tg.gain.setValueAtTime(0.0001, now);
  tg.gain.exponentialRampToValueAtTime(dogBox ? 0.35 : 0.2, now + 0.004);
  tg.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
  thump.connect(tg).connect(graph.gears);
  thump.start(now);
  thump.stop(now + 0.1);
  if (dogBox) {
    const source = c.createBufferSource();
    source.buffer = graph.noise;
    const band = c.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 2600;
    band.Q.value = 4;
    const g = c.createGain();
    g.gain.setValueAtTime(0.5, now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.035);
    source.connect(band).connect(g).connect(graph.gears);
    source.start(now, Math.random() * 1.5);
    source.stop(now + 0.04);
  }
}

/** A hit, by what was hit: a guardrail clangs, concrete crunches, tyres thump. `strength` is the closing speed. */
export function playImpact(strength: number, kind: HitKind): void {
  if (!graph || !options.sound) return;
  const c = graph.ctx;
  const now = c.currentTime;
  const level = clamp(strength / 10, 0.12, 1) * 1.6;
  const tone = (freq: number, endFreq: number, gain: number, decay: number) => {
    const o = c.createOscillator();
    o.frequency.setValueAtTime(freq, now);
    o.frequency.exponentialRampToValueAtTime(endFreq, now + decay);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.exponentialRampToValueAtTime(gain * level, now + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, now + decay);
    o.connect(g).connect(graph!.impacts);
    o.start(now);
    o.stop(now + decay + 0.02);
  };
  const burst = (type: BiquadFilterType, freq: number, q: number, gain: number, decay: number, delay = 0) => {
    const source = c.createBufferSource();
    source.buffer = graph!.noise;
    const f = c.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, now + delay);
    g.gain.exponentialRampToValueAtTime(gain * level, now + delay + 0.003);
    g.gain.exponentialRampToValueAtTime(0.0001, now + delay + decay);
    source.connect(f).connect(g).connect(graph!.impacts);
    source.start(now + delay, Math.random() * 1.5);
    source.stop(now + delay + decay + 0.02);
  };
  // The car's own panels, whatever it hits.
  tone(85, 42, 0.45, 0.22);
  burst('bandpass', 1300, 0.9, 0.3 * (kind === 'tyres' ? 0.3 : 1), 0.12);
  if (kind === 'rail') {
    // Steel: a few inharmonic partials ringing on.
    [
      [190, 0.3, 0.9],
      [517, 0.26, 0.6],
      [862, 0.2, 0.45],
      [1371, 0.14, 0.3],
      [2236, 0.09, 0.2],
    ].forEach(([freq, gain, decay]) => tone(freq, freq * 0.995, gain, decay));
  } else if (kind === 'concrete' || kind === 'solid' || kind === 'building') {
    burst('lowpass', 2400, 0.5, 0.5, 0.25);
    tone(55, 35, 0.4, 0.3);
    for (let k = 0; k < 4; k++) burst('bandpass', 2000 + Math.random() * 2500, 2, 0.12, 0.03, 0.05 + Math.random() * 0.3);
  } else {
    // Tyres give: a soft low thump that bounces.
    tone(70, 38, 0.5, 0.3);
    burst('lowpass', 500, 0.6, 0.3, 0.1);
  }
}

/** Per-frame update, from the car's state. */
export function updateAudio(dt: number): void {
  if (!graph) return;
  const g = graph;
  const now = g.ctx.currentTime;
  const playing = app.mode === 'play';
  const mix = MIXES[cameraName()];
  const speed = Math.hypot(car.vx, car.vz);
  const sound = engine?.sound;
  const smooth = (param: AudioParam, value: number, time = 0.05) => param.setTargetAtTime(value, now, time);

  smooth(g.master.gain, options.sound ? 0.9 * mix.level : 0, 0.15);
  smooth(g.exhaust.gain, mix.exhaust, 0.15);
  smooth(g.exhaustTone.frequency, mix.exhaustTone, 0.15);
  smooth(g.boom.gain, mix.boom, 0.15);
  smooth(g.bay.gain, mix.bay * (sound?.engine.intake.itb ? 1.2 : 1), 0.15);
  smooth(g.bayTone.frequency, mix.bayTone, 0.15);
  smooth(g.turbo.gain, mix.turbo, 0.15);
  smooth(g.tyres.gain, mix.tyres, 0.15);
  smooth(g.tyreTone.frequency, mix.tyreTone, 0.15);
  smooth(g.ground.gain, mix.ground, 0.15);
  smooth(g.gears.gain, mix.gears, 0.15);

  const rpm = car.rpm;
  const throttle = playing ? car.throttle : 0;
  const cut = playing && car.cut;
  // What's burning: the throttle, unless the limiter has the fuel cut.
  const load = cut ? 0 : throttle;
  const ready = engine && engine.on.length > 0;

  // The starter, once per car, when it first drives.
  if (playing && starterPending && ready && engine!.starter) {
    starterPending = false;
    const source = g.ctx.createBufferSource();
    source.buffer = engine!.starter;
    starterGain = g.ctx.createGain();
    starterGain.gain.value = 1;
    source.connect(starterGain).connect(g.engineIn);
    source.start(now);
    starterSource = source;
    holdLoopsUntil = now + (engine!.bank?.catchAt ?? 0.75) + 1.1;
  } else if (playing && starterPending && !ready) {
    // Still rendering when the car set off: skip the starter rather than play it under a running engine.
    starterPending = false;
  }
  if (holdLoopsUntil > now && (throttle > 0.25 || speed > 3)) {
    // Moving off already: the engine has caught, let the loops take over now.
    holdLoopsUntil = now;
    starterGain?.gain.setTargetAtTime(0, now, 0.05);
  }
  const held = holdLoopsUntil > now;
  if (!held && starterGain && starterSource) {
    starterGain.gain.setTargetAtTime(0, now, 0.15);
    const source = starterSource;
    starterSource = null;
    source.stop(now + 0.8);
  }

  if (ready) {
    smooth(g.standIn.gain.gain, 0, 0.1);
    const revs = engine!.bank!.on.map((loop) => loop.rpm);
    let k = 0;
    while (k < revs.length - 2 && revs[k + 1] < rpm) k++;
    const f = clamp((rpm - revs[k]) / (revs[k + 1] - revs[k]), 0, 1);
    // Equal-power crossfades: between the two loops either side of the revs, and between on and off load.
    const below = Math.cos((f * Math.PI) / 2);
    const above = Math.sin((f * Math.PI) / 2);
    const on = Math.sin((load * Math.PI) / 2);
    const off = Math.cos((load * Math.PI) / 2) * OFF_LOAD_GAIN;
    // A turbo engine's on-load loops are at full boost; off boost, it's that much quieter.
    const boostShare = CAR.turbo ? clamp(car.boost / Math.max(0.05, clamp((rpm - 1800) / 2200, 0, 1)), 0, 1) : 1;
    const level = held ? 0 : 1;
    const fast = cut !== lastCut;
    for (let i = 0; i < revs.length; i++) {
      const w = i === k ? below : i === k + 1 ? above : 0;
      voice('on' + i, engine!.on[i], revs[i], w * on * (0.7 + 0.3 * boostShare) * level, rpm, now, fast);
      voice('off' + i, engine!.off[i], revs[i], w * off * level, rpm, now, fast);
    }
  } else {
    // The car's loops aren't ready yet: the plain synth stands in.
    const hz = (rpm / 60) * 2;
    smooth(g.standIn.saw.frequency, hz, 0.02);
    smooth(g.standIn.sub.frequency, hz / 2, 0.02);
    smooth(g.standIn.tone.frequency, 500 + throttle * 1800 + rpm * 0.12, 0.04);
    smooth(g.standIn.gain.gain, playing ? 0.05 + throttle * 0.09 : 0.02, 0.05);
  }

  // Pops: after a lift from high revs, now and then on a long overrun, and on the limiter's cuts.
  const pops = sound?.pops ?? 0;
  if (throttle > peakThrottle || now - peakAt > 0.35) {
    peakThrottle = throttle;
    peakAt = now;
  }
  const redline = CAR.redline;
  if (playing && pops > 0 && ready) {
    if (throttle < 0.15 && lastThrottle >= 0.15 && peakThrottle > 0.6 && rpm > redline * 0.5) popBurst(pops * clamp(rpm / redline, 0, 1), now);
    if (throttle < 0.1 && rpm > redline * 0.42 && Math.random() < pops * 2.2 * (rpm / redline) ** 2 * dt) playPop(pops * (0.15 + 0.3 * Math.random()), now);
    // Not on every cut: the limiter bounces 15 to 25 times a second, and the bangs come irregularly.
    if (cut && !lastCut && now - lastLimiterPop > 0.08 && Math.random() < pops * 0.6) {
      lastLimiterPop = now;
      playPop(pops * (0.6 + 0.4 * Math.random()), now + 0.01);
    }
  }
  if (throttle > 0.4) {
    // Back on the throttle: whatever was still to pop won't.
    for (const source of scheduledPops.splice(0)) {
      try {
        source.stop();
      } catch {
        // Already finished.
      }
    }
  }

  // Turbo. The shaft spins up with the boost and keeps spinning a while after the throttle shuts.
  const turbo = sound?.turbo;
  if (turbo && playing) {
    shaft = car.boost > shaft ? car.boost : Math.max(car.boost, shaft * Math.exp(-dt / 1.3));
    wobble += (Math.random() - 0.5) * dt * 4;
    wobble *= Math.exp(-dt * 3);
    const hz = lerp(turbo.whistle[0], turbo.whistle[1], shaft ** 0.8) * (1 + 0.01 * wobble);
    smooth(g.whistle.a.frequency, hz, 0.03);
    smooth(g.whistle.b.frequency, hz * (turbo.twin ? 1.035 : 2.01), 0.03);
    smooth(g.whistle.air.frequency, hz, 0.03);
    smooth(g.whistle.gain.gain, shaft ** 1.5 * (0.012 + 0.02 * throttle), 0.05);
    smooth(g.whistle.airGain.gain, shaft ** 1.5 * (0.05 + 0.08 * throttle), 0.05);
    smooth(g.whoosh.gain.gain, shaft * throttle * clamp(rpm / redline, 0, 1) * 0.07, 0.06);
    smooth(g.whoosh.filter.frequency, 1200 + 1300 * shaft, 0.06);
    // Lifting with boost up: vent it, or let it surge back through the compressor.
    if (throttle < 0.35 && lastThrottle >= 0.35 && car.boost > 0.3 && now - lastVent > 0.6) {
      lastVent = now;
      const strength = clamp(car.boost, 0, 1) * (car.shiftT > 0 ? 0.7 : 1);
      if (turbo.lift === 'vent') vent(strength, now);
      else flutter(strength, now);
    }
    const gate = turbo.screamer ? clamp((car.boost - 0.85) / 0.15, 0, 1) * clamp((throttle - 0.7) / 0.3, 0, 1) : 0;
    smooth(g.wastegate.gain, gate * 0.22 * mix.exhaust, 0.04);
  } else {
    smooth(g.whistle.gain.gain, 0, 0.1);
    smooth(g.whistle.airGain.gain, 0, 0.1);
    smooth(g.whoosh.gain.gain, 0, 0.1);
    smooth(g.wastegate.gain, 0, 0.05);
  }

  // Gearbox: straight-cut gears whine on drive and overrun alike; every change clunks.
  if (sound?.dogBox && playing) {
    const mesh = (rpm / 60) * 23;
    smooth(g.whine.a.frequency, mesh, 0.02);
    smooth(g.whine.b.frequency, mesh * [0.45, 0.61, 0.74, 0.87, 1, 1][clamp(car.gear, 1, 6) - 1], 0.02);
    smooth(g.whine.gain.gain, 0.012 + 0.03 * clamp(rpm / redline, 0, 1), 0.05);
  } else smooth(g.whine.gain.gain, 0, 0.1);
  if (playing && car.gear !== lastGear) clunk(!!sound?.dogBox, now);

  updateTyres(g, now, speed, playing);
  updateGround(g, now, speed, playing, dt);

  lastThrottle = throttle;
  lastGear = car.gear;
  lastCut = cut;
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/**
 * Tyres by how they slip. Just past peak grip a tyre squeals, high and fairly pure; sliding at big angles it
 * screams lower with a roar of scrubbed rubber under it; spinning on the spot or locked, the roar takes over.
 */
function updateTyres(g: Graph, now: number, speed: number, playing: boolean): void {
  const staticLoad = (CAR.m * 9.81) / 4;
  for (let a = 0; a < 2; a++) {
    const axle = g.axles[a];
    const [w0, w1] = a ? [2, 3] : [0, 1];
    const paved = (s: string) => s === 'tarmac' || s === 'kerb';
    const onPaving = (paved(car.surf[w0]) ? 0.5 : 0) + (paved(car.surf[w1]) ? 0.5 : 0);
    const slip = Math.max(car.slip[w0], car.slip[w1]);
    const slide = Math.max(car.slide[w0], car.slide[w1]);
    const load = Math.sqrt(clamp((car.load[w0] + car.load[w1]) / (2 * staticLoad), 0, 2));
    const moving = clamp(slide / 2.5, 0, 1);
    // Spinning on the spot or a wheel locked: slip far past the peak while the car itself is slow.
    const spinning = smoothstep(4, 10, slip) * (1 - clamp(speed / 12, 0, 1));
    const squeal = playing ? smoothstep(0.8, 1.4, slip) * (1 - 0.55 * smoothstep(5, 14, slip)) * moving * load * onPaving : 0;
    const roar = playing ? (smoothstep(1.6, 4, slip) * clamp(slide / 9, 0, 1) + spinning * 0.6) * load * onPaving : 0;
    const pitch = lerp(1450, 980, smoothstep(1, 4, slip)) * (1 + 0.015 * Math.sin(now * (23 + a * 7)) + 0.012 * Math.sin(now * 61));
    axle.bandA.frequency.setTargetAtTime(pitch, now, 0.05);
    axle.bandB.frequency.setTargetAtTime(pitch * 1.52, now, 0.05);
    axle.tone.frequency.setTargetAtTime(pitch, now, 0.05);
    axle.squeal.gain.setTargetAtTime(squeal * (a ? 0.32 : 0.22), now, 0.05);
    axle.toneGain.gain.setTargetAtTime(0.025 * squeal, now, 0.05);
    axle.roar.gain.setTargetAtTime(roar * (a ? 0.11 : 0.06), now, 0.06);
    axle.roarFilter.frequency.setTargetAtTime(lerp(1700, 650, spinning), now, 0.08);
  }
}

/** Gravel, grass, kerbs, wind, and rubbing along a wall. */
function updateGround(g: Graph, now: number, speed: number, playing: boolean, dt: number): void {
  const count = (kind: string) => car.surf.filter((s) => s === kind).length / 4;
  const gravel = playing ? count('gravel') : 0;
  const grass = playing ? count('grass') : 0;
  // Stones fly from spinning wheels too, not just from the car's speed.
  const pace = clamp(Math.max(speed, car.slide[2], car.slide[3]) / 15, 0, 1.5);
  g.gravel.gain.gain.setTargetAtTime(gravel * pace * 0.1, now, 0.06);
  g.gravel.crunchGain.gain.setTargetAtTime(gravel * pace * 0.5, now, 0.06);
  g.gravel.crunch.playbackRate.setTargetAtTime(0.5 + pace * 0.9, now, 0.1);
  if (gravel > 0 && Math.random() < gravel * speed * 0.35 * dt) {
    // A stone off the floor.
    const source = g.ctx.createBufferSource();
    source.buffer = g.ping;
    source.playbackRate.value = 0.7 + Math.random() * 0.8;
    const gain = g.ctx.createGain();
    gain.gain.value = 0.05 + Math.random() * 0.12;
    source.connect(gain).connect(g.ground);
    source.start(now);
  }
  g.grass.gain.gain.setTargetAtTime(grass * pace * 0.22, now, 0.08);
  g.grass.filter.frequency.setTargetAtTime(400 + speed * 30, now, 0.1);
  const kerb = playing ? car.onKerb / 4 : 0;
  g.kerb.osc.frequency.setTargetAtTime(Math.max(5, speed), now, 0.03);
  g.kerb.gain.gain.setTargetAtTime(kerb * clamp(speed / 5, 0, 1) * 0.3, now, 0.04);

  const mix = MIXES[cameraName()];
  g.wind.gain.gain.setTargetAtTime(playing ? (speed / 35) ** 2 * 0.1 * mix.wind : 0, now, 0.2);
  g.wind.filter.frequency.setTargetAtTime(300 + speed * 45, now, 0.2);

  // Rubbing along a wall: steel screeches, concrete grinds, tyres squeak and rub.
  const kind = car.hitKind;
  if (kind !== g.scrape.kind) {
    g.scrape.kind = kind;
    const [a, qa, b, qb] = kind === 'rail' ? [3200, 3, 5100, 4] : kind === 'tyres' ? [320, 1.2, 900, 2] : [1300, 0.8, 2600, 1];
    g.scrape.a.frequency.setValueAtTime(a, now);
    g.scrape.a.Q.setValueAtTime(qa, now);
    g.scrape.b.frequency.setValueAtTime(b, now);
    g.scrape.b.Q.setValueAtTime(qb, now);
  }
  g.scrape.gain.gain.setTargetAtTime(playing ? clamp(car.scrape / 6, 0, 1) * (kind === 'rail' ? 0.22 : 0.4) : 0, now, 0.04);
}
