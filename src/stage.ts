import {
  ACESFilmicToneMapping,
  Color,
  DirectionalLight,
  Fog,
  HemisphereLight,
  type Mesh,
  PCFShadowMap,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import { byId } from './dom';
import { options } from './state';

export const viewCanvas = byId<HTMLCanvasElement>('view');
export const isTouchDevice = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;

function createRenderer(): WebGLRenderer {
  try {
    return new WebGLRenderer({ canvas: viewCanvas, antialias: true, powerPreference: 'high-performance' });
  } catch (err) {
    byId('loadMsg').textContent = 'This browser could not start WebGL, which the game needs.';
    throw err;
  }
}

export const renderer = createRenderer();
/** The sharpest the game renders; `adaptResolution` comes down from here when frames run slow. */
const maxPixelRatio = Math.min(devicePixelRatio || 1, isTouchDevice ? 1.5 : 1.75);
renderer.setPixelRatio(maxPixelRatio);
renderer.outputColorSpace = SRGBColorSpace;
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = 1;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = PCFShadowMap;

export const scene = new Scene();
const sky = new Color(0xbfd3e2);
scene.background = sky;
scene.fog = new Fog(sky, 70, 330);

export const camera = new PerspectiveCamera(62, 1, 0.1, 1500);

scene.add(new HemisphereLight(0xdbe8f4, 0x4b5a3c, 1.25));

const sun = new DirectionalLight(0xfff3e0, 2.3);
sun.castShadow = true;
sun.shadow.mapSize.set(isTouchDevice ? 1024 : 2048, isTouchDevice ? 1024 : 2048);
const shadowCamera = sun.shadow.camera;
shadowCamera.left = -28;
shadowCamera.right = 28;
shadowCamera.top = 28;
shadowCamera.bottom = -28;
shadowCamera.near = 1;
shadowCamera.far = 140;
sun.shadow.bias = -4e-4;
sun.shadow.normalBias = 0.03;
scene.add(sun, sun.target);

const sunDirection = new Vector3(-0.45, 0.78, 0.42).normalize();

/** Keeps the shadow frustum centred on a world position. */
export function followSun(x: number, z: number): void {
  sun.position.set(x + sunDirection.x * 60, sunDirection.y * 60, z + sunDirection.z * 60);
  sun.target.position.set(x, 0, z);
}

export function applyShadows(): void {
  renderer.shadowMap.enabled = options.shadows;
  sun.castShadow = options.shadows;
  scene.traverse((object) => {
    const { material } = object as Mesh;
    if (!material) return;
    (Array.isArray(material) ? material : [material]).forEach((m) => (m.needsUpdate = true));
  });
}

const quality = { frames: 0, time: 0, wait: 0 };

/**
 * Keeps phones and slower laptops smooth: once a second, renders at a lower resolution if frames took over
 * 20 ms on average, and steps back up when they're comfortably fast. It never goes below half the screen's
 * pixels; if frames are still slow there, shadows go off too. `elapsed` is real time since the last frame.
 */
export function adaptResolution(elapsed: number): void {
  if (elapsed <= 0 || elapsed > 1) return;
  quality.frames++;
  quality.time += elapsed;
  if (quality.time < 1) return;
  const average = quality.time / quality.frames;
  quality.frames = quality.time = 0;
  if (quality.wait > 0) {
    quality.wait--;
    return;
  }
  const ratio = renderer.getPixelRatio();
  let next = ratio;
  if (average > 0.04) next = Math.max(0.5, ratio * 0.7);
  else if (average > 0.02) next = Math.max(0.5, ratio * 0.85);
  else if (average < 0.0175) next = Math.min(maxPixelRatio, ratio * 1.1);
  if (Math.abs(next - ratio) > 0.01) {
    renderer.setPixelRatio(next);
    // Give the new size a moment before judging it.
    quality.wait = 1;
  } else if (average > 0.033 && options.shadows) {
    options.shadows = false;
    byId<HTMLInputElement>('optShadows').checked = false;
    applyShadows();
    quality.wait = 1;
  }
}

function resize(): void {
  const width = innerWidth;
  const height = innerHeight;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();
