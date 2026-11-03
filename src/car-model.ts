import {
  Box3,
  BoxGeometry,
  type BufferGeometry,
  CircleGeometry,
  Color,
  DoubleSide,
  Group,
  LoadingManager,
  type Material,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  RingGeometry,
  SRGBColorSpace,
  type Texture,
  TextureLoader,
  Vector3,
} from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import carEmissiveUrl from './assets/car/car-emissive.png';
import carPaintBaseUrl from './assets/car/car-paint-base.jpg';
import carPaintMaskUrl from './assets/car/car-paint-mask.png';
import carModelUrl from './assets/car/retro-car.fbx?url';
import { type Finish, loadPackedCar, type PackedCar } from './car-pack';
import {
  aeroParts,
  bannerGlass,
  type BodyPoints,
  bodyPaint,
  CABIN_SIDE,
  camberOf,
  type CarBox,
  type CarStyle,
  driftFinishes,
  type Livery,
  LIVERY_PARS,
  LIVERY_VERTEX,
  liveryUniforms,
  paintLivery,
} from './car-style';
import { carById, type CarShape, type CarSpec, RETRO_SHAPE } from './cars';
import { clamp, lerp } from './math';
import { CAR, useCar } from './physics';
import { scene } from './stage';
import { car, controls, store } from './state';
import { heightAt, slopeAt } from './terrain';

/** Real length of the car in metres; the model is scaled to it. */
const CAR_LENGTH = 4.73;

/** Steering wheel turns per front wheel turn: a quick rack, about one and a half turns to full lock. */
const STEERING_RATIO = 9;

/** The drift look sits lower, on spacers. */
const DRIFT_DROP = 0.035;
const DRIFT_SPACER = [0.025, 0.035];

/** Stands in for every texture the FBX refers to: the paint material supplies its own. */
const BLANK_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

export const CAR_COLOURS: readonly (readonly [name: string, colour: number])[] = [
  ['Signal white', 0xf1efe8],
  ['Kerb red', 0xd23a2f],
  ['Racing yellow', 0xf2c230],
  ['Pine green', 0x2f6b4a],
  ['Fjord blue', 0x2f5f9e],
  ['Gunmetal', 0x4b5257],
  ['Orange', 0xe8762c],
];

let style: CarStyle = store.get<CarStyle>('style', 'stock') === 'drift' ? 'drift' : 'stock';
export const carStyle = (): CarStyle => style;

/** Picks stock or drift for every car; `buildCar` then shows it. */
export function setCarStyle(next: CarStyle): void {
  style = next;
  store.set('style', next);
}

interface Part {
  geo: BufferGeometry;
  /** One flag per material slot: is it window glass? */
  glass: boolean[];
  pos: Vector3;
}

interface CarAsset {
  tex: { base: Texture; mask: Texture; emissive: Texture };
  wheels: Part[];
  steering: Part | null;
  body: Part[];
}

