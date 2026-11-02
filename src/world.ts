import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Float32BufferAttribute,
  type Fog,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  LinearMipmapLinearFilter,
  type Material,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  SRGBColorSpace,
  TorusGeometry,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { addAsphaltDetail } from './asphalt';
import { groundAt, isRoadside } from './ground';
import { lerp, seededRandom, TAU } from './math';
import { colliders } from './physics';
import { renderer, scene } from './stage';
import type { HitKind } from './state';
import { heightAt } from './terrain';
import { edgePoint, forEachKerb, stationAt, stationRange, type Vec2 } from './track';
import { BARRIERS, BUILDINGS, MAP_D, MAP_W, ORIGIN_X, ORIGIN_Z, photoX, photoZ, SPECTATOR_FENCES, WALLS } from './track-data';

/** Side of the square tiles the forest is batched in, in metres. */
const TREE_TILE = 96;
const treeBatches: InstancedMesh[] = [];

export function buildWorld(groundCanvas: HTMLCanvasElement): void {
  const texture = new CanvasTexture(groundCanvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  texture.minFilter = LinearMipmapLinearFilter;
  // The ground follows the terrain, with a vertex every 2.5 m. Its asphalt gets fine stones on top of the paint.
  const groundMaterial = new MeshStandardMaterial({ map: texture, roughness: 0.95, metalness: 0 });
  addAsphaltDetail(groundMaterial);
  const ground = new Mesh(
    shapeToTerrain(new PlaneGeometry(MAP_W, MAP_D, Math.round(MAP_W / 2.5), Math.round(MAP_D / 2.5)), MAP_W / 2 - ORIGIN_X, MAP_D / 2 - ORIGIN_Z, () => 0),
    groundMaterial,
  );
  ground.position.set(MAP_W / 2 - ORIGIN_X, 0, MAP_D / 2 - ORIGIN_Z);
  ground.receiveShadow = true;
  scene.add(ground);

  // Plain forest floor beyond the map, carrying the edge heights on outwards. Its triangles are 20 m across, so
  // inside the map it drops well below the ground: otherwise it would cut through wherever the ground dips.
  const insideMap = (x: number, z: number) => x > -ORIGIN_X && x < MAP_W - ORIGIN_X && z > -ORIGIN_Z && z < MAP_D - ORIGIN_Z;
  const surround = new Mesh(
    shapeToTerrain(new PlaneGeometry(1600, 1600, 80, 80), MAP_W / 2 - ORIGIN_X, MAP_D / 2 - ORIGIN_Z, (x, z) => (insideMap(x, z) ? -4 : -0.12)),
    new MeshStandardMaterial({ color: 0x2e4026, roughness: 1 }),
  );
  surround.position.set(MAP_W / 2 - ORIGIN_X, 0, MAP_D / 2 - ORIGIN_Z);
  scene.add(surround);

  addHills();
  addKerbs();
  addBarriers();
  addBuildings();
  addTrees();
}

/** Lays a flat plane on the terrain, `lift` above it: `cx`, `cz` is where the plane's middle sits in the world. */
function shapeToTerrain(plane: PlaneGeometry, cx: number, cz: number, lift: (x: number, z: number) => number): PlaneGeometry {
  plane.rotateX(-Math.PI / 2);
  const pos = plane.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) + cx;
    const z = pos.getZ(i) + cz;
    pos.setY(i, heightAt(x, z) + lift(x, z));
  }
  plane.computeVertexNormals();
  return plane;
}

function addHills(): void {
  const rng = seededRandom(4);
  const positions: number[] = [];
  const colours: number[] = [];
  const segments = 120;
  const addRing = (radius: number, base: number, height: number, foot: Color, crest: Color, phase: number) => {
    let prev: [number, number, number] | null = null;
    for (let i = 0; i <= segments; i++) {
      const angle = (i / segments) * TAU;
      const y =
        base +
        height * (0.5 + 0.5 * Math.sin(angle * 3 + phase)) * (0.6 + 0.4 * rng()) +
        height * 0.25 * Math.sin(angle * 11 + phase * 2);
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;
      if (prev) {
        positions.push(prev[0], 0, prev[2], x, 0, z, x, y, z, prev[0], 0, prev[2], x, y, z, prev[0], prev[1], prev[2]);
        for (let v = 0; v < 6; v++) {
          const colour = v === 2 || v === 4 || v === 5 ? crest : foot;
          colours.push(colour.r, colour.g, colour.b);
        }
      }
      prev = [x, y, z];
    }
  };
  addRing(900, 260, 420, new Color(0x6f8597), new Color(0xa9bccb), 0.4);
  addRing(650, 140, 260, new Color(0x4f6656), new Color(0x7d9182), 2.1);

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new Float32BufferAttribute(colours, 3));
  const hills = new Mesh(geometry, new MeshBasicMaterial({ vertexColors: true, fog: false, side: DoubleSide }));
  hills.renderOrder = -1;
  scene.add(hills);
}

