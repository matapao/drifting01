// Packs downloaded car models into the game's own .car format, in src/assets/cars.
//
// Each car keeps only what can be seen from outside, simplified for phones, scaled to the real car, with the
// wheels split out so they can spin and steer. The result is compressed and scrambled: the CGTrader Royalty
// Free licence only allows models in a game inside a proprietary format that players can't simply download.
//
//   node tools/pack-cars.mjs            pack every car
//   node tools/pack-cars.mjs r32        pack one
//
// The source models stay where they were downloaded and are never served: only the .car files ship.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'src/assets/cars');

// three's loaders expect a browser; these stand-ins are enough for parsing geometry in Node.
globalThis.window ??= globalThis;
globalThis.self ??= globalThis;
globalThis.document ??= { createElementNS: () => ({ addEventListener() {}, removeEventListener() {}, set src(v) {}, style: {} }) };
const THREE = await import('three');
const { mergeVertices, toCreasedNormals } = await import('three/addons/utils/BufferGeometryUtils.js');
const { MeshoptSimplifier } = await import('meshoptimizer');
await MeshoptSimplifier.ready;

/** Material names to the handful of finishes the game draws. Anything unmatched is dark plastic. */
const KIND_RULES = [
  [/paint/i, 'paint'],
  [/headlightglass/i, 'lamp'],
  [/window|widnow|glass|windshield/i, 'glass'],
  [/tyre|tire/i, 'tyre'],
  [/brake ?caliper|brakecaliper|caliper/i, 'caliper'],
  [/brakedisc|^brake$|disc/i, 'disc'],
  [/rims?$|silver|wheelcolou?r/i, 'rim'],
  [/chrome|exhaust/i, 'chrome'],
  [/taillight|brakelight|rear lights/i, 'tail'],
  [/signal|orange|foglight|indicator/i, 'signal'],
  [/headlights?(\.00[01])?$|reverse|glow|rear light$/i, 'light'],
  [/carbon/i, 'carbon'],
  [/blackgloss|gloss black|sunstrip/i, 'trim'],
  [/seat|leather|carpet|interior|steer|cupholder/i, 'interior'],
  [/rollcage/i, 'cage'],
  [/licenseplate|^white$|material\.001/i, 'plate'],
  [/^(ae86\.)?red$|towing/i, 'red'],
  [/brown/i, 'bronze'],
  [/gray|grey|engine|purple|metal|nut/i, 'metal'],
];
const kindOf = (name) => KIND_RULES.find(([re]) => re.test(name))?.[1] ?? 'plastic';

/** The AE86's cabin: seats, dashboard, steering wheel, levers, mirror and roll cage. Its carpet is in the body. */
const CABIN = /Seat\.|Dash_int|Steer_chassis|Shifter_int|Handbrake_int|Rollcage|Mirror_int/;
/** The steering wheel, packed on its own so the game can turn it. */
const STEERING_WHEEL = /Steer_chassis/;

const CARS = [
  {
    id: 'ae86',
    file: "Fujiwara's+Hachiroku.obj",
    // Already in metres. Keep the shell, glass, lights, wheels, brakes and cabin; leave out the engine bay,
    // suspension, and the Initial D tofu-shop lettering and Toyota badges.
    keep: /Body_chassis|Fender|Hood|Door\.|Tailgate|Bumper|Lip_|Mirror\.[LR]_|Window|Glass|Windshield|Backlight|Headlight\.L|Taillight|Foglight|Mudflaps|LicensePlate|WheelBrake|Wheel\.|Exhaust_|Seat\.|Dash_int|Steer_chassis|Shifter_int|Handbrake_int|Rollcage|Mirror_int/,
    wheel: /Wheel\.(Ft|Bk)\.[LR]_/,
    hub: /WheelBrake/,
    cabin: CABIN,
    steer: STEERING_WHEEL,
    cabinMaterials: /Carpet/,
    bodyTriangles: 26000,
    wheelTriangles: 1400,
  },
  {
    id: 'r32',
    file: 'Skyline_R32.fbx',
    length: 4.545,
    keep: /./,
    wheel: /^Circle/,
    // Modelled without a cabin: it gets the AE86's, fitted to its windows. Right-hand drive, as in Japan.
    fitCabin: true,
    // The black panel that filled the empty cabin at window height (in model units) would hide it.
    skip: (material, centre) => material === 'dummy' && centre.y > 45,
    // Its round tail lamps use the headlight material; at the back of the car they're red.
    finish: (material, centre) => (material === 'headlights' && centre.z < -100 ? 'tail' : null),
    bodyTriangles: 14000,
    wheelTriangles: 1400,
  },
  {
    id: 'e30',
    file: 'E30 Export.fbx',
    // Modelled nose along +x: turn it to face +z, and size it by the real 2.57 m wheelbase.
    yaw: -Math.PI / 2,
    wheelbase: 2.57,
    keep: /./,
    wheel: /Wheel$/,
    spin: /Disc$/,
    hub: /Caliper$/,
    // No cabin either; the fitted one is mirrored for a left-hand-drive European car.
    fitCabin: true,
    leftHand: true,
    bodyTriangles: 16000,
    wheelTriangles: 1400,
  },
];