async function loadCarAsset(): Promise<CarAsset> {
  const buffer = await (await fetch(carModelUrl)).arrayBuffer();
  const manager = new LoadingManager();
  manager.setURLModifier(() => BLANK_PNG);
  const model = new FBXLoader(manager).parse(buffer, '');

  const textures = new TextureLoader();
  const [base, mask, emissive] = await Promise.all([
    textures.loadAsync(carPaintBaseUrl),
    textures.loadAsync(carPaintMaskUrl),
    textures.loadAsync(carEmissiveUrl),
  ]);
  base.colorSpace = SRGBColorSpace;
  emissive.colorSpace = SRGBColorSpace;
  model.updateMatrixWorld(true);

  const parts: Record<string, { geo: BufferGeometry; glass: boolean[] }> = {};
  const bounds = new Box3();
  model.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    const geo = (object.geometry as BufferGeometry).clone();
    geo.applyMatrix4(object.matrixWorld);
    geo.computeBoundingBox();
    bounds.union(geo.boundingBox!);
    const materials: Material[] = Array.isArray(object.material) ? object.material : [object.material];
    parts[object.name.toLowerCase()] = { geo, glass: materials.map((m) => /window|glass/i.test(m.name)) };
  });

  // Sit the car on the ground at its real length, centred.
  const size = bounds.getSize(new Vector3());
  const scale = CAR_LENGTH / Math.max(size.z, 1e-6);
  const centre = bounds.getCenter(new Vector3());
  for (const part of Object.values(parts)) {
    part.geo.translate(-centre.x, -bounds.min.y, -centre.z);
    part.geo.scale(scale, scale, scale);
    part.geo.computeBoundingBox();
  }

  /** Takes a moving part out of the body, re-centred so it can spin about its own middle. */
  const take = (name: string): Part | null => {
    const part = parts[name.toLowerCase()];
    if (!part) return null;
    delete parts[name.toLowerCase()];
    const pos = part.geo.boundingBox!.getCenter(new Vector3());
    part.geo.translate(-pos.x, -pos.y, -pos.z);
    return { geo: part.geo, glass: part.glass, pos };
  };
  const wheels = ['L_Tire_front', 'R_Tire_Front', 'L_Tire_Back', 'R_Tire_Back'].map((name) => take(name)!);
  const steering = take('Steering_wheel');
  const body = Object.values(parts).map((part) => ({ geo: part.geo, glass: part.glass, pos: new Vector3() }));
  return { tex: { base, mask, emissive }, wheels, steering, body };
}

