import { solidAt, surfaceAt } from './ground';
import type { CarShape, CarSpec } from './cars';
import { clamp, lerp, TAU } from './math';
import { car, type Controls, game, type HitKind } from './state';
import { slopeAt } from './terrain';
import { track } from './track';

const GRAVITY = 9.81;

/** The car being driven. `useCar` fills it in from a car's spec and the measurements of its model. */
export const CAR = {
  /** Mass, with driver. */
  m: 1250,
  /** Centre of mass to front and rear axle. */
  A: 1.154,
  B: 1.25,
  /** Centre of mass height. */
  H: 0.48,
  /** Tyre radius. */
  RW: 0.289,
  track: 1.418,
  /** Yaw inertia. */
  I: 1950,
  gears: [3.32, 1.9, 1.31, 1, 0.76],
  final: 3.7,
  rev: 3.38,
  redline: 7500,
  turbo: true,
  /** Engine torque in Nm by rpm, at full boost for a turbo engine. */
  torque: [] as [rpm: number, nm: number][],
  /** Front wheel lock with an angle kit: 60 degrees. */
  maxLock: 1.047,
  /** Half width, then length ahead of and behind the centre of mass, of the collision outline. */
  hw: 0.855,
  nose: 2.238,
  tail: 2.492,
  /** Wheelbase. */
  L: 2.404,
  /** Where the centre of mass sits along the car model, from the model's origin. */
  modelOffset: 0.127,
};

/** Contact patches in the body frame as [right, forward]: front pair first. */
export const WHEEL_POSITIONS: [right: number, forward: number][] = [
  [0, 0],
  [0, 0],
  [0, 0],
  [0, 0],
];

/** Points around the body outline tested against walls, as fractions of the outline. */
const PROBE_FRACTIONS = [
  [1, 1],
  [-1, 1],
  [1, -1],
  [-1, -1],
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 0.5],
  [-1, 0.5],
  [1, -0.5],
  [-1, -0.5],
] as const;
const COLLISION_PROBES: [number, number][] = PROBE_FRACTIONS.map(() => [0, 0]);

/**
 * Switches the physics to a car. The weight split sets where the centre of mass sits between the axles, and
 * yaw inertia scales with mass and how far the axles are from it.
 */
export function useCar(spec: CarSpec, shape: CarShape): void {
  const L = shape.frontAxle - shape.rearAxle;
  const B = spec.frontShare * L;
  const A = L - B;
  const centre = shape.frontAxle - A;
  Object.assign(CAR, {
    m: spec.m,
    A,
    B,
    H: spec.H,
    RW: shape.RW,
    track: shape.halfTrack * 2,
    I: 1.08 * spec.m * A * B,
    gears: spec.gears,
    final: spec.final,
    rev: spec.rev,
    redline: spec.redline,
    turbo: spec.turbo,
    torque: spec.torque,
    hw: (shape.width / 2) * 0.95,
    nose: shape.nose - centre,
    tail: centre - shape.tail,
    L,
    modelOffset: centre,
  });
  WHEEL_POSITIONS[0] = [shape.halfTrack, A];
  WHEEL_POSITIONS[1] = [-shape.halfTrack, A];
  WHEEL_POSITIONS[2] = [shape.halfTrack, -B];
  WHEEL_POSITIONS[3] = [-shape.halfTrack, -B];
  PROBE_FRACTIONS.forEach(([x, z], i) => (COLLISION_PROBES[i] = [x * CAR.hw, z * (z > 0 ? CAR.nose : CAR.tail)]));
}

/** Wall line segments with a radius, and rotated boxes. Filled in while the world is built. */
export const colliders = {
  segs: [] as { ax: number; az: number; bx: number; bz: number; r: number; kind: HitKind }[],
  boxes: [] as { x: number; z: number; c: number; s: number; hx: number; hz: number }[],
};