async function loadModel(file) {
  const full = path.join(ROOT, file);
  if (file.endsWith('.fbx')) {
    const { FBXLoader } = await import('three/addons/loaders/FBXLoader.js');
    const buf = fs.readFileSync(full);
    const manager = new THREE.LoadingManager();
    manager.setURLModifier(() => 'data:image/png;base64,');
    return new FBXLoader(manager).parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
  }
  const { OBJLoader } = await import('three/addons/loaders/OBJLoader.js');
  // OBJLoader turns any object that also has line elements into lines and drops its faces, so strip them.
  const text = fs.readFileSync(full, 'utf8').replace(/^l .*$/gm, '');
  return new OBJLoader().parse(text);
}

/** Every visible triangle, in world space, sorted into buckets by part and finish. */
function collect(model, car) {
  if (car.yaw) model.rotation.y = car.yaw;
  model.updateMatrixWorld(true);
  const wheelMeshes = [];
  model.traverse((mesh) => {
    if (mesh.isMesh && car.keep.test(mesh.name) && car.wheel.test(mesh.name)) wheelMeshes.push(mesh);
  });
  const centreOf = (mesh) => new THREE.Box3().setFromObject(mesh).getCenter(new THREE.Vector3());
  const wheelCentres = wheelMeshes.map(centreOf);
  /** The wheel a separate disc or caliper belongs to. */
  const nearestWheel = (mesh) => {
    const c = centreOf(mesh);
    let best = 0;
    wheelCentres.forEach((w, i) => (w.distanceTo(c) < wheelCentres[best].distanceTo(c) ? (best = i) : 0));
    return wheelMeshes[best].uuid;
  };

  const buckets = new Map();
  const add = (part, kind, a, b, c) => {
    const key = part + '|' + kind;
    if (!buckets.has(key)) buckets.set(key, { part, kind, positions: [] });
    buckets.get(key).positions.push(...a, ...b, ...c);
  };
  model.traverse((mesh) => {
    if (!mesh.isMesh || !car.keep.test(mesh.name)) return;
    const geometry = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry;
    const pos = geometry.attributes.position;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const groups = geometry.groups.length ? geometry.groups : [{ start: 0, count: pos.count, materialIndex: 0 }];
    const isWheel = car.wheel.test(mesh.name);
    const isCabin = car.cabin?.test(mesh.name);
    const isSteer = car.steer?.test(mesh.name);
    // Discs spin with their wheel; calipers steer with it but stay put.
    const attach = isWheel ? null : car.spin?.test(mesh.name) ? 'wheel:' : car.hub?.test(mesh.name) ? 'hub:' : null;
    const v = new THREE.Vector3();
    const corner = (i) => v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld).toArray();
    for (const group of groups) {
      const material = materials[group.materialIndex ?? 0]?.name ?? '';
      const kind = kindOf(material);
      const part = isSteer
        ? 'steer'
        : isCabin || car.cabinMaterials?.test(material)
        ? 'interior'
        : isWheel
        ? (kind === 'caliper' ? 'hub:' : 'wheel:') + mesh.uuid
        : attach
          ? attach + nearestWheel(mesh)
          : 'body';
      for (let i = group.start; i < group.start + group.count; i += 3) {
        const a = corner(i), b = corner(i + 1), c = corner(i + 2);
        const centre = { x: (a[0] + b[0] + c[0]) / 3, y: (a[1] + b[1] + c[1]) / 3, z: (a[2] + b[2] + c[2]) / 3 };
        if (car.skip?.(material, centre)) continue;
        add(part, car.finish?.(material, centre) ?? kind, a, b, c);
      }
    }
  });
  return { buckets: [...buckets.values()], wheelMeshes };
}

