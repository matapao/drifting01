// A physically informed engine. Each cylinder's exhaust and intake pulses, timed by the firing order, run through
// the pipes they really pass through: headers, collectors, turbines, the main pipe, the muffler and the tailpipe.
// Every pipe is a digital waveguide, a pair of delay lines carrying pressure waves both ways, and where pipes meet
// the waves scatter by the pipes' areas. After Baldan, Lachambre, Delle Monache and Boussard, "Physically informed
// car engine sound synthesis for virtual and augmented environments" (2015), and the Sound Design Toolkit's motor.
//
// No DOM here: a worker renders loops with it when a car is picked.

/** Sample rate of everything rendered here. The engine's sound is all well under 16 kHz. */
export const SYNTH_RATE = 32000;

export interface EngineSpec {
  /** Firing order by cylinder number from 1. Cylinders fire evenly through the 720 degree cycle. */
  firing: number[];
  idle: number;
  redline: number;
  /** Exhaust valve opening and intake valve closing, crank degrees after firing TDC; valve overlap round TDC. */
  evo: number;
  ivc: number;
  overlap: number;
  /** Header primary length for each cylinder by number, and which cylinders share each collector. */
  primaries: number[];
  groups: number[][];
  /** From each collector to where the groups merge. 0 merges at the collectors. */
  secondary: number;
  /** A turbine after each collector (twin turbo) or one after the merge, and how much of each pulse it passes. */
  turbo?: { perGroup: boolean; keep: number };
  /** Downpipe after the turbine (if any), then the main pipe, the muffler and the tailpipe, in metres. */
  downpipe: number;
  pipe: number;
  /** Muffler chamber length, its area against the pipe's, and how much its packing soaks up, 0 to 1. */
  muffler: { length: number; ratio: number; packing: number };
  tail: number;
  /** Intake runner length; individual throttle bodies breathe straight from the airbox, so they're loud. */
  intake: { runner: number; itb: boolean; level: number };
  /** Cycle to cycle variation of the burn at idle and at full load; the idle's lope from long-duration cams. */
  jitter: [idle: number, load: number];
  lope: number;
  /** Valvetrain tick, 0 to 1. */
  tick: number;
}

/** Hot gas in the headers, cooler further down, near ambient in the intake. */
const C_HEADER = 610;
const C_PIPE = 520;
const C_TAIL = 470;
const C_INTAKE = 355;

