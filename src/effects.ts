import {
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  Mesh,
  Points,
  ShaderMaterial,
} from 'three';
import { updateAudio } from './audio';
import { clamp, rand } from './math';
import { WHEEL_POSITIONS } from './physics';
import { renderer, scene } from './stage';
import { car, controls } from './state';
import { heightAt } from './terrain';

const MAX_SKID_QUADS = 5e3;
const MAX_PUFFS = 420;

const dynamicAttribute = (array: Float32Array, itemSize: number) =>
  new BufferAttribute(array, itemSize).setUsage(DynamicDrawUsage);

/** Ring buffer of dark quads on the road, one strip per wheel. */
export const skids = (() => {
  const positions = new Float32Array(MAX_SKID_QUADS * 4 * 3);
  const alphas = new Float32Array(MAX_SKID_QUADS * 4);
  const indices = new Uint32Array(MAX_SKID_QUADS * 6);
  for (let i = 0; i < MAX_SKID_QUADS; i++) {
    indices.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', dynamicAttribute(positions, 3));
  geometry.setAttribute('aAlpha', dynamicAttribute(alphas, 1));
  geometry.setIndex(new BufferAttribute(indices, 1));
  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -4,
    polygonOffsetUnits: -4,
    vertexShader:
      'attribute float aAlpha; varying float vA; void main(){ vA = aAlpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: 'varying float vA; void main(){ gl_FragColor = vec4(0.07,0.07,0.08, vA); }',
  });
  const mesh = new Mesh(geometry, material);
  mesh.frustumCulled = false;
  scene.add(mesh);

  const markDirty = () => {
    geometry.attributes.position.needsUpdate = true;
    geometry.attributes.aAlpha.needsUpdate = true;
  };

  let head = 0;
  const lastMark: ({ x: number; z: number; L: number[]; R: number[]; a: number } | null)[] = [null, null, null, null];

  return {
    add(wheel: number, x: number, z: number, dirX: number, dirZ: number, alpha: number): void {
      const halfX = -dirZ * 0.11;
      const halfZ = dirX * 0.11;
      const left = [x + halfX, z + halfZ];
      const right = [x - halfX, z - halfZ];
      const last = lastMark[wheel];
      if (last && Math.hypot(x - last.x, z - last.z) < 0.22) return;
      if (last && Math.hypot(x - last.x, z - last.z) < 1.5) {
        const quad = head;
        head = (head + 1) % MAX_SKID_QUADS;
        const lift = (p: number[]) => heightAt(p[0], p[1]) + 0.02;
        positions.set(
          [last.L[0], lift(last.L), last.L[1], left[0], lift(left), left[1], right[0], lift(right), right[1], last.R[0], lift(last.R), last.R[1]],
          quad * 12,
        );
        alphas.set([last.a, alpha, alpha, last.a], quad * 4);
        markDirty();
      }
      lastMark[wheel] = { x, z, L: left, R: right, a: alpha };
    },
    /** Ends the strip, so the next mark starts a new one. */
    lift(wheel: number): void {
      lastMark[wheel] = null;
    },
    clear(): void {
      positions.fill(0);
      alphas.fill(0);
      head = 0;
      lastMark.fill(null);
      markDirty();
    },
  };
})();