/** Welds, simplifies to about `ratio` of the triangles, then rebuilds normals with sharp creases kept. */
function simplify(positions, ratio) {
  let geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry = mergeVertices(geometry, 1e-5);
  const index = new Uint32Array(geometry.index.array);
  const vertices = new Float32Array(geometry.attributes.position.array);
  const target = Math.max(3, Math.floor((index.length * ratio) / 3) * 3);
  let [kept] = ratio < 1 ? MeshoptSimplifier.simplify(index, vertices, 3, target, 0.01, ['LockBorder']) : [index];
  // Some finishes are a mess of tiny separate pieces that won't simplify; go rougher there.
  if (ratio < 1 && kept.length > target * 1.6) [kept] = MeshoptSimplifier.simplify(index, vertices, 3, target, 0.03, ['Prune']);
  geometry.setIndex(new THREE.BufferAttribute(kept, 1));
  const flat = toCreasedNormals(geometry.toNonIndexed(), Math.PI / 5);
  return mergeVertices(flat, 1e-5);
}

function pack(car, parts, info) {
  // Binary: per geometry, quantised positions, normals as bytes, and 16 or 32 bit indices.
  const chunks = [];
  let offset = 0;
  const push = (array) => {
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    const start = offset;
    chunks.push(bytes);
    offset += bytes.length;
    const pad = (4 - (offset % 4)) % 4;
    if (pad) {
      chunks.push(new Uint8Array(pad));
      offset += pad;
    }
    return start;
  };
  const meshes = parts.map(({ name, groups, geometry, origin }) => {
    const pos = geometry.attributes.position;
    const nrm = geometry.attributes.normal;
    geometry.computeBoundingBox();
    const { min, max } = geometry.boundingBox;
    const size = max.clone().sub(min);
    const q = new Uint16Array(pos.count * 3);
    const n = new Int8Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      for (let a = 0; a < 3; a++) {
        const lo = min.getComponent(a);
        const span = size.getComponent(a) || 1;
        q[i * 3 + a] = Math.round(((pos.array[i * 3 + a] - lo) / span) * 65535);
        n[i * 3 + a] = Math.round(nrm.array[i * 3 + a] * 127);
      }
    }
    const index = geometry.index.array;
    const wide = pos.count > 65535;
    return {
      name,
      origin,
      min: min.toArray(),
      size: size.toArray(),
      vertices: pos.count,
      positions: push(q),
      normals: push(n),
      indices: push(wide ? new Uint32Array(index) : new Uint16Array(index)),
      indexCount: index.length,
      wide,
      groups,
    };
  });
  const json = new TextEncoder().encode(JSON.stringify({ ...info, meshes }));
  const head = new Uint8Array(4);
  new DataView(head.buffer).setUint32(0, json.length, true);
  const body = Buffer.concat([head, json, new Uint8Array((4 - (json.length % 4)) % 4), ...chunks]);
  const packed = zlib.deflateSync(body, { level: 9 });
  scramble(packed, car.id);
  return Buffer.concat([Buffer.from('DRFT'), Buffer.from([1, 0, 0, 0]), packed]);
}

/** The same xorshift stream as src/car-pack.ts: undoing it needs the game's own key. */
export function scramble(bytes, id) {
  let s = 0x9e3779b9;
  for (const c of 'drifting01:' + id) s = Math.imul(s ^ c.charCodeAt(0), 0x01000193) >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    bytes[i] ^= s & 0xff;
  }
}