/** A seeded random stream, so a loop renders the same every time. */
export function random(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

/** A pipe: pressure waves each way, delayed by the pipe's length and dulled by its walls. */
class Pipe {
  private readonly a: Float32Array;
  private readonly b: Float32Array;
  private readonly n: number;
  private i = 0;
  private la = 0;
  private lb = 0;
  private readonly k: number;
  private readonly g: number;
  /** Waves arriving at the downstream and the upstream end this sample. */
  atEnd = 0;
  atStart = 0;
  /** Waves leaving the upstream end (going down the pipe) and the downstream end (coming back up). */
  intoStart = 0;
  intoEnd = 0;

  constructor(length: number, c: number, cutoff = 7000, loss = 0.04) {
    this.n = Math.max(2, Math.round((length / c) * SYNTH_RATE));
    this.a = new Float32Array(this.n);
    this.b = new Float32Array(this.n);
    this.k = 1 - Math.exp((-2 * Math.PI * cutoff) / SYNTH_RATE);
    this.g = Math.exp(-loss * length);
  }

  arrive(): void {
    this.la += this.k * (this.a[this.i] - this.la);
    this.lb += this.k * (this.b[this.i] - this.lb);
    this.atEnd = this.la * this.g;
    this.atStart = this.lb * this.g;
  }

  step(): void {
    this.a[this.i] = this.intoStart;
    this.b[this.i] = this.intoEnd;
    if (++this.i === this.n) this.i = 0;
  }
}

/** One end of a pipe where it meets something. */
interface Port {
  pipe: Pipe;
  /** True for the pipe's upstream end. */
  start: boolean;
  /** Admittance, by the pipe's area. */
  y: number;
}

const arriving = (p: Port) => (p.start ? p.pipe.atStart : p.pipe.atEnd);
const send = (p: Port, v: number) => {
  if (p.start) p.pipe.intoStart = v;
  else p.pipe.intoEnd = v;
};

/** Pipes meeting at a point: the pressure there is shared, and each pipe gets back the difference. */
class Junction {
  private readonly ports: Port[];
  private readonly sumY: number;
  constructor(ports: Port[]) {
    this.ports = ports;
    this.sumY = ports.reduce((s, p) => s + p.y, 0);
  }
  scatter(): void {
    let sum = 0;
    for (const p of this.ports) sum += p.y * arriving(p);
    const shared = (2 * sum) / this.sumY;
    for (const p of this.ports) send(p, shared - arriving(p));
  }
}

/** A turbine: a restriction that reflects much of each pulse, takes energy out of it and smooths what passes. */
class Turbine {
  private lp = 0;
  private readonly k = 1 - Math.exp((-2 * Math.PI * 1700) / SYNTH_RATE);
  private readonly up: Port;
  private readonly down: Port;
  private readonly keep: number;
  constructor(up: Port, down: Port, keep: number) {
    this.up = up;
    this.down = down;
    this.keep = keep;
  }
  scatter(): void {
    const u = arriving(this.up);
    const d = arriving(this.down);
    this.lp += this.k * (u - this.lp);
    send(this.up, 0.5 * u + 0.2 * d);
    send(this.down, this.keep * this.lp + 0.3 * d);
  }
}

/** An open pipe end: low notes reflect back inverted, high ones get out. Returns what radiates. */
class OpenEnd {
  private lp = 0;
  private flow = 0;
  private readonly k: number;
  private readonly port: Port;
  constructor(port: Port, cutoff: number) {
    this.port = port;
    this.k = 1 - Math.exp((-2 * Math.PI * cutoff) / SYNTH_RATE);
  }
  scatter(): number {
    const p = arriving(this.port);
    this.lp += this.k * (p - this.lp);
    const back = -0.96 * this.lp;
    send(this.port, back);
    // Sound radiates with the rate of change of the flow out of the end; heard close to the car, the low end is
    // stronger than that alone, so this only tilts the spectrum up rather than differentiating outright.
    const flow = p - back;
    const out = flow - 0.85 * this.flow;
    this.flow = flow;
    return out;
  }
}

/** A two-pole resonance with unit gain at its peak, rung by impulses: valve gear, and the block. */
class Resonator {
  private y1 = 0;
  private y2 = 0;
  private readonly a1: number;
  private readonly a2: number;
  private readonly g: number;
  constructor(freq: number, q: number) {
    const r = Math.exp((-Math.PI * freq) / (q * SYNTH_RATE));
    const w = (2 * Math.PI * freq) / SYNTH_RATE;
    this.a1 = 2 * r * Math.cos(w);
    this.a2 = -r * r;
    this.g = (1 - r) * Math.sqrt(1 - 2 * r * Math.cos(2 * w) + r * r);
  }
  run(x: number): number {
    const y = this.g * x + this.a1 * this.y1 + this.a2 * this.y2;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

/** What the engine is doing over a stretch of samples. */
export interface Drive {
  rpm: number;
  /** Cylinder filling, from about 0.1 with the throttle shut to 1 at full load, above 1 on boost. */
  load: number;
  /** Share of each charge that burns: 0 with the fuel cut, as on the overrun or the limiter. */
  burn: number;
  /** Throttle opening, for the intake. */
  throttle: number;
}

/** How loud each part of the engine bay is, against the others; set once by measuring them (see the tests). */
const BAY_MIX = { intake: 1, valves: 0.5, clatter: 0.35, thrum: 2.2 };

/**
 * The engine and its pipes. Call `run` for blocks of samples; the state carries over, so a block can follow
 * another with different settings. The per-firing variation and the turbulence can be made periodic, so a loop of
 * whole cycles comes out seamless.
 */
export class EngineModel {
  readonly n: number;
  /** Turns parts of the engine bay down or off, for measuring them. */
  readonly mix = { ...BAY_MIX, exhaust: 1 };
  private readonly offsets: number[];
  private readonly primaries: Pipe[];
  private readonly runners: Pipe[];
  private readonly pipes: Pipe[] = [];
  private readonly junctions: Junction[] = [];
  private readonly turbines: Turbine[] = [];
  private readonly outlet: OpenEnd;
  private readonly mouths: OpenEnd[];
  private readonly valveEnds: Port[];
  private readonly runnerEnds: Port[];
  /** Where a pop in the exhaust starts: the head of the main pipe. */
  private readonly popPort: Port;
  private readonly valves = [new Resonator(2900, 9), new Resonator(4700, 7)];
  private readonly knock = new Resonator(1250, 3);
  private readonly block = [new Resonator(140, 1.2), new Resonator(330, 1.5)];
  private phase = 0;
  private readonly lastDeg: number[];
  private readonly fired: number[];
  private readonly amps: number[];
  private sample = 0;
  private noise = new Float32Array(1);
  private jitter = new Float32Array(1);
  private jitterCycles = 1;
  private readonly dc = [0, 0, 0, 0];
  private readonly spec: EngineSpec;

  constructor(spec: EngineSpec) {
    this.spec = spec;
    const n = spec.firing.length;
    this.n = n;
    this.offsets = [];
    for (let c = 1; c <= n; c++) this.offsets.push(spec.firing.indexOf(c) / n);
    this.lastDeg = new Array(n).fill(0);
    this.fired = new Array(n).fill(0);
    this.amps = new Array(n).fill(1);
    this.periodic(1, SYNTH_RATE, 1);

    // Exhaust: primaries into their collectors.
    this.primaries = spec.primaries.map((length) => new Pipe(length, C_HEADER, 9000, 0.05));
    this.valveEnds = this.primaries.map((pipe) => ({ pipe, start: true, y: 1 }));
    const groupOuts: Port[] = [];
    for (const group of spec.groups) {
      const area = group.length * 0.55;
      const ports = group.map((c): Port => ({ pipe: this.primaries[c - 1], start: false, y: 1 }));
      if (spec.turbo?.perGroup) {
        // The collector goes straight into this group's turbine, then its own downpipe.
        const inlet = this.add(new Pipe(0.12, C_HEADER));
        this.junctions.push(new Junction([...ports, { pipe: inlet, start: true, y: area }]));
        const down = this.add(new Pipe(spec.downpipe, C_PIPE, 6000));
        this.turbines.push(new Turbine({ pipe: inlet, start: false, y: area }, { pipe: down, start: true, y: area }, spec.turbo.keep));
        groupOuts.push({ pipe: down, start: false, y: area });
      } else if (spec.secondary > 0) {
        const secondary = this.add(new Pipe(spec.secondary, C_HEADER, 8000));
        this.junctions.push(new Junction([...ports, { pipe: secondary, start: true, y: area }]));
        groupOuts.push({ pipe: secondary, start: false, y: area });
      } else {
        groupOuts.push(...ports);
      }
    }
    // The merge, then a turbine if one serves the whole engine, then down the car.
    const head = this.add(new Pipe(spec.pipe, C_PIPE, 5500));
    if (spec.turbo && !spec.turbo.perGroup) {
      const inlet = this.add(new Pipe(0.15, C_HEADER));
      this.junctions.push(new Junction([...groupOuts, { pipe: inlet, start: true, y: 1.6 }]));
      const down = this.add(new Pipe(spec.downpipe, C_PIPE, 6000));
      this.turbines.push(new Turbine({ pipe: inlet, start: false, y: 1.6 }, { pipe: down, start: true, y: 1.6 }, spec.turbo.keep));
      this.junctions.push(new Junction([{ pipe: down, start: false, y: 1.6 }, { pipe: head, start: true, y: 1.6 }]));
    } else {
      this.junctions.push(new Junction([...groupOuts, { pipe: head, start: true, y: 1.6 }]));
    }
    this.popPort = { pipe: head, start: true, y: 1.6 };
    // Muffler: an expansion into a packed chamber and back down to the tailpipe.
    const { length, ratio, packing } = spec.muffler;
    const chamber = this.add(new Pipe(length, C_PIPE, 2600 - packing * 1800, 0.4 + packing * 2.5));
    const tail = this.add(new Pipe(spec.tail, C_TAIL, 7000));
    this.junctions.push(new Junction([{ pipe: head, start: false, y: 1.6 }, { pipe: chamber, start: true, y: 1.6 * ratio }]));
    this.junctions.push(new Junction([{ pipe: chamber, start: false, y: 1.6 * ratio }, { pipe: tail, start: true, y: 1.6 }]));
    this.outlet = new OpenEnd({ pipe: tail, start: false, y: 1.6 }, 2200);

    // Intake: a runner per cylinder, open at the trumpet.
    this.runners = this.primaries.map(() => new Pipe(spec.intake.runner, C_INTAKE, spec.intake.itb ? 9000 : 2500, 0.1));
    this.runnerEnds = this.runners.map((pipe) => ({ pipe, start: true, y: 1 }));
    this.mouths = this.runners.map((pipe) => new OpenEnd({ pipe, start: false, y: 1 }, spec.intake.itb ? 3200 : 1400));
  }

  private add(pipe: Pipe): Pipe {
    this.pipes.push(pipe);
    return pipe;
  }

  /**
   * Makes the variation repeat: `cycles` engine cycles of firing variation and `length` samples of turbulence.
   * A loop of `cycles` cycles, `length` samples long, then joins up without a seam.
   */
  periodic(cycles: number, length: number, seed: number): void {
    const r = random(seed);
    this.jitterCycles = cycles;
    this.jitter = new Float32Array(cycles * this.n);
    // Roughly normal, from three uniforms.
    for (let i = 0; i < this.jitter.length; i++) this.jitter[i] = (r() + r() + r() - 1.5) * 2;
    // Turbulence: white noise, a little dulled. Two passes so the filter has settled where the loop joins.
    this.noise = new Float32Array(length);
    let lp = 0;
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < length; i++) {
        lp += 0.5 * (r() * 2 - 1 - lp);
        if (pass) this.noise[i] = lp * 1.7;
      }
    }
    this.sample = 0;
  }

  /**
   * Renders `count` samples at `at` into the two outputs: the exhaust, and the engine bay (intake, valve gear and
   * the block). `inject`, if given, is a pressure pushed into the head of the main pipe, sample by sample: a pop.
   */
  run(exhaust: Float32Array, bay: Float32Array, at: number, count: number, d: Drive, inject?: Float32Array): void {
    const { spec, n, mix } = this;
    const dPhase = d.rpm / 120 / SYNTH_RATE;
    const degPerSample = (d.rpm * 6) / SYNTH_RATE;
    // Blowdown peaks about half a millisecond after the valve cracks, sooner with more pressure behind it.
    const peak = Math.max(3, d.rpm * 6 * (0.00062 - 0.00022 * Math.min(1.4, d.load)));
    const evc = 360 + spec.overlap / 2;
    const ivo = 360 - spec.overlap / 2;
    const exhaustOpen = evc - spec.evo;
    const intakeOpen = spec.ivc - ivo;
    const idleness = Math.max(0, Math.min(1, (spec.idle * 2.2 - d.rpm) / (spec.idle * 1.4)));
    const jitterAmount = spec.jitter[0] * idleness + spec.jitter[1] * (1 - idleness);
    const blow = 0.04 + Math.min(1.5, d.load) * d.burn;
    const push = 0.18 + 0.3 * Math.min(1.3, d.load);
    const suck = (0.1 + 0.9 * d.throttle) * spec.intake.level * (0.6 + 0.4 * Math.min(1.2, d.load));
    const tick = spec.tick * (0.35 + 0.65 * (d.rpm / spec.redline));
    // Turbulence riding on each pulse: the rasp. Stronger the harder the charge burns.
    const rasp = 0.06 + 0.12 * Math.min(1, d.load * d.burn);
    const noiseLength = this.noise.length;

    for (let s = 0; s < count; s++) {
      for (const p of this.pipes) p.arrive();
      for (const p of this.primaries) p.arrive();
      for (const p of this.runners) p.arrive();
      const turb = this.noise[this.sample % noiseLength];

      this.phase += dPhase;
      if (this.phase >= 1) this.phase -= 1;
      let valveHits = 0;
      let burning = 0;
      for (let c = 0; c < n; c++) {
        let psi = this.phase - this.offsets[c];
        if (psi < 0) psi += 1;
        const deg = psi * 720;
        const last = this.lastDeg[c];
        this.lastDeg[c] = deg;
        if (deg < last) {
          // This cylinder just passed firing TDC: how well does this charge burn?
          this.fired[c]++;
          const j = this.jitter[((this.fired[c] % this.jitterCycles) * n + c) % this.jitter.length];
          let amp = 1 + j * jitterAmount;
          // Long cams at idle: now and then a cylinder barely fires.
          if (spec.lope > 0 && j > 2.2 - 1.6 * spec.lope * idleness) amp *= 0.35;
          this.amps[c] = Math.max(0.1, amp);
        }
        // Valve gear: a tick as each valve lands on its seat.
        if ((last < evc && deg >= evc) || (last < spec.ivc && deg >= spec.ivc)) valveHits += 1 + 0.25 * turb;

        // Exhaust: the blowdown as the valve cracks open, then the piston pushing out the rest.
        let src = 0;
        if (deg >= spec.evo && deg < evc) {
          const x = deg - spec.evo;
          const t = x / peak;
          const blowdown = t < 14 ? t * Math.exp(1 - t) : 0;
          const stroke = deg >= 180 ? Math.sin(((deg - 180) / 180) * Math.PI) : 0;
          // Soft close, so the valve seating doesn't click in the gas.
          const close = Math.min(1, (exhaustOpen - x) / 25);
          src = (this.amps[c] * blow * blowdown * (1 + rasp * turb) + push * stroke * (1 + 0.04 * turb)) * close;
        }
        const valveEnd = this.valveEnds[c];
        send(valveEnd, (src !== 0 ? 0.55 : 0.92) * valveEnd.pipe.atStart + src);
        // The burn shoves the block: the thrum felt and heard in the cabin.
        if (deg < 60) burning += this.amps[c] * d.load * d.burn * Math.sin((deg / 60) * Math.PI);

        // Intake: the piston draws air in, and the valve slamming shut sends a pulse back up the runner.
        let draw = 0;
        let reflect = 0.95;
        if (deg >= ivo && deg < spec.ivc) {
          const x = Math.sin(((deg - ivo) / intakeOpen) * Math.PI);
          draw = -suck * x * x * (1 + 0.08 * turb);
          reflect = 0.35;
        } else if (deg >= spec.ivc && deg < spec.ivc + 40) {
          draw = suck * 0.55 * Math.exp(-(deg - spec.ivc) / 7);
        }
        const runnerEnd = this.runnerEnds[c];
        send(runnerEnd, reflect * runnerEnd.pipe.atStart + draw);
      }

      for (const j of this.junctions) j.scatter();
      for (const t of this.turbines) t.scatter();
      if (inject) this.popPort.pipe.intoStart += inject[at + s];
      let out = this.outlet.scatter() * mix.exhaust;
      let intake = 0;
      for (const m of this.mouths) intake += m.scatter();
      for (const p of this.pipes) p.step();
      for (const p of this.primaries) p.step();
      for (const p of this.runners) p.step();

      const valves = this.valves[0].run(valveHits * tick) * 0.6 + this.valves[1].run(valveHits * tick) * 0.4;
      const clatter = this.knock.run(burning * degPerSample);
      const thrum = this.block[0].run(burning) + this.block[1].run(burning) * 0.5;
      let engineBay = intake * mix.intake + valves * mix.valves + clatter * mix.clatter + thrum * mix.thrum * 0.02;

      // No DC in either output.
      this.dc[0] = 0.9995 * this.dc[0] + out - this.dc[1];
      this.dc[1] = out;
      out = this.dc[0];
      this.dc[2] = 0.9995 * this.dc[2] + engineBay - this.dc[3];
      this.dc[3] = engineBay;
      engineBay = this.dc[2];

      exhaust[at + s] = out;
      bay[at + s] = engineBay;
      this.sample++;
    }
  }
}