/** Ring buffer of soft points for tyre smoke and thrown dust. */
const smoke = (() => {
  const positions = new Float32Array(MAX_PUFFS * 3);
  const sizes = new Float32Array(MAX_PUFFS);
  const alphas = new Float32Array(MAX_PUFFS);
  const velocities = new Float32Array(MAX_PUFFS * 3);
  const ages = new Float32Array(MAX_PUFFS).fill(99);
  const lifetimes = new Float32Array(MAX_PUFFS).fill(1);
  const tints = new Float32Array(MAX_PUFFS);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', dynamicAttribute(positions, 3));
  geometry.setAttribute('aSize', dynamicAttribute(sizes, 1));
  geometry.setAttribute('aAlpha', dynamicAttribute(alphas, 1));
  geometry.setAttribute('aTint', dynamicAttribute(tints, 1));
  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { uScale: { value: 1 } },
    vertexShader: `attribute float aSize; attribute float aAlpha; attribute float aTint; uniform float uScale; varying float vA; varying float vT;
      void main(){ vA = aAlpha; vT = aTint; vec4 mv = modelViewMatrix * vec4(position,1.0); gl_PointSize = aSize * uScale / max(0.5, -mv.z); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `varying float vA; varying float vT; void main(){ vec2 p = gl_PointCoord - 0.5; float r = dot(p,p)*4.0; if (r > 1.0) discard;
      float a = vA * (1.0 - r) * (1.0 - r); vec3 c = mix(vec3(0.86,0.86,0.84), vec3(0.62,0.55,0.44), vT); gl_FragColor = vec4(c, a); }`,
  });
  const points = new Points(geometry, material);
  points.frustumCulled = false;
  scene.add(points);

  let head = 0;
  return {
    mat: material,
    emit(x: number, z: number, vx: number, vz: number, strength: number, dirt: boolean): void {
      const i = head;
      head = (head + 1) % MAX_PUFFS;
      positions.set([x + rand(-0.2, 0.2), heightAt(x, z) + 0.25, z + rand(-0.2, 0.2)], i * 3);
      velocities.set([vx * 0.25 + rand(-0.6, 0.6), rand(0.5, 1.3), vz * 0.25 + rand(-0.6, 0.6)], i * 3);
      ages[i] = 0;
      lifetimes[i] = rand(1.4, 2.6) * (0.6 + strength * 0.5);
      tints[i] = dirt ? 1 : 0;
      sizes[i] = 0;
    },
    update(dt: number): void {
      for (let i = 0; i < MAX_PUFFS; i++) {
        if (ages[i] > lifetimes[i]) {
          alphas[i] = 0;
          continue;
        }
        ages[i] += dt;
        const life = ages[i] / lifetimes[i];
        velocities[i * 3] *= 1 - dt * 1.2;
        velocities[i * 3 + 2] *= 1 - dt * 1.2;
        velocities[i * 3 + 1] *= 1 - dt * 0.6;
        positions[i * 3] += velocities[i * 3] * dt;
        positions[i * 3 + 1] += velocities[i * 3 + 1] * dt;
        positions[i * 3 + 2] += velocities[i * 3 + 2] * dt;
        sizes[i] = 1.2 + life * 6.5;
        alphas[i] = (life < 0.1 ? life / 0.1 : 1 - life) * 0.42;
      }
      geometry.attributes.position.needsUpdate = true;
      geometry.attributes.aSize.needsUpdate = true;
      geometry.attributes.aAlpha.needsUpdate = true;
      geometry.attributes.aTint.needsUpdate = true;
    },
    clear(): void {
      ages.fill(99);
      alphas.fill(0);
    },
  };
})();

export const updateSmoke = (dt: number): void => smoke.update(dt);

/** Skid marks and smoke, driven by how hard each wheel is sliding; then the sound. */
export function updateEffects(dt: number): void {
  const sinH = Math.sin(car.th);
  const cosH = Math.cos(car.th);
  const rightX = cosH;
  const rightZ = -sinH;
  const speed = Math.hypot(car.vx, car.vz);
  const vForward = car.vx * sinH + car.vz * cosH;
  const rearSlip = clamp((car.slipR - 0.12) * 2.2, 0, 1) * clamp(speed / 6, 0, 1);
  const frontSlip = clamp((car.slipF - 0.2) * 2, 0, 1) * clamp(speed / 6, 0, 1);
  const spin = clamp(car.spin, 0, 1) * (Math.abs(vForward) > 0.5 || controls.gas > 0.5 ? 1 : 0);
  const locked = controls.hand && Math.abs(vForward) > 1 ? 0.8 : 0;
  const rearSlide = Math.max(rearSlip, spin, locked);
  const dirX = speed > 0.5 ? car.vx / speed : sinH;
  const dirZ = speed > 0.5 ? car.vz / speed : cosH;

  for (let w = 0; w < 4; w++) {
    const slide = w < 2 ? frontSlip * 0.7 : rearSlide;
    const [right, forward] = WHEEL_POSITIONS[w];
    const x = car.x + rightX * right + sinH * forward;
    const z = car.z + rightZ * right + cosH * forward;
    const surface = car.surf[w];
    const paved = surface === 'tarmac' || surface === 'kerb';
    if (slide > 0.25 && paved) skids.add(w, x, z, dirX, dirZ, clamp(0.25 + slide * 0.5, 0, 0.75));
    else skids.lift(w);

    if (w >= 2) {
      const dirt = !paved;
      const strength = dirt ? clamp(speed / 12, 0, 1) * 0.8 : slide;
      const rate = (dirt ? strength * 30 : Math.max(0, slide - 0.3) * 70) * dt;
      let puffs = Math.floor(rate + Math.random() * (rate % 1 || rate));
      while (puffs-- > 0) smoke.emit(x, z, car.vx, car.vz, strength, dirt);
    }
  }

  smoke.update(dt);
  smoke.mat.uniforms.uScale.value = innerHeight * renderer.getPixelRatio() * 0.55;

  updateAudio(dt);
}