/** Loads a car and puts every bucket into the car's own space: metres, on the ground, centred between the axles. */
async function prepare(car) {
  const model = await loadModel(car.file);
  const { buckets, wheelMeshes } = collect(model, car);

  const all = new THREE.Box3();
  for (const b of buckets) for (let i = 0; i < b.positions.length; i += 3) all.expandByPoint(new THREE.Vector3(b.positions[i], b.positions[i + 1], b.positions[i + 2]));
  const wheelBoxes = wheelMeshes.map((mesh) => {
    const box = new THREE.Box3().setFromObject(mesh);
    return { uuid: mesh.uuid, centre: box.getCenter(new THREE.Vector3()), radius: (box.max.y - box.min.y) / 2 };
  });
  const front = Math.max(...wheelBoxes.map((w) => w.centre.z));
  const rear = Math.min(...wheelBoxes.map((w) => w.centre.z));
  const scale = car.length ? car.length / (all.max.z - all.min.z) : car.wheelbase ? car.wheelbase / (front - rear) : 1;
  const origin = new THREE.Vector3((all.min.x + all.max.x) / 2, all.min.y, (front + rear) / 2);
  const toCar = (x, y, z) => [(x - origin.x) * scale, (y - origin.y) * scale, (z - origin.z) * scale];
  for (const b of buckets) {
    const p = new Float32Array(b.positions.length);
    for (let i = 0; i < p.length; i += 3) p.set(toCar(b.positions[i], b.positions[i + 1], b.positions[i + 2]), i);
    b.positions = p;
  }

  // Wheels in game order: front pair then rear pair, +x side first.
  const isFront = (w) => w.centre.z > (front + rear) / 2;
  const order = [...wheelBoxes].sort((a, b) => Number(isFront(b)) - Number(isFront(a)) || b.centre.x - a.centre.x);
  const wheelInfo = order.map((w) => ({ uuid: w.uuid, centre: toCar(w.centre.x, w.centre.y, w.centre.z), radius: w.radius * scale }));
  return { buckets, wheelInfo };
}

/** The glasshouse, which says where a cabin goes: half width, roof, lowest glass, and the windscreen's foot. */
function cabinOf(buckets) {
  const c = { halfWidth: 0, roof: -Infinity, sill: Infinity, screen: -Infinity };
  for (const b of buckets) {
    if (b.kind !== 'glass' || b.part !== 'body') continue;
    for (let i = 0; i < b.positions.length; i += 3) {
      c.halfWidth = Math.max(c.halfWidth, Math.abs(b.positions[i]));
      c.roof = Math.max(c.roof, b.positions[i + 1]);
      c.sill = Math.min(c.sill, b.positions[i + 1]);
      c.screen = Math.max(c.screen, b.positions[i + 2]);
    }
  }
  return c;
}

let kitPromise = null;
/** The AE86's cabin, with the AE86's glasshouse to fit it by. Loaded once. */
const cabinKit = () =>
  (kitPromise ??= prepare(CARS.find((c) => c.id === 'ae86')).then(({ buckets }) => ({
    cabin: cabinOf(buckets),
    buckets: buckets.filter((b) => b.part === 'interior' || b.part === 'steer'),
  })));

/**
 * Fits the AE86's cabin inside another car: across and along by the ratio of the glasshouse widths, up and
 * down between the lowest glass and the roof, with the dashboard set against the windscreen. Mirrored across
 * for left-hand drive, which also reverses each triangle so it still faces outwards.
 */
async function fitCabin(car, buckets) {
  const kit = await cabinKit();
  const to = cabinOf(buckets);
  const across = (to.halfWidth / kit.cabin.halfWidth) * 0.97;
  const up = (to.roof - 0.03 - to.sill) / (kit.cabin.roof - kit.cabin.sill);
  const side = car.leftHand ? -1 : 1;
  for (const k of kit.buckets) {
    const src = k.positions;
    const out = new Float32Array(src.length);
    for (let t = 0; t < src.length; t += 9) {
      const corners = car.leftHand ? [0, 2, 1] : [0, 1, 2];
      corners.forEach((c, slot) => {
        const i = t + c * 3;
        const o = t + slot * 3;
        out[o] = side * src[i] * across;
        out[o + 1] = to.sill + (src[i + 1] - kit.cabin.sill) * up;
        out[o + 2] = to.screen + (src[i + 2] - kit.cabin.screen) * across;
      });
    }
    buckets.push({ part: k.part, kind: k.kind === 'cage' ? 'cage' : 'interior', positions: out });
  }
}

