import groundMapUrl from './assets/ground-map.png';
import { updateAudio } from './audio';
import { updateCamera } from './camera';
import { syncCar } from './car-model';
import { byId } from './dom';
import { updateEffects, updateSmoke } from './effects';
import { respawn, togglePause, updateLap, updateScoring } from './game';
import { buildMask, paintGround, solidAt, surfaceAt } from './ground';
import { buildMinimap, updateHud } from './hud';
import { bindKeyboard, bindTouch, readControls } from './input';
import { initMenu, selectCar } from './menu';
import { physicsStep } from './physics';
import { adaptResolution, applyShadows, camera, followSun, renderer, scene } from './stage';
import { app, car, controls, game, options } from './state';
import { track } from './track';
import { heightAt } from './terrain';
import { START_LINE_CP } from './track-data';
import { buildWorld, cullScenery } from './world';

declare global {
  interface Window {
    /** Debug handle, for poking at a running game from the console. */
    __drift: {
      st: typeof car;
      game: typeof game;
      TRK: typeof track;
      input: typeof controls;
      physicsStep: typeof physicsStep;
      respawn: typeof respawn;
      surfaceAt: typeof surfaceAt;
      solidAt: typeof solidAt;
      view: { renderer: typeof renderer; scene: typeof scene; camera: typeof camera };
    };
  }
}

const PHYSICS_STEP = 1 / 240;
const MAX_STEPS_PER_FRAME = 14;

const loadMsg = byId('loadMsg');
let lastFrame = performance.now();
let accumulator = 0;

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('ground-map.png did not load'));
    image.src = url;
  });
}

function frame(now: number): void {
  const elapsed = (now - lastFrame) / 1e3;
  const dt = Math.min(0.05, elapsed);
  lastFrame = now;

  if (app.mode === 'play') {
    readControls(dt);
    accumulator += dt;
    let steps = 0;
    while (accumulator >= PHYSICS_STEP && steps < MAX_STEPS_PER_FRAME) {
      physicsStep(PHYSICS_STEP, controls);
      accumulator -= PHYSICS_STEP;
      steps++;
    }
    if (steps === MAX_STEPS_PER_FRAME) accumulator = 0;
    game.now += dt;
    updateLap();
    updateScoring(dt);
    syncCar(dt);
    updateEffects(dt);
    updateCamera(dt);
    updateHud(dt);
  } else {
    // Slow orbit behind the menu.
    const orbit = now * 12e-5;
    syncCar(dt);
    updateSmoke(dt);
    const ground = heightAt(car.x, car.z);
    camera.position.set(car.x + Math.cos(orbit) * 9, ground + 3.2, car.z + Math.sin(orbit) * 9);
    camera.lookAt(car.x, ground + 0.8, car.z);
    followSun(car.x, car.z);
    updateAudio(dt);
  }

  cullScenery(camera.position.x, camera.position.z);
  renderer.render(scene, camera);
  adaptResolution(elapsed);
  requestAnimationFrame(frame);
}

async function boot(): Promise<void> {
  initMenu();
  bindTouch();
  loadMsg.textContent = 'Painting the track…';

  const groundMap = await loadImage(groundMapUrl);
  buildMask(groundMap);
  game.startIdx = track.idxOfCP(START_LINE_CP);
  buildWorld(paintGround(groundMap));
  buildMinimap();

  loadMsg.textContent = 'Loading the car…';
  // If the saved car won't load, the built-in one always will.
  if (!(await selectCar(options.car))) await selectCar('retro');
  applyShadows();
  loadMsg.textContent = `Lap ${Math.round(track.length)} m.`;

  window.__drift = {
    st: car,
    game,
    TRK: track,
    input: controls,
    physicsStep,
    respawn,
    surfaceAt,
    solidAt,
    view: { renderer, scene, camera },
  };
  requestAnimationFrame(frame);
}

bindKeyboard();

document.addEventListener('visibilitychange', () => {
  if (document.hidden && app.mode === 'play') togglePause();
});

boot().catch((err: Error) => {
  console.error(err);
  loadMsg.textContent = 'Loading failed: ' + err.message;
});