// Tyres: grippier ones up front and harder ones on the back are the usual drift setup.
const FRONT_MU = 1.12;
const REAR_MU = 1.05;
const PEAK_SLIP_RATIO = 0.12;
/** About 8 degrees. */
const PEAK_SLIP_ANGLE = 0.14;
/** Grip per unit of load falls as the load rises. */
const LOAD_SENSITIVITY = 0.1;
/** A tyre sliding at this speed has lost `SLIDE_FADE` of its grip to heat. */
const SLIDE_FADE_SPEED = 25;
const SLIDE_FADE = 0.12;
/** Slip is measured against at least this speed, so it stays finite at a standstill. */
const MIN_SLIP_SPEED = 2.5;

const FRONT_WHEEL_INERTIA = 1.1;
/** Both rear wheels, the locked differential and the propshaft. */
const REAR_AXLE_INERTIA = 3.2;
const ENGINE_INERTIA = 0.18;
const CLUTCH_TORQUE = 900;
const HANDBRAKE_TORQUE = 2500;
const DRIVELINE_EFFICIENCY = 0.88;
const IDLE_RPM = 900;
/** Share of the body roll resisted at the front. */
const FRONT_ROLL_SHARE = 0.55;
/** Half of air density times drag area, for Cd 0.34 and 1.9 square metres. */
const AIR_DRAG = 0.39;
const ROLLING_RESISTANCE = 0.014;

function engineTorque(rpm: number): number {
  const curve = CAR.torque;
  for (let i = 1; i < curve.length; i++) {
    const [toRpm, toTorque] = curve[i];
    if (rpm <= toRpm) {
      const [fromRpm, fromTorque] = curve[i - 1];
      return lerp(fromTorque, toTorque, clamp((rpm - fromRpm) / (toRpm - fromRpm), 0, 1));
    }
  }
  return curve[curve.length - 1][1];
}

/** Grip against normalised slip: 1 at peak slip, easing to about 0.85 as the tyre slides. */
const gripCurve = (slip: number) => Math.sin(1.35 * Math.atan(2.32 * slip));

/** Per-wheel values for this step, with velocities in the wheel's own frame. */
const wheels = [0, 1, 2, 3].map(() => ({ mu: 1, load: 0, sin: 0, cos: 1, vLong: 0, vLat: 0 }));
const tyre = { fx: 0, fy: 0, slip: 0, sliding: 0 };

/**
 * Sets `tyre` to the force on wheel `w` for a rim speed. Slip is one vector, so the force follows the
 * direction the contact patch is sliding in: a spinning tyre pushes forwards and gives up its side grip.
 */
function solveTyre(w: number, rimSpeed: number): void {
  const { mu, load, vLong, vLat } = wheels[w];
  const reference = Math.max(Math.abs(vLong), Math.abs(rimSpeed), MIN_SLIP_SPEED);
  const slipX = (rimSpeed - vLong) / reference / PEAK_SLIP_RATIO;
  const slipY = -vLat / reference / PEAK_SLIP_ANGLE;
  const slip = Math.hypot(slipX, slipY);
  const sliding = Math.hypot(rimSpeed - vLong, vLat);
  tyre.slip = slip;
  tyre.sliding = sliding;
  if (slip < 1e-6) {
    tyre.fx = tyre.fy = 0;
    return;
  }
  const grip =
    mu *
    load *
    (1 - LOAD_SENSITIVITY * ((4 * load) / (CAR.m * GRAVITY) - 1)) *
    (1 - SLIDE_FADE * clamp(sliding / SLIDE_FADE_SPEED, 0, 1));
  const scale = (grip * gripCurve(slip)) / slip;
  tyre.fx = scale * slipX;
  tyre.fy = scale * slipY;
}

/**
 * The spin of wheels `from` to `to` at the end of this step, given their momentum plus any drive. A tyre is
 * far too stiff to step forward at this rate, so this finds the spin that balances road and brake torque, by
 * bisection: that stays safe over the peak of the grip curve, and on a locked brake.
 */
