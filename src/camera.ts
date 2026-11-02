import { Quaternion, Vector3 } from 'three';
import { driverView, setCabinView } from './car-model';
import { showToast } from './hud';
import { clamp, lerp, TAU } from './math';
import { camera, followSun } from './stage';
import { app, car, store } from './state';
import { heightAt } from './terrain';

const CAMERA_NAMES = ['Chase', 'Far chase', 'Inside', 'Bonnet', 'Overhead'] as const;
export type CameraName = (typeof CAMERA_NAMES)[number];

/** The view in use, so sound can be heard from where the camera is. */
export const cameraName = (): CameraName => CAMERA_NAMES[app.cam] ?? 'Chase';

const rig = { init: false, pos: new Vector3(), look: new Vector3(), dir: new Vector3() };
let shake = 0;

/** The driver's head: where it is, how the car holds it, and how far it has turned to look into a slide. */
const head = { pos: new Vector3(), quat: new Quaternion(), yaw: 0 };
const turn = new Quaternion();
const nod = new Quaternion();
const Y_AXIS = new Vector3(0, 1, 0);
const X_AXIS = new Vector3(1, 0, 0);
let inside = false;

export function cycleCamera(): void {
  app.cam = (app.cam + 1) % CAMERA_NAMES.length;
  store.set('cam', app.cam);
  rig.init = false;
  showToast(CAMERA_NAMES[app.cam] + ' camera');
}

/** Snap to the next target instead of easing there. */
export function snapCamera(): void {
  rig.init = false;
}

export function shakeCamera(amount: number): void {
  shake = amount;
}

/** The vertical field of view, in degrees, that shows `across` degrees from side to side on this screen. */
function verticalFor(across: number): number {
  return (2 * Math.atan(Math.tan((across * Math.PI) / 360) / camera.aspect) * 180) / Math.PI;
}

/**
 * Widest the outside views go from side to side. A phone held sideways is more than twice as wide as it is
 * tall, and the usual vertical view would stretch the edges past 100 degrees there.
 */
const MAX_ACROSS = 98;

/** About 88 degrees across on a wide screen; narrower screens get what fits without stretching the edges. */
const insideFov = (): number => clamp(verticalFor(88), 60, 92);

/** From the driver's seat: the head moves with the body and turns a little into the slide, as drivers look. */
function updateInside(dt: number): boolean {
  if (!driverView(head.pos, head.quat)) return false;
  const speed = Math.hypot(car.vx, car.vz);
  let slip = speed > 3 ? Math.atan2(car.vx, car.vz) - car.th : 0;
  slip -= Math.round(slip / TAU) * TAU;
  head.yaw = lerp(head.yaw, clamp(slip * 0.45, -0.55, 0.55), 1 - Math.exp(-dt * 3));
  // The camera looks down its own -z; the car faces +z.
  turn.setFromAxisAngle(Y_AXIS, Math.PI + head.yaw);
  nod.setFromAxisAngle(X_AXIS, -0.075 + (shake > 0 ? (Math.random() - 0.5) * shake * 0.05 : 0));
  camera.position.copy(head.pos);
  camera.quaternion.copy(head.quat).multiply(turn).multiply(nod);
  shake = Math.max(0, shake - dt * 2.5);
  camera.fov = insideFov();
  camera.updateProjectionMatrix();
  followSun(car.x, car.z);
  // Coming back out, the other views start where they belong rather than easing in from the seat.
  rig.init = false;
  return true;
}

export function updateCamera(dt: number): void {
  const name = cameraName();
  if ((name === 'Inside') !== inside) {
    inside = name === 'Inside';
    setCabinView(inside);
    // The steering wheel is half a metre from the eyes.
    camera.near = inside ? 0.05 : 0.1;
  }
  if (inside && updateInside(dt)) return;

  const sinH = Math.sin(car.th);
  const cosH = Math.cos(car.th);
  const speed = Math.hypot(car.vx, car.vz);
  const ground = heightAt(car.x, car.z);
  const focus = new Vector3(car.x, ground, car.z);
  let pos: Vector3;
  let look: Vector3;
  let fov = 62;
  let follow = 1 - Math.exp(-dt * 6);
  const fixed = name === 'Bonnet' || name === 'Inside';

  if (name === 'Chase' || name === 'Far chase') {
    // The chase cameras swing towards the direction of travel, so a slide stays in view.
    const far = name === 'Far chase';
    const motionX = speed > 2 ? car.vx / speed : sinH;
    const motionZ = speed > 2 ? car.vz / speed : cosH;
    const swing = clamp(speed / 12, 0, 1) * 0.55;
    const dirX = lerp(sinH, motionX, swing);
    const dirZ = lerp(cosH, motionZ, swing);
    const len = Math.hypot(dirX, dirZ) || 1;
    rig.dir.set(dirX / len, 0, dirZ / len);
    const back = far ? 10.5 : 6.4;
    const up = far ? 4.2 : 2.35;
    pos = focus.clone().addScaledVector(rig.dir, -back).add(new Vector3(0, up, 0));
    look = focus
      .clone()
      .addScaledVector(rig.dir, far ? 4 : 3)
      .add(new Vector3(0, far ? 0.4 : 0.9, 0));
    fov = (far ? 55 : 62) + clamp(speed, 0, 40) * 0.28;
  } else if (fixed) {
    // The bonnet view, and the inside view for a car with no cabin.
    pos = new Vector3(car.x + sinH * 0.3, ground + 1.32, car.z + cosH * 0.3);
    look = new Vector3(car.x + sinH * 20, heightAt(car.x + sinH * 20, car.z + cosH * 20) + 0.9, car.z + cosH * 20);
    fov = 72;
    follow = 1;
  } else {
    pos = new Vector3(car.x + 0.01, ground + 48, car.z + 22);
    look = focus.clone();
    fov = 50;
    follow = 1 - Math.exp(-dt * 4);
  }

  if (!rig.init) {
    rig.pos.copy(pos);
    rig.look.copy(look);
    rig.init = true;
  }
  rig.pos.lerp(pos, follow);
  rig.look.lerp(look, fixed ? 1 : 1 - Math.exp(-dt * 10));
  camera.position.copy(rig.pos);
  if (shake > 0) {
    camera.position.x += (Math.random() - 0.5) * shake * 0.4;
    camera.position.y += (Math.random() - 0.5) * shake * 0.3;
    shake = Math.max(0, shake - dt * 2.5);
  }
  // Never inside the hillside.
  camera.position.y = Math.max(camera.position.y, heightAt(camera.position.x, camera.position.z) + 0.4);
  camera.lookAt(rig.look);
  camera.fov = lerp(camera.fov, Math.min(fov, verticalFor(MAX_ACROSS)), 1 - Math.exp(-dt * 3));
  camera.updateProjectionMatrix();
  followSun(car.x, car.z);
}
