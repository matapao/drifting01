// Reads the game's own .car files, made by tools/pack-cars.mjs: compressed, scrambled car geometry.

import { BufferAttribute, BufferGeometry } from 'three';
import { unzlibSync } from 'three/addons/libs/fflate.module.js';

/** The finishes the packer sorts triangles into; the game picks a material for each. */
export type Finish =
  | 'paint' | 'glass' | 'lamp' | 'tyre' | 'rim' | 'chrome' | 'trim' | 'plastic' | 'metal' | 'carbon'
  | 'light' | 'tail' | 'signal' | 'disc' | 'caliper' | 'interior' | 'cage' | 'plate' | 'red' | 'bronze';

export interface PackedMesh {
  geometry: BufferGeometry;
  groups: { kind: Finish; start: number; count: number }[];
  /** Where the mesh's own origin sits on the car: a wheel's centre, or 0 for the body. */
  origin: [number, number, number];
}

export interface PackedCar {
  length: number;
  width: number;
  height: number;
  /** Nose and tail along the car, measured from the middle of the wheelbase. */
  front: number;
  rear: number;
  /** Front pair then rear pair, +x side first, as the physics numbers its wheels. */
  wheels: { x: number; y: number; z: number; radius: number }[];
  body: PackedMesh;
  /** Seats, dashboard and cage, seen through the glass. */
  interior: PackedMesh | null;
  /** The steering wheel, centred on its hub so it can turn. */
  steer: PackedMesh | null;
  wheelMeshes: PackedMesh[];
  /** Brake calipers: they steer with a front wheel but don't spin. */
  hubs: (PackedMesh | null)[];
}

interface MeshRecord {
  name: string;
  origin: [number, number, number];
  min: [number, number, number];
  size: [number, number, number];
  vertices: number;
  positions: number;
  normals: number;
  indices: number;
  indexCount: number;
  wide: boolean;
  groups: PackedMesh['groups'];
}

/** Undoes the packer's scrambling: an xorshift stream keyed by the car's id. Applying it twice restores. */
function scramble(bytes: Uint8Array, id: string): void {
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

export function decodePackedCar(file: Uint8Array, id: string): PackedCar {
  if (String.fromCharCode(...file.subarray(0, 4)) !== 'DRFT') throw new Error(`${id}.car is not a car file`);
  const packed = file.slice(8);
  scramble(packed, id);
  const body = unzlibSync(packed);
  const jsonLength = new DataView(body.buffer, body.byteOffset, 4).getUint32(0, true);
  const info = JSON.parse(new TextDecoder().decode(body.subarray(4, 4 + jsonLength)));
  const base = 4 + jsonLength + ((4 - (jsonLength % 4)) % 4);
  // Copy each array out: the views into the inflated buffer aren't guaranteed to be aligned.
  const bytesAt = (offset: number, length: number) => body.slice(base + offset, base + offset + length).buffer;

  const meshes = new Map<string, PackedMesh>();
  for (const m of info.meshes as MeshRecord[]) {
    const q = new Uint16Array(bytesAt(m.positions, m.vertices * 6));
    const n = new Int8Array(bytesAt(m.normals, m.vertices * 3));
    const positions = new Float32Array(m.vertices * 3);
    const normals = new Float32Array(m.vertices * 3);
    for (let i = 0; i < positions.length; i++) {
      const axis = i % 3;
      positions[i] = m.min[axis] + (q[i] / 65535) * m.size[axis];
      normals[i] = n[i] / 127;
    }
    const indices = m.wide
      ? new Uint32Array(bytesAt(m.indices, m.indexCount * 4))
      : new Uint16Array(bytesAt(m.indices, m.indexCount * 2));
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new BufferAttribute(normals, 3));
    geometry.setIndex(new BufferAttribute(indices, 1));
    m.groups.forEach((g, i) => geometry.addGroup(g.start, g.count, i));
    geometry.computeBoundingSphere();
    meshes.set(m.name, { geometry, groups: m.groups, origin: m.origin });
  }

  const wheelMeshes = [0, 1, 2, 3].map((i) => meshes.get('wheel' + i)!);
  if (!meshes.get('body') || wheelMeshes.some((w) => !w)) throw new Error(`${id}.car is missing parts`);
  return {
    length: info.length,
    width: info.width,
    height: info.height,
    front: info.front,
    rear: info.rear,
    wheels: info.wheels,
    body: meshes.get('body')!,
    interior: meshes.get('interior') ?? null,
    steer: meshes.get('steer') ?? null,
    wheelMeshes,
    hubs: [0, 1, 2, 3].map((i) => meshes.get('hub' + i) ?? null),
  };
}

export async function loadPackedCar(url: string, id: string): Promise<PackedCar> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${id}.car did not load (${response.status})`);
  return decodePackedCar(new Uint8Array(await response.arrayBuffer()), id);
}