function solveSpin(from: number, to: number, momentum: number, inertia: number, brakeImpulse: number, dt: number): number {
  let lo = Math.min(0, momentum / inertia);
  let hi = Math.max(0, momentum / inertia);
  for (let w = from; w <= to; w++) {
    lo = Math.min(lo, wheels[w].vLong / CAR.RW);
    hi = Math.max(hi, wheels[w].vLong / CAR.RW);
  }
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2;
    let road = 0;
    for (let w = from; w <= to; w++) {
      solveTyre(w, mid * CAR.RW);
      road += tyre.fx;
    }
    if (inertia * mid - momentum + dt * road * CAR.RW + Math.sign(mid) * brakeImpulse > 0) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

let fuelCut = false;

export function physicsStep(dt: number, input: Controls): void {
  const { m, A, B, L, H, RW } = CAR;
  const sinH = Math.sin(car.th);
  const cosH = Math.cos(car.th);
  const rightX = cosH;
  const rightZ = -sinH;
  const vForward = car.vx * sinH + car.vz * cosH;
  const vRight = car.vx * rightX + car.vz * rightZ;
  const speed = Math.hypot(car.vx, car.vz);

  let surfaceDrag = 0;
  let kerbWheels = 0;
  for (let w = 0; w < 4; w++) {
    const [right, forward] = WHEEL_POSITIONS[w];
    const surface = surfaceAt(car.x + rightX * right + sinH * forward, car.z + rightZ * right + cosH * forward);
    car.surf[w] = surface.kind;
    wheels[w].mu = surface.mu * (w < 2 ? FRONT_MU : REAR_MU);
    surfaceDrag += surface.drag / 4;
    if (surface.kind === 'kerb') kerbWheels++;
  }
  car.onKerb = kerbWheels;

  // Holding brake at a standstill selects reverse, where the pedals swap roles.
  if (car.gear > 0 && input.brake > 0.1 && input.gas < 0.1 && vForward < 0.6) car.gear = -1;
  else if (car.gear < 0 && input.gas > 0.1 && vForward > -0.6) car.gear = 1;
  const reversing = car.gear < 0;

  // Gears go by road speed rather than wheel speed, so a slide with the rears spinning holds its gear.
  // First is only for pulling away, like a real drift car, which lives in second and third.
  if (!reversing) {
    car.shiftT = Math.max(0, car.shiftT - dt);
    const rpmAtSpeed = ((speed / RW) * CAR.gears[car.gear - 1] * CAR.final * 60) / TAU;
    if (car.shiftT <= 0) {
      if (rpmAtSpeed > (car.gear === 1 ? 3500 : CAR.redline - 400) && car.gear < 5) {
        car.gear++;
        car.shiftT = 0.18;
      } else if (rpmAtSpeed < (car.gear === 2 ? 1100 : 3200) && car.gear > 1) {
        car.gear--;
        car.shiftT = 0.12;
      }
    }
  }
  const ratio = (reversing ? -CAR.rev : CAR.gears[car.gear - 1]) * CAR.final;
  const brake = reversing ? input.gas : input.brake;

  // A foot takes a moment to move, and the throttle shuts during a gear change.
  const pedal = car.shiftT > 0 ? 0 : reversing ? input.brake : input.gas;
  car.throttle += clamp(pedal - car.throttle, -dt * 14, dt * 5);
  const demand = CAR.turbo ? car.throttle * clamp((car.rpm - 1800) / 2200, 0, 1) : 0;
  car.boost = lerp(car.boost, demand, 1 - Math.exp(-dt * (demand > car.boost ? 1.4 : 3.5)));

  const driftAngle = speed > 1.5 ? Math.atan2(vRight, Math.abs(vForward)) : 0;

  // Keyboard steering stops near the grip limit at speed, and opens up to full lock for a real slide.
  const gripLock = Math.atan((L * 11) / Math.max(speed * speed, 1)) + 0.12;
  const slide = input.hand ? 1 : clamp((Math.abs(driftAngle) - 0.25) / 0.35, 0, 1);
  // With the assist holding the countersteer, keys only need to trim it.
  const slideLock = input.assist ? 0.45 : CAR.maxLock;
  const lock = input.analog ? CAR.maxLock : lerp(Math.min(gripLock, CAR.maxLock), slideLock, slide);
  let steerTarget = input.steer * lock;
  // Caster: let go of the wheel and the fronts swing round to follow the direction of travel.
  if (input.assist && speed > 4 && vForward > 0) steerTarget += driftAngle * 0.85 * clamp(speed / 10, 0, 1);
  steerTarget = clamp(steerTarget, -CAR.maxLock, CAR.maxLock);
  const steerRate = 5;
  car.delta += clamp(steerTarget - car.delta, -steerRate * dt, steerRate * dt);
  const delta = car.delta;
  // Ackermann: the inner front wheel turns further than the outer one.
  const toe = 0.12 * delta * delta;

  // Weight transfer onto each wheel, from last step's accelerations.
  const pitchShift = (m * car.axb * H) / L / 2;
  const rollShift = (m * car.ayb * H) / CAR.track;
  for (let w = 0; w < 4; w++) {
    const wheel = wheels[w];
    const [right, forward] = WHEEL_POSITIONS[w];
    const front = w < 2;
    const axleLoad = (m * GRAVITY * (front ? B : A)) / L / 2;
    const roll = rollShift * (front ? FRONT_ROLL_SHARE : 1 - FRONT_ROLL_SHARE);
    wheel.load = Math.max(0, axleLoad + (front ? -pitchShift : pitchShift) - Math.sign(right) * roll);

    const steer = w === 0 ? delta + toe : w === 1 ? delta - toe : 0;
    wheel.sin = Math.sin(steer);
    wheel.cos = Math.cos(steer);
    const vWheelRight = vRight + car.r * forward;
    const vWheelForward = vForward - car.r * right;
    wheel.vLong = vWheelForward * wheel.cos + vWheelRight * wheel.sin;
    wheel.vLat = vWheelRight * wheel.cos - vWheelForward * wheel.sin;
  }

  // No ABS: the pedal tops out close to the limit of the tyres, and past it they lock.
  const brakeForce = brake * m * GRAVITY * 1.12;
  for (let w = 0; w < 2; w++) {
    car.omega[w] = solveSpin(w, w, FRONT_WHEEL_INERTIA * car.omega[w], FRONT_WHEEL_INERTIA, dt * brakeForce * 0.32 * RW, dt);
  }

  const engineRpm = car.rpm;
  if (engineRpm > CAR.redline) fuelCut = true;
  else if (engineRpm < CAR.redline - 150) fuelCut = false;
  car.cut = fuelCut;
  const fired = fuelCut ? 0 : car.throttle;
  let torque =
    fired * engineTorque(engineRpm) * (CAR.turbo ? 0.55 + 0.45 * car.boost : 1) * DRIVELINE_EFFICIENCY -
    (1 - fired) * (18 + engineRpm * 0.011);
  if (engineRpm < IDLE_RPM) torque += (IDLE_RPM - engineRpm) * 0.4;
  const engineFree = (engineRpm * TAU) / 60 + (dt * torque) / ENGINE_INERTIA;

  // The clutch slips to pull away, and the driver dips it for a gear change and with the handbrake on.
  const axleRpm = (car.omega[2] * ratio * 60) / TAU;
  const bite = car.shiftT > 0 || input.hand ? 0 : clamp((Math.max(engineRpm, axleRpm) - 2000) / 1500, 0, 1);
  const clutchLimit = CLUTCH_TORQUE * bite;
  const rearMomentum = REAR_AXLE_INERTIA * car.omega[2];
  const rearBrake = dt * (brakeForce * 0.36 * RW + (input.hand ? HANDBRAKE_TORQUE : 0));

  // First assume the clutch holds, which makes engine and axle one body. If that takes more torque than
  // it can carry, it slips at its limit and each side turns on its own.
  const joined = ratio * ratio * ENGINE_INERTIA;
  let axle = solveSpin(2, 3, rearMomentum + ratio * ENGINE_INERTIA * engineFree, REAR_AXLE_INERTIA + joined, rearBrake, dt);
  let engine = ratio * axle;
  const clutchTorque = (ENGINE_INERTIA * (engineFree - engine)) / dt;
  if (Math.abs(clutchTorque) > clutchLimit) {
    const slipping = Math.sign(clutchTorque) * clutchLimit;
    axle = solveSpin(2, 3, rearMomentum + dt * ratio * slipping, REAR_AXLE_INERTIA, rearBrake, dt);
    engine = engineFree - (dt * slipping) / ENGINE_INERTIA;
  }
  car.rpm = Math.max(300, (engine * 60) / TAU);
  car.omega[2] = axle;

  let forceRight = 0;
  let forceForward = 0;
  let yawMoment = -car.r * 100;
  for (let w = 0; w < 4; w++) {
    const wheel = wheels[w];
    const [right, forward] = WHEEL_POSITIONS[w];
    solveTyre(w, car.omega[Math.min(w, 2)] * RW);
    car.slip[w] = tyre.slip;
    car.slide[w] = tyre.sliding;
    car.load[w] = wheel.load;
    const pushRight = tyre.fx * wheel.sin + tyre.fy * wheel.cos;
    const pushForward = tyre.fx * wheel.cos - tyre.fy * wheel.sin;
    forceRight += pushRight;
    forceForward += pushForward;
    yawMoment += forward * pushRight - right * pushForward;
  }

  const rear = wheels[2];
  const rearSlipRatio = Math.abs(axle * RW - rear.vLong) / Math.max(Math.abs(rear.vLong), Math.abs(axle * RW), MIN_SLIP_SPEED);
  car.spin = lerp(car.spin, clamp((rearSlipRatio - PEAK_SLIP_RATIO) * 2, 0, 1.3), 1 - Math.exp(-dt * 10));
  car.slipF = Math.abs(Math.atan2(wheels[0].vLat, Math.max(Math.abs(wheels[0].vLong), 2.2)));
  car.slipR = Math.abs(Math.atan2(rear.vLat, Math.max(Math.abs(rear.vLong), 2.2)));

  const dragCoefficient = AIR_DRAG * speed + m * surfaceDrag + (ROLLING_RESISTANCE * m * GRAVITY) / Math.max(speed, 1);
  // Gravity along the slope: the track climbs and falls about 5.5 m round the lap, up to 8% in places.
  const [riseX, riseZ] = slopeAt(car.x, car.z);
  const fxWorld = forceForward * sinH + forceRight * rightX - car.vx * dragCoefficient - m * GRAVITY * riseX;
  const fzWorld = forceForward * cosH + forceRight * rightZ - car.vz * dragCoefficient - m * GRAVITY * riseZ;

  car.vx += (fxWorld / m) * dt;
  car.vz += (fzWorld / m) * dt;
  car.r += (yawMoment / CAR.I) * dt;
  const stopped = Math.abs(vForward) < 0.4;
  if (stopped && car.throttle < 0.05 && (brake > 0.05 || input.hand || speed < 0.25)) {
    car.vx *= 0.85;
    car.vz *= 0.85;
    car.r *= 0.85;
  }
  car.axb = lerp(car.axb, forceForward / m, 1 - Math.exp(-dt * 8));
  car.ayb = lerp(car.ayb, forceRight / m, 1 - Math.exp(-dt * 8));

  const prevX = car.x;
  const prevZ = car.z;
  const prevTh = car.th;
  car.th += car.r * dt;
  car.x += car.vx * dt;
  car.z += car.vz * dt;
  resolveCollisions(prevX, prevZ, prevTh);

  for (let w = 0; w < 4; w++) car.wheelRot[w] += car.omega[Math.min(w, 2)] * dt;
}

type Contact = [normalX: number, normalZ: number, depth: number, kind: HitKind];

function contactAt(x: number, z: number): Contact | null {
  for (const seg of colliders.segs) {
    const dx = seg.bx - seg.ax;
    const dz = seg.bz - seg.az;
    const lengthSq = dx * dx + dz * dz || 1;
    const t = clamp(((x - seg.ax) * dx + (z - seg.az) * dz) / lengthSq, 0, 1);
    const closestX = seg.ax + dx * t;
    const closestZ = seg.az + dz * t;
    const offX = x - closestX;
    const offZ = z - closestZ;
    const dist = Math.hypot(offX, offZ);
    if (dist < seg.r) return dist > 1e-4 ? [offX / dist, offZ / dist, seg.r - dist, seg.kind] : [0, 1, seg.r, seg.kind];
  }

  for (const box of colliders.boxes) {
    const dx = x - box.x;
    const dz = z - box.z;
    const localX = box.c * dx - box.s * dz;
    const localZ = box.s * dx + box.c * dz;
    const depthX = box.hx - Math.abs(localX);
    const depthZ = box.hz - Math.abs(localZ);
    if (depthX > 0 && depthZ > 0) {
      let normalX = 0;
      let normalZ = 0;
      let depth;
      if (depthX < depthZ) {
        normalX = Math.sign(localX);
        depth = depthX;
      } else {
        normalZ = Math.sign(localZ);
        depth = depthZ;
      }
      return [box.c * normalX + box.s * normalZ, -box.s * normalX + box.c * normalZ, depth, 'building'];
    }
  }

  if (solidAt(x, z)) {
    let awayX = 0;
    let awayZ = 0;
    for (const [dx, dz] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
      [0.7, 0.7],
      [-0.7, 0.7],
      [0.7, -0.7],
      [-0.7, -0.7],
    ]) {
      if (!solidAt(x + dx * 1.2, z + dz * 1.2)) {
        awayX += dx;
        awayZ += dz;
      }
    }
    const len = Math.hypot(awayX, awayZ);
    return len < 0.001 ? [0, 0, 0.5, 'solid'] : [awayX / len, awayZ / len, 0.15, 'solid'];
  }
  return null;
}