/** Middle of the steering wheel: its points' centroid, which the rim and spokes keep on the hub. */
function steeringCentre(buckets) {
  const sum = [0, 0, 0];
  let count = 0;
  for (const b of buckets) {
    if (b.part !== 'steer') continue;
    for (let i = 0; i < b.positions.length; i += 3) {
      sum[0] += b.positions[i];
      sum[1] += b.positions[i + 1];
      sum[2] += b.positions[i + 2];
      count++;
    }
  }
  return count ? sum.map((s) => s / count) : null;
}

async function packCar(car) {
  const { buckets, wheelInfo } = await prepare(car);
  if (car.fitCabin) await fitCabin(car, buckets);

  const parts = [];
  const build = (name, filter, triangles, centre) => {
    const mine = buckets.filter(filter);
    const total = mine.reduce((sum, b) => sum + b.positions.length / 9, 0);
    if (!total) return;
    const ratio = Math.min(1, triangles / total);
    const pieces = mine.map((b) => {
      const p = new Float32Array(b.positions.length);
      for (let i = 0; i < p.length; i += 3) {
        p[i] = b.positions[i] - centre[0];
        p[i + 1] = b.positions[i + 1] - centre[1];
        p[i + 2] = b.positions[i + 2] - centre[2];
      }
      return { kind: b.kind, geometry: simplify(p, ratio) };
    });
    // One geometry per part, one group per finish.
    const positions = [];
    const normals = [];
    const indices = [];
    const groups = [];
    for (const { kind, geometry } of pieces.sort((a, b) => a.kind.localeCompare(b.kind))) {
      const base = positions.length / 3;
      positions.push(...geometry.attributes.position.array);
      normals.push(...geometry.attributes.normal.array);
      groups.push({ kind, start: indices.length, count: geometry.index.count });
      for (const i of geometry.index.array) indices.push(i + base);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    geometry.setIndex(indices);
    parts.push({ name, groups, geometry, origin: centre, before: total, after: indices.length / 3 });
  };
  build('body', (b) => b.part === 'body', car.bodyTriangles, [0, 0, 0]);
  build('interior', (b) => b.part === 'interior', 5000, [0, 0, 0]);
  const steer = steeringCentre(buckets);
  if (steer) build('steer', (b) => b.part === 'steer', 1500, steer);
  wheelInfo.forEach((w, i) => {
    build('wheel' + i, (b) => b.part === 'wheel:' + w.uuid, car.wheelTriangles, w.centre);
    build('hub' + i, (b) => b.part === 'hub:' + w.uuid, 200, w.centre);
  });

  const box = new THREE.Box3();
  for (const p of parts) {
    p.geometry.computeBoundingBox();
    box.union(p.geometry.boundingBox.clone().translate(new THREE.Vector3(...p.origin)));
  }
  const size = box.getSize(new THREE.Vector3());
  const info = {
    id: car.id,
    length: +size.z.toFixed(3),
    width: +size.x.toFixed(3),
    height: +size.y.toFixed(3),
    front: +box.max.z.toFixed(3),
    rear: +box.min.z.toFixed(3),
    wheels: wheelInfo.map((w) => ({ x: +w.centre[0].toFixed(4), y: +w.centre[1].toFixed(4), z: +w.centre[2].toFixed(4), radius: +w.radius.toFixed(4) })),
  };
  const file = pack(car, parts, info);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, car.id + '.car'), file);
  const triangles = parts.reduce((sum, p) => sum + p.after, 0);
  console.log(
    `${car.id}: ${parts.map((p) => `${p.name} ${Math.round(p.before)}→${p.after}`).join(', ')}\n` +
      `  ${triangles} triangles, ${(file.length / 1024).toFixed(0)} KB, ${info.length} × ${info.width} × ${info.height} m, ` +
      `wheelbase ${(info.wheels[0].z - info.wheels[2].z).toFixed(3)} m, track ${(info.wheels[0].x - info.wheels[1].x).toFixed(3)} m, tyre radius ${info.wheels[0].radius} m`,
  );
}

const only = process.argv[2];
for (const car of CARS) if (!only || car.id === only) await packCar(car);