function addKerbs(): void {
  const positions: number[] = [];
  const colours: number[] = [];
  const red = new Color(0xc8312b);
  const white = new Color(0xeeede8);

  forEachKerb((_inner, _outer, stations, kerb) => {
    for (let i = 0; i < stations.length - 1; i++) {
      const colour = Math.floor(i / 2) % 2 ? white : red;
      const profile = (at: number) => {
        const station = stations[at];
        const inner = edgePoint(station, kerb.side, -0.35);
        const crown = edgePoint(station, kerb.side, 0.2);
        const outer = edgePoint(station, kerb.side, 0.85);
        return [
          [inner[0], heightAt(...inner) + 0.012, inner[1]],
          [crown[0], heightAt(...crown) + 0.075, crown[1]],
          [outer[0], heightAt(...outer) + 0.06, outer[1]],
        ];
      };
      const near = profile(i);
      const far = profile(i + 1);
      for (let strip = 0; strip < 2; strip++) {
        const a = near[strip];
        const b = near[strip + 1];
        const c = far[strip + 1];
        const d = far[strip];
        positions.push(...a, ...b, ...c, ...a, ...c, ...d);
        for (let v = 0; v < 6; v++) colours.push(colour.r, colour.g, colour.b);
      }
    }
  });

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new Float32BufferAttribute(colours, 3));
  geometry.computeVertexNormals();
  const material = new MeshStandardMaterial({
    vertexColors: true,
    roughness: 0.7,
    side: DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
  });
  const kerbs = new Mesh(geometry, material);
  kerbs.receiveShadow = true;
  scene.add(kerbs);
}