/** Puts the car back where it was, nudged off the wall, and applies an impulse at the contact point. */
function resolveCollisions(prevX: number, prevZ: number, prevTh: number): void {
  const sinH = Math.sin(car.th);
  const cosH = Math.cos(car.th);
  const rightX = cosH;
  const rightZ = -sinH;
  let normalX = 0;
  let normalZ = 0;
  let contactX = 0;
  let contactZ = 0;
  let hits = 0;
  for (const [right, forward] of COLLISION_PROBES) {
    const x = car.x + rightX * right + sinH * forward;
    const z = car.z + rightZ * right + cosH * forward;
    const contact = contactAt(x, z);
    if (contact) {
      normalX += contact[0];
      normalZ += contact[1];
      contactX += x;
      contactZ += z;
      hits++;
      car.hitKind = contact[3];
    }
  }
  // About 40 ms to fade, so a car pushed off a wall and back onto it each step still sounds like one long scrape.
  car.scrape *= 0.9;
  if (!hits) return;

  let len = Math.hypot(normalX, normalZ);
  if (len < 0.001) {
    // Opposing contacts cancelled out; head for the centreline instead.
    normalX = track.X[game.idx] - car.x;
    normalZ = track.Z[game.idx] - car.z;
    len = Math.hypot(normalX, normalZ) || 1;
  }
  normalX /= len;
  normalZ /= len;
  contactX /= hits;
  contactZ /= hits;

  car.x = prevX + normalX * 0.03;
  car.z = prevZ + normalZ * 0.03;
  car.th = prevTh;

  const armX = contactX - car.x;
  const armZ = contactZ - car.z;
  const pointVx = car.vx + car.r * armZ;
  const pointVz = car.vz - car.r * armX;
  const closing = pointVx * normalX + pointVz * normalZ;
  if (closing < 0) {
    const lever = armZ * normalX - armX * normalZ;
    const impulse = (-(1 + 0.22) * closing) / (1 / CAR.m + (lever * lever) / CAR.I);
    car.vx += (impulse * normalX) / CAR.m;
    car.vz += (impulse * normalZ) / CAR.m;
    car.r += (lever * impulse) / CAR.I;

    // Scrub some speed along the wall.
    const alongX = -normalZ;
    const alongZ = normalX;
    const slide = car.vx * alongX + car.vz * alongZ;
    car.vx -= alongX * slide * 0.12;
    car.vz -= alongZ * slide * 0.12;
    car.scrape = Math.max(car.scrape, Math.abs(slide));
    car.r *= 0.8;
    car.impact = Math.max(car.impact, -closing);
  }
}