/** The car's texture, tinted through a paint mask (and the livery), with brake lights that brighten via `lightsR`. */
function createPaintMaterial(asset: CarAsset, colour: number, livery: Livery | null, box: CarBox): MeshStandardMaterial {
  const uniforms = {
    paintColor: { value: new Color(colour) },
    paintMask: { value: asset.tex.mask },
    lightsR: { value: 1 },
    ...liveryUniforms(livery, box),
  };
  const material = new MeshStandardMaterial({
    map: asset.tex.base,
    emissiveMap: asset.tex.emissive,
    emissive: 0xffffff,
    emissiveIntensity: 1.1,
    roughness: 0.42,
    metalness: 0.15,
    side: DoubleSide,
  });
  material.userData.u = uniforms;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader =
      `varying vec3 vObjPos;
varying vec3 vCarPos;
varying vec3 vCarNormal;
` +
      shader.vertexShader.replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
  vObjPos = position;
  ${LIVERY_VERTEX}`,
      );
    shader.fragmentShader =
      `uniform vec3 paintColor;
uniform sampler2D paintMask;
uniform float lightsR;
varying vec3 vObjPos;
` +
      shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${LIVERY_PARS}`)
        .replace(
          '#include <map_fragment>',
          `
        #ifdef USE_MAP
          vec4 sampledDiffuseColor = texture2D( map, vMapUv );
          float pm = texture2D( paintMask, vMapUv ).r;
          vec4 livery = liveryAt();
          vec3 tint = mix( paintColor, livery.rgb, livery.a );
          sampledDiffuseColor.rgb = mix( sampledDiffuseColor.rgb, sampledDiffuseColor.rgb * tint, pm );
          diffuseColor *= sampledDiffuseColor;
        #endif
        ${CABIN_SIDE}`,
        )
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>
  totalEmissiveRadiance *= vObjPos.z > 0.0 ? 1.0 : lightsR;
  if (!gl_FrontFacing) totalEmissiveRadiance *= 0.0;`,
        );
  };
  material.customProgramCacheKey = () => 'drift-car-paint';
  return material;
}

const glassMaterial = new MeshStandardMaterial({
  color: 0x1b2833,
  transparent: true,
  opacity: 0.5,
  roughness: 0.06,
  metalness: 0.35,
  depthWrite: false,
  side: DoubleSide,
});

/** Finishes for the packed cars, shared by every build. Paint is made per build, in the chosen colour. */
const FINISHES: Record<Exclude<Finish, 'paint'>, MeshStandardMaterial> = {
  glass: glassMaterial,
  lamp: new MeshStandardMaterial({ color: 0xd6dee4, transparent: true, opacity: 0.35, roughness: 0.05, metalness: 0.2, depthWrite: false }),
  tyre: new MeshStandardMaterial({ color: 0x161616, roughness: 0.92 }),
  rim: new MeshStandardMaterial({ color: 0xb4b8bc, roughness: 0.35, metalness: 0.8 }),
  chrome: new MeshStandardMaterial({ color: 0xd8dadc, roughness: 0.15, metalness: 1 }),
  trim: new MeshStandardMaterial({ color: 0x0e0f11, roughness: 0.3, side: DoubleSide }),
  plastic: new MeshStandardMaterial({ color: 0x18191b, roughness: 0.8, side: DoubleSide }),
  metal: new MeshStandardMaterial({ color: 0x6c7074, roughness: 0.5, metalness: 0.5, side: DoubleSide }),
  carbon: new MeshStandardMaterial({ color: 0x1d2023, roughness: 0.35, metalness: 0.2, side: DoubleSide }),
  light: new MeshStandardMaterial({ color: 0xf4f1e6, emissive: 0xfff6e0, emissiveIntensity: 0.25, roughness: 0.2 }),
  tail: new MeshStandardMaterial({ color: 0x7a0e0e, emissive: 0xff2a1a, emissiveIntensity: 0.4, roughness: 0.3 }),
  signal: new MeshStandardMaterial({ color: 0xd9861f, emissive: 0xff8a1a, emissiveIntensity: 0.2, roughness: 0.3 }),
  disc: new MeshStandardMaterial({ color: 0x6b6e72, roughness: 0.45, metalness: 0.7 }),
  caliper: new MeshStandardMaterial({ color: 0xb02a20, roughness: 0.4 }),
  interior: new MeshStandardMaterial({ color: 0x2a2b2e, roughness: 0.9, side: DoubleSide }),
  cage: new MeshStandardMaterial({ color: 0x8e9296, roughness: 0.45, metalness: 0.6, side: DoubleSide }),
  plate: new MeshStandardMaterial({ color: 0xe9e7df, roughness: 0.6 }),
  red: new MeshStandardMaterial({ color: 0xc0261d, roughness: 0.4 }),
  bronze: new MeshStandardMaterial({ color: 0x7a5530, roughness: 0.35, metalness: 0.7 }),
};

/**
 * The back of every wheel, closed: several models leave the inside of the rim open, so a wheel turned
 * towards the camera showed its bare metal barrel. A rubber sidewall and, inside it, a dark plate where the
 * brake would be, flush so no metal shows between them; unit sized and scaled to each wheel, and only seen
 * where the model has nothing of its own.
 */
const WHEEL_BACK = {
  sidewall: new RingGeometry(0.68, 0.985, 40).rotateY(Math.PI / 2),
  plate: new CircleGeometry(0.685, 40).rotateY(Math.PI / 2),
  rubber: new MeshStandardMaterial({ color: 0x161616, roughness: 0.92, side: DoubleSide }),
  steel: new MeshStandardMaterial({ color: 0x232427, roughness: 0.7, metalness: 0.3, side: DoubleSide }),
};

function closeWheel(wheel: Mesh, side: number): void {
  if (!wheel.geometry.boundingBox) wheel.geometry.computeBoundingBox();
  const box = wheel.geometry.boundingBox as Box3;
  const radius = Math.max(box.max.y - box.min.y, box.max.z - box.min.z) / 2;
  const cy = (box.min.y + box.max.y) / 2,
    cz = (box.min.z + box.max.z) / 2;
  // The inner face is the one towards the middle of the car; a centimetre in, behind any sidewall it has.
  const inward = side > 0 ? -1 : 1;
  const face = (inward < 0 ? box.min.x : box.max.x) - inward * 0.012;
  const sidewall = new Mesh(WHEEL_BACK.sidewall, WHEEL_BACK.rubber);
  sidewall.position.set(face, cy, cz);
  sidewall.scale.setScalar(radius);
  const plate = new Mesh(WHEEL_BACK.plate, WHEEL_BACK.steel);
  plate.position.set(face - inward * 0.001, cy, cz);
  plate.scale.setScalar(radius);
  wheel.add(sidewall, plate);
}

type CarVisual = { kind: 'retro'; asset: CarAsset } | { kind: 'packed'; car: PackedCar } | { kind: 'box' };

/** Each car's model is fetched the first time it's picked, then kept. */
const visuals = new Map<string, Promise<CarVisual>>();
let visual: CarVisual = { kind: 'box' };
let visualId = 'retro';

const rig = {
  root: new Group(),
  /** Holds the model so its centre of mass sits on the physics origin. */
  body: new Group(),
  chassis: new Group(),
  wheels: [] as Mesh[],
  steerGroups: [] as (Group | null)[],
  paint: null as MeshStandardMaterial | null,
  /** Turns about `steerAxis`, which points from the hub to the driver. */
  steerWheel: null as Group | null,
  steerAxis: new Vector3(0, 0.3, -0.95).normalize(),
  /** Driver's eyes, in chassis space; null when the car has no cabin to sit in. */
  eye: null as Vector3 | null,
  /** How far the body sits below where it was modelled. */
  drop: 0,
  glass: [glassMaterial] as MeshStandardMaterial[],
  /** Everything made for this build that the next one throws away. */
  owned: [] as { dispose(): void }[],
};
scene.add(rig.root);

let cabinView = false;

async function loadVisual(spec: CarSpec): Promise<CarVisual> {
  if (spec.model) return { kind: 'packed', car: await loadPackedCar(spec.model, spec.id) };
  try {
    return { kind: 'retro', asset: await loadCarAsset() };
  } catch (err) {
    // The game still runs without the model, with a box for a car.
    console.warn('Car model failed, using a stand-in', err);
    return { kind: 'box' };
  }
}

function shapeOf(v: CarVisual): CarShape {
  if (v.kind !== 'packed') return RETRO_SHAPE;
  const { wheels, width, front, rear, length } = v.car;
  return {
    frontAxle: wheels[0].z,
    rearAxle: wheels[2].z,
    halfTrack: (wheels[0].x - wheels[1].x) / 2,
    RW: wheels[0].radius,
    width,
    nose: front,
    tail: rear,
    length,
  };
}

/** Fetches a car's model if needed and switches the physics to it. Rejects if a packed model won't load. */
export async function loadCar(id: string): Promise<{ spec: CarSpec; shape: CarShape }> {
  const spec = carById(id);
  if (!visuals.has(spec.id)) visuals.set(spec.id, loadVisual(spec));
  try {
    visual = await visuals.get(spec.id)!;
  } catch (err) {
    visuals.delete(spec.id);
    throw err;
  }
  visualId = spec.id;
  const shape = shapeOf(visual);
  useCar(spec, shape);
  return { spec, shape };
}

/** The axis a steering wheel turns about: the normal of its rim, the direction its points spread least. */
function steeringAxis(positions: ArrayLike<number>): Vector3 {
  const n = positions.length / 3;
  const mean = [0, 0, 0];
  for (let i = 0; i < positions.length; i++) mean[i % 3] += positions[i] / n;
  const c = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < 3; a++) {
      for (let b = 0; b < 3; b++) c[a][b] += ((positions[i * 3 + a] - mean[a]) * (positions[i * 3 + b] - mean[b])) / n;
    }
  }
  // Jacobi rotations until the covariance is diagonal; the columns of `v` are then its axes.
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let sweep = 0; sweep < 24; sweep++) {
    for (const [a, b] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ]) {
      if (Math.abs(c[a][b]) < 1e-12) continue;
      const theta = 0.5 * Math.atan2(2 * c[a][b], c[b][b] - c[a][a]);
      const cs = Math.cos(theta);
      const sn = Math.sin(theta);
      for (let k = 0; k < 3; k++) {
        const x = c[k][a];
        const y = c[k][b];
        c[k][a] = cs * x - sn * y;
        c[k][b] = sn * x + cs * y;
      }
      for (let k = 0; k < 3; k++) {
        const x = c[a][k];
        const y = c[b][k];
        c[a][k] = cs * x - sn * y;
        c[b][k] = sn * x + cs * y;
      }
      for (let k = 0; k < 3; k++) {
        const x = v[k][a];
        const y = v[k][b];
        v[k][a] = cs * x - sn * y;
        v[k][b] = sn * x + cs * y;
      }
    }
  }
  let least = 0;
  for (let k = 1; k < 3; k++) if (c[k][k] < c[least][least]) least = k;
  const axis = new Vector3(v[0][least], v[1][least], v[2][least]).normalize();
  // Towards the driver, who sits behind it.
  return axis.z > 0 ? axis.negate() : axis;
}

/** Where the driver's eyes are, from the steering wheel: back along the floor and up, under the roof. */
function eyeFrom(hub: Vector3, axis: Vector3, roof: number): Vector3 {
  const back = new Vector3(axis.x, 0, axis.z).normalize();
  const eye = hub.clone().addScaledVector(back, 0.5);
  eye.y = Math.min(hub.y + 0.29, roof - 0.14);
  return eye;
}

function boxOfRetro(asset: CarAsset): CarBox {
  const bounds = new Box3();
  for (const part of asset.body) bounds.union(part.geo.boundingBox!);
  const [frontLeft, , rearLeft] = asset.wheels;
  const radius = frontLeft.geo.boundingBox!.max.y;
  return {
    rear: bounds.min.z,
    front: bounds.max.z,
    halfWidth: (bounds.max.x - bounds.min.x) / 2,
    height: bounds.max.y,
    beltline: bounds.max.y * 0.66,
    frontAxle: frontLeft.pos.z,
    rearAxle: rearLeft.pos.z,
    wheelRadius: radius,
  };
}

/** The packed car's glass points, for the beltline and the windscreen. */
function glassPoints(packed: PackedCar): number[] {
  const { geometry, groups } = packed.body;
  const position = geometry.attributes.position.array;
  const index = geometry.index!.array;
  const out: number[] = [];
  for (const g of groups) {
    if (g.kind !== 'glass') continue;
    for (let i = g.start; i < g.start + g.count; i++) {
      const v = index[i] * 3;
      out.push(position[v], position[v + 1], position[v + 2]);
    }
  }
  return out;
}

function boxOfPacked(packed: PackedCar, glass: number[]): CarBox {
  let beltline = packed.height * 0.66;
  for (let i = 1; i < glass.length; i += 3) beltline = Math.min(beltline, glass[i]);
  return {
    rear: packed.rear,
    front: packed.front,
    halfWidth: packed.width / 2,
    height: packed.height,
    beltline,
    frontAxle: packed.wheels[0].z,
    rearAxle: packed.wheels[2].z,
    wheelRadius: packed.wheels[0].radius,
  };
}

/** Top edge of the windscreen and half its width there. */
function windscreenOf(glass: number[]): [halfWidth: number, top: number] {
  let front = -Infinity;
  for (let i = 2; i < glass.length; i += 3) front = Math.max(front, glass[i]);
  let top = -Infinity;
  for (let i = 0; i < glass.length; i += 3) if (glass[i + 2] > front - 0.9) top = Math.max(top, glass[i + 1]);
  let halfWidth = 0.4;
  for (let i = 0; i < glass.length; i += 3) {
    if (glass[i + 2] > front - 0.9 && glass[i + 1] > top - 0.12) halfWidth = Math.max(halfWidth, Math.abs(glass[i]));
  }
  return [halfWidth, top];
}

/** Puts a wheel on the car: a steering group at the hub, and inside it the wheel and caliper at their camber. */
function mountWheel(i: number, at: Vector3, wheel: Mesh, hub: Mesh | null, drift: boolean): void {
  const group = new Group();
  group.position.copy(at);
  const tilt = new Group();
  if (drift) {
    group.position.x += Math.sign(at.x) * DRIFT_SPACER[i < 2 ? 0 : 1];
    tilt.rotation.z = camberOf(visualId, i, at.x);
  }
  group.add(tilt);
  closeWheel(wheel, at.x);
  tilt.add(wheel);
  if (hub) tilt.add(hub);
  rig.body.add(group);
  rig.steerGroups.push(i < 2 ? group : null);
  rig.wheels.push(wheel);
}

/** (Re)builds the current car in a colour, in the stock or drift look. */
export function buildCar(colour: number): void {
  const { root } = rig;
  while (root.children.length) root.remove(root.children[0]);
  rig.body = new Group();
  rig.body.position.z = -CAR.modelOffset;
  root.add(rig.body);
  rig.chassis = new Group();
  rig.body.add(rig.chassis);
  rig.wheels = [];
  rig.steerGroups = [];
  rig.steerWheel = null;
  rig.eye = null;
  rig.paint?.dispose();
  rig.owned.forEach((thing) => thing.dispose());
  rig.owned = [];
  rig.glass = [glassMaterial];
  const drift = style === 'drift' && visual.kind !== 'box';
  rig.drop = drift ? DRIFT_DROP : 0;

  if (visual.kind === 'packed') {
    const packed = visual.car;
    const glass = glassPoints(packed);
    const box = boxOfPacked(packed, glass);
    const livery = drift ? paintLivery(visualId, colour, box) : null;
    const paint = bodyPaint(colour, livery, box);
    rig.paint = paint;
    const finishes: Partial<Record<Finish, Material>> = {};
    if (drift && livery) {
      rig.owned.push(livery);
      const { rim, cage } = driftFinishes(visualId);
      const [screenHalf, screenTop] = windscreenOf(glass);
      const banner = bannerGlass(glassMaterial, livery.banner, screenHalf, screenTop);
      Object.assign(finishes, { rim, cage, bronze: rim, glass: banner });
      rig.glass.push(banner);
      rig.owned.push(rim, cage, banner);
    }
    const materials = (groups: PackedCar['body']['groups']) =>
      groups.map((g) => (g.kind === 'paint' ? paint : (finishes[g.kind] ?? FINISHES[g.kind])));
    const { body, interior, steer, wheelMeshes, hubs } = packed;
    const shell = new Mesh(body.geometry, materials(body.groups));
    shell.castShadow = true;
    rig.chassis.add(shell);
    if (interior) rig.chassis.add(new Mesh(interior.geometry, materials(interior.groups)));
    if (steer) {
      const hub = new Vector3(...steer.origin);
      rig.steerAxis = steeringAxis(steer.geometry.attributes.position.array);
      rig.steerWheel = new Group();
      rig.steerWheel.position.copy(hub);
      rig.steerWheel.add(new Mesh(steer.geometry, materials(steer.groups)));
      rig.chassis.add(rig.steerWheel);
      rig.eye = eyeFrom(hub, rig.steerAxis, box.height);
    }
    if (drift) addAero(body.geometry.attributes.position.array, box);
    wheelMeshes.forEach((wheel, i) => {
      const mesh = new Mesh(wheel.geometry, materials(wheel.groups));
      mesh.castShadow = true;
      const hub = hubs[i];
      mountWheel(i, new Vector3(...wheel.origin), mesh, hub ? new Mesh(hub.geometry, materials(hub.groups)) : null, drift);
    });
    applyCabinView();
    return;
  }

  const asset = visual.kind === 'retro' ? visual.asset : null;
  if (asset) {
    const box = boxOfRetro(asset);
    const livery = drift ? paintLivery(visualId, colour, box) : null;
    if (livery) rig.owned.push(livery);
    const paint = createPaintMaterial(asset, colour, livery, box);
    rig.paint = paint;
    const materialsFor = (glass: boolean[]) =>
      glass.length > 1 ? glass.map((isGlass) => (isGlass ? glassMaterial : paint)) : glass[0] ? glassMaterial : paint;
    const points: number[] = [];
    for (const part of asset.body) {
      const mesh = new Mesh(part.geo, materialsFor(part.glass));
      mesh.castShadow = true;
      rig.chassis.add(mesh);
      if (drift) {
        const position = part.geo.attributes.position.array;
        for (let i = 0; i < position.length; i++) points.push(position[i]);
      }
    }
    if (asset.steering) {
      rig.steerAxis = steeringAxis(asset.steering.geo.attributes.position.array);
      rig.steerWheel = new Group();
      rig.steerWheel.position.copy(asset.steering.pos);
      rig.steerWheel.add(new Mesh(asset.steering.geo, materialsFor(asset.steering.glass)));
      rig.chassis.add(rig.steerWheel);
      rig.eye = eyeFrom(asset.steering.pos, rig.steerAxis, box.height);
    }
    if (drift) addAero(points, box);
    asset.wheels.forEach((wheel, i) => {
      const mesh = new Mesh(wheel.geo, materialsFor(wheel.glass));
      mesh.castShadow = true;
      mountWheel(i, wheel.pos, mesh, null, drift);
    });
  } else {
    const paint = new MeshStandardMaterial({ color: colour });
    rig.paint = paint;
    const box = new Mesh(new BoxGeometry(1.7, 0.6, 4.6), paint);
    box.position.y = 0.6;
    box.castShadow = true;
    rig.chassis.add(box);
  }
  applyCabinView();
}

/** Drift parts fitted to the body, on the chassis so they roll with it. */
function addAero(points: BodyPoints, box: CarBox): void {
  const parts = aeroParts(visualId, points, box, { carbon: FINISHES.carbon, red: FINISHES.red });
  parts.traverse((object) => {
    if (object instanceof Mesh) rig.owned.push(object.geometry);
  });
  rig.chassis.add(parts);
}

/** Clearer glass from inside, as the windows look from the driver's seat. */
export function setCabinView(inside: boolean): void {
  cabinView = inside;
  applyCabinView();
}

function applyCabinView(): void {
  for (const glass of rig.glass) glass.opacity = cabinView ? 0.13 : 0.5;
}

const eyeWorld = new Vector3();

/**
 * The driver's head for the inside camera: where it is and how it's turned, leaning back a little under
 * acceleration and out of a corner. False when the car has nowhere to sit.
 */
export function driverView(pos: Vector3, quat: Quaternion): boolean {
  if (!rig.eye) return false;
  rig.chassis.updateWorldMatrix(true, false);
  eyeWorld.copy(rig.eye);
  eyeWorld.x += clamp(car.ayb * 0.004, -0.04, 0.04);
  eyeWorld.z -= clamp(car.axb * 0.003, -0.03, 0.03);
  pos.copy(rig.chassis.localToWorld(eyeWorld));
  rig.chassis.getWorldQuaternion(quat);
  return true;
}

const UP = new Vector3(0, 1, 0);
const groundUp = new Vector3();
const tilt = new Quaternion();
const heading = new Quaternion();

/** Moves the visual car to the physics state, with body roll, pitch and wheel motion. */
export function syncCar(dt: number): void {
  // Stand on the ground and lean with it: turn to the heading, then tip onto the slope.
  rig.root.position.set(car.x, heightAt(car.x, car.z), car.z);
  const [riseX, riseZ] = slopeAt(car.x, car.z);
  groundUp.set(-riseX, 1, -riseZ).normalize();
  tilt.setFromUnitVectors(UP, groundUp);
  heading.setFromAxisAngle(UP, car.th);
  rig.root.quaternion.multiplyQuaternions(tilt, heading);
  const roll = clamp(-car.ayb * 0.011, -0.07, 0.07);
  const pitch = clamp(car.axb * 0.009, -0.05, 0.05);
  rig.chassis.rotation.z = lerp(rig.chassis.rotation.z, roll, 1 - Math.exp(-dt * 8));
  rig.chassis.rotation.x = lerp(rig.chassis.rotation.x, pitch, 1 - Math.exp(-dt * 8));
  const speed = Math.hypot(car.vx, car.vz);
  rig.chassis.position.y = -rig.drop + (car.onKerb ? Math.sin(performance.now() * 0.09) * 0.012 * clamp(speed / 10, 0, 1) : 0);
  rig.wheels.forEach((wheel, i) => {
    wheel.rotation.x = car.wheelRot[i];
  });
  rig.steerGroups.forEach((group) => {
    if (group) group.rotation.y = car.delta * 0.85;
  });
  rig.steerWheel?.quaternion.setFromAxisAngle(rig.steerAxis, car.delta * STEERING_RATIO);
  const braking = controls.brake > 0.1 || controls.hand;
  if (rig.paint?.userData?.u) rig.paint.userData.u.lightsR.value = braking ? 2.2 : 1;
  FINISHES.tail.emissiveIntensity = braking ? 2.4 : 0.4;
}