function addBarriers(): void {
  const railMaterial = new MeshStandardMaterial({ color: 0xb9c0c4, roughness: 0.35, metalness: 0.75, side: DoubleSide });
  const postMaterial = new MeshStandardMaterial({ color: 0x8e969b, roughness: 0.5, metalness: 0.6 });
  const tyreMaterial = new MeshStandardMaterial({ color: 0x18191b, roughness: 0.9 });
  const concreteMaterial = new MeshStandardMaterial({ vertexColors: true, roughness: 0.92, side: DoubleSide });
  const coverMaterial = new MeshStandardMaterial({ vertexColors: true, roughness: 0.6, side: DoubleSide });
  const posts: Vec2[] = [];
  const fencePosts: Vec2[] = [];
  const tyres: Vec2[] = [];

  /** A vertical strip along a line, `bottom` to `top` above the ground. With `stripes`, red and white every metre. */
  const addRibbon = (line: Vec2[], bottom: number, top: number, material: Material, stripes = false) => {
    const positions: number[] = [];
    const colours: number[] = [];
    let run = 0;
    for (let i = 0; i < line.length - 1; i++) {
      const [ax, az] = line[i];
      const [bx, bz] = line[i + 1];
      const ha = heightAt(ax, az);
      const hb = heightAt(bx, bz);
      positions.push(ax, ha + bottom, az, bx, hb + bottom, bz, bx, hb + top, bz, ax, ha + bottom, az, bx, hb + top, bz, ax, ha + top, az);
      run += Math.hypot(bx - ax, bz - az);
      const red = Math.floor(run) % 2 === 0;
      for (let v = 0; v < 6; v++) colours.push(red ? 0.62 : 0.86, red ? 0.07 : 0.85, red ? 0.06 : 0.82);
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    if (stripes) geometry.setAttribute('color', new Float32BufferAttribute(colours, 3));
    geometry.computeVertexNormals();
    const ribbon = new Mesh(geometry, material);
    ribbon.castShadow = true;
    ribbon.receiveShadow = true;
    scene.add(ribbon);
  };
  const addWall = (line: Vec2[], r: number, kind: HitKind) => {
    for (let i = 0; i < line.length - 1; i++) {
      colliders.segs.push({ ax: line[i][0], az: line[i][1], bx: line[i + 1][0], bz: line[i + 1][1], r, kind });
    }
  };
  /** Points every `spacing` metres along a line, between its corners as well as at them. */
  const spaced = (line: Vec2[], spacing: number, out: Vec2[]) => {
    let carry = 0;
    for (let i = 1; i < line.length; i++) {
      const [ax, az] = line[i - 1];
      const [bx, bz] = line[i];
      const length = Math.hypot(bx - ax, bz - az);
      let at = carry;
      for (; at < length; at += spacing) out.push([ax + ((bx - ax) * at) / length, az + ((bz - az) * at) / length]);
      carry = at - length;
    }
  };

  /** A line moved sideways by `d` metres, to its right for positive `d`. */
  const offsetLine = (line: Vec2[], d: number): Vec2[] =>
    line.map(([x, z], i) => {
      const [ax, az] = line[Math.max(0, i - 1)];
      const [bx, bz] = line[Math.min(line.length - 1, i + 1)];
      const length = Math.hypot(bx - ax, bz - az) || 1;
      return [x + ((bz - az) / length) * d, z - ((bx - ax) / length) * d];
    });
  /**
   * A concrete wall 0.9 m high between a front and a back line: sloped face, flat top, upright back, in blocks
   * of alternating shade every 2 m, like the mix of old and new blocks at the track.
   */
  const addConcrete = (front: Vec2[], back: Vec2[]) => {
    const positions: number[] = [];
    const colours: number[] = [];
    const at = (i: number, t: number, h: number) => {
      const x = front[i][0] + (back[i][0] - front[i][0]) * t;
      const z = front[i][1] + (back[i][1] - front[i][1]) * t;
      return [x, heightAt(x, z) + h, z];
    };
    // Cross-section: front foot, front top, back top, back foot.
    const profile: [number, number][] = [[0, 0], [0.3, 0.9], [0.7, 0.9], [1, 0]];
    let run = 0;
    for (let i = 0; i < front.length - 1; i++) {
      run += Math.hypot(front[i + 1][0] - front[i][0], front[i + 1][1] - front[i][1]);
      const shade = Math.floor(run / 2) % 2 ? 0.62 : 0.72;
      for (let k = 0; k < 3; k++) {
        const a = at(i, ...profile[k]);
        const b = at(i, ...profile[k + 1]);
        const c = at(i + 1, ...profile[k + 1]);
        const d = at(i + 1, ...profile[k]);
        positions.push(...a, ...d, ...c, ...a, ...c, ...b);
        for (let v = 0; v < 6; v++) colours.push(shade, shade * 0.99, shade * 0.95);
      }
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    geometry.setAttribute('color', new Float32BufferAttribute(colours, 3));
    geometry.computeVertexNormals();
    const wall = new Mesh(geometry, concreteMaterial);
    wall.castShadow = wall.receiveShadow = true;
    scene.add(wall);
  };

  for (const barrier of BARRIERS) {
    const stations = stationRange(stationAt(barrier.from), stationAt(barrier.to)).filter((_, i) => i % 2 === 0);
    const line = stations.map((station) => edgePoint(station, barrier.side, barrier.off));
    if (barrier.kind === 'rail') {
      addRibbon(line, 0.42, 0.74, railMaterial);
      spaced(line, 2, posts);
      addWall(line, 0.18, 'rail');
    } else if (barrier.kind === 'concrete') {
      addConcrete(line, stations.map((station) => edgePoint(station, barrier.side, barrier.off + 0.6)));
      addWall(stations.map((station) => edgePoint(station, barrier.side, barrier.off + 0.3)), 0.32, 'concrete');
    } else {
      spaced(line, 0.62, tyres);
      // Belting strapped across the face of the stack, as on the real walls.
      addRibbon(stations.map((station) => edgePoint(station, barrier.side, barrier.off - 0.42)), 0.04, 0.66, coverMaterial, true);
      addWall(line, 0.42, 'tyres');
    }
  }

  for (const wall of WALLS) {
    const line = wall.points.map(([x, y]): Vec2 => [photoX(x), photoZ(y)]);
    if (wall.kind === 'tyres') {
      spaced(line, 0.62, tyres);
      // Belted on both faces: there's track either side.
      addRibbon(offsetLine(line, 0.42), 0.04, 0.66, coverMaterial, true);
      addRibbon(offsetLine(line, -0.42), 0.04, 0.66, coverMaterial, true);
      addWall(line, 0.42, 'tyres');
    } else {
      addConcrete(offsetLine(line, -0.3), offsetLine(line, 0.3));
      addWall(line, 0.32, 'concrete');
    }
  }

  // Spectator fences up the bank behind the guardrail: posts and wire mesh, nothing to hit.
  const fenceMesh = new MeshStandardMaterial({ color: 0x9aa0a4, transparent: true, opacity: 0.32, side: DoubleSide, depthWrite: false });
  for (const [from, to] of SPECTATOR_FENCES) {
    const line = stationRange(stationAt(from), stationAt(to))
      .filter((_, i) => i % 4 === 0)
      .map((station) => edgePoint(station, -1, 4.5));
    addRibbon(line, 0.05, 1.8, fenceMesh);
    spaced(line, 2.5, fencePosts);
  }

  if (posts.length) {
    const mesh = new InstancedMesh(new BoxGeometry(0.1, 0.8, 0.1).translate(0, 0.4, 0), postMaterial, posts.length);
    const dummy = new Object3D();
    posts.forEach(([x, z], i) => {
      dummy.position.set(x, heightAt(x, z), z);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    mesh.castShadow = true;
    scene.add(mesh);
  }

  if (fencePosts.length) {
    const mesh = new InstancedMesh(new BoxGeometry(0.05, 1.85, 0.05).translate(0, 0.92, 0), postMaterial, fencePosts.length);
    const dummy = new Object3D();
    fencePosts.forEach(([x, z], i) => {
      dummy.position.set(x, heightAt(x, z), z);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
    });
    scene.add(mesh);
  }

  if (tyres.length) {
    const mesh = new InstancedMesh(
      new TorusGeometry(0.3, 0.11, 6, 12).rotateX(Math.PI / 2),
      tyreMaterial,
      tyres.length * 3,
    );
    const dummy = new Object3D();
    let instance = 0;
    tyres.forEach(([x, z]) => {
      for (let level = 0; level < 3; level++) {
        dummy.position.set(x, heightAt(x, z) + 0.11 + level * 0.22, z);
        dummy.updateMatrix();
        mesh.setMatrixAt(instance++, dummy.matrix);
      }
    });
    mesh.castShadow = true;
    scene.add(mesh);
  }
}

function addBuildings(): void {
  for (const [x, y, width, depth, rotation, height, wallColour, roofColour] of BUILDINGS) {
    const group = new Group();
    const walls = new Mesh(new BoxGeometry(width, height, depth), new MeshStandardMaterial({ color: wallColour, roughness: 0.85 }));
    walls.position.y = height / 2;
    const roof = new Mesh(
      new BoxGeometry(width + 0.3, 0.18, depth + 0.3),
      new MeshStandardMaterial({ color: roofColour, roughness: 0.6, metalness: 0.2 }),
    );
    roof.position.y = height + 0.09;
    walls.castShadow = roof.castShadow = true;
    walls.receiveShadow = true;
    group.add(walls, roof);
    const angle = (rotation * Math.PI) / 180;
    // Set on the lowest corner, so a building on a slope doesn't float.
    const corners = [-1, 1].flatMap((sx) => [-1, 1].map((sz) => heightAt(photoX(x) + (sx * width) / 2, photoZ(y) + (sz * depth) / 2)));
    group.position.set(photoX(x), Math.min(...corners), photoZ(y));
    group.rotation.y = angle;
    scene.add(group);
    colliders.boxes.push({
      x: photoX(x),
      z: photoZ(y),
      c: Math.cos(angle),
      s: Math.sin(angle),
      hx: width / 2,
      hz: depth / 2,
    });
  }
}

/** Colours a merged tree: the first `trunkVertices` as `trunk`, the rest white so the instance colour shows. */
function colourTree(tree: BufferGeometry, trunkVertices: number, trunk: readonly number[]): void {
  const colours = new Float32Array(tree.getAttribute('position').count * 3);
  for (let v = 0; v < colours.length / 3; v++) colours.set(v < trunkVertices ? trunk : [1, 1, 1], v * 3);
  tree.setAttribute('color', new BufferAttribute(colours, 3));
}

function addTrees(): void {
  const rng = seededRandom(7);
  const spots: [x: number, z: number, seed: number][] = [];
  const spacing = 3;
  for (let gridZ = -ORIGIN_Z - 60; gridZ < MAP_D - ORIGIN_Z + 60; gridZ += spacing) {
    for (let gridX = -ORIGIN_X - 60; gridX < MAP_W - ORIGIN_X + 60; gridX += spacing) {
      const x = gridX + (rng() - 0.5) * spacing * 0.9;
      const z = gridZ + (rng() - 0.5) * spacing * 0.9;
      if (x > -ORIGIN_X && x < MAP_W - ORIGIN_X && z > -ORIGIN_Z && z < MAP_D - ORIGIN_Z) {
        const [red, , blue] = groundAt(x, z);
        if (
          red < 0.62 ||
          blue > 0.25 ||
          isRoadside(x, z) ||
          BUILDINGS.some(([bx, by, width, depth]) => Math.hypot(x - photoX(bx), z - photoZ(by)) < Math.max(width, depth) / 2 + 3) ||
          rng() > 0.78
        ) {
          continue;
        }
      } else if (rng() > 0.5) {
        continue;
      }
      spots.push([x, z, rng()]);
    }
  }

  const prepare = (geometry: BufferGeometry) => {
    const flat = geometry.index ? geometry.toNonIndexed() : geometry;
    flat.deleteAttribute('uv');
    return flat;
  };

  const pine = mergeGeometries([
    prepare(new CylinderGeometry(0.12, 0.18, 2.2, 5).translate(0, 1.1, 0)),
    prepare(new ConeGeometry(1.9, 4.2, 7).translate(0, 3.4, 0)),
    prepare(new ConeGeometry(1.45, 3.4, 7).translate(0, 5.6, 0)),
    prepare(new ConeGeometry(0.95, 2.8, 7).translate(0, 7.6, 0)),
  ]);
  colourTree(pine, prepare(new CylinderGeometry(0.12, 0.18, 2.2, 5)).getAttribute('position').count, [0.33, 0.25, 0.19]);

  const birch = mergeGeometries([
    prepare(new CylinderGeometry(0.1, 0.14, 3, 5).translate(0, 1.5, 0)),
    prepare(new IcosahedronGeometry(2.2, 0).scale(1, 1.25, 1).translate(0, 4.6, 0)),
  ]);
  colourTree(birch, prepare(new CylinderGeometry(0.1, 0.14, 3, 5)).getAttribute('position').count, [0.85, 0.84, 0.8]);

  const material = new MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true });
  // One batch per tile and species, so the renderer can skip tiles behind the camera or past the fog.
  const tiles = new Map<string, typeof spots>();
  for (const spot of spots) {
    const key = `${Math.floor(spot[0] / TREE_TILE)},${Math.floor(spot[1] / TREE_TILE)}`;
    if (!tiles.has(key)) tiles.set(key, []);
    tiles.get(key)!.push(spot);
  }
  const plant = (
    geometry: BufferGeometry,
    trees: typeof spots,
    palette: readonly number[],
    minScale: number,
    maxScale: number,
  ) => {
    if (!trees.length) return;
    const mesh = new InstancedMesh(geometry, material, trees.length);
    const dummy = new Object3D();
    const colour = new Color();
    trees.forEach(([x, z, seed], i) => {
      const scale = lerp(minScale, maxScale, (seed * 9.7) % 1);
      dummy.position.set(x, heightAt(x, z) - 0.1, z);
      dummy.rotation.y = seed * 40;
      dummy.scale.set(scale, scale * lerp(0.9, 1.25, (seed * 3.3) % 1), scale);
      dummy.updateMatrix();
      mesh.setMatrixAt(i, dummy.matrix);
      colour.set(palette[((seed * 17) % palette.length) | 0]);
      mesh.setColorAt(i, colour);
    });
    mesh.computeBoundingSphere();
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    scene.add(mesh);
    treeBatches.push(mesh);
  };
  for (const trees of tiles.values()) {
    plant(pine, trees.filter((spot) => spot[2] < 0.72), [0x2f4a2c, 0x29422a, 0x365233, 0x24402b], 0.9, 1.6);
    plant(birch, trees.filter((spot) => spot[2] >= 0.72), [0x5f8a3c, 0x6c9442, 0x52783a], 0.8, 1.25);
  }
}

/** Hides tree tiles that lie wholly past the fog, where they'd be drawn the colour of the sky anyway. */
export function cullScenery(x: number, z: number): void {
  const far = (scene.fog as Fog).far;
  for (const mesh of treeBatches) {
    const sphere = mesh.boundingSphere!;
    mesh.visible = Math.hypot(sphere.center.x - x, sphere.center.z - z) - sphere.radius < far;
  }
}
