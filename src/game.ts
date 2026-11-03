import { applySoundOption, playImpact, prepareEngine, startAudio, suspendAudio } from './audio';
import { shakeCamera, snapCamera } from './camera';
import { byId } from './dom';
import { skids } from './effects';
import { flashChainLost, formatTime, showToast } from './hud';
import { viewCanvas } from './stage';
import { app, car, game, options, recordKey, store } from './state';
import { lapHeading, nearestOnTrack, track } from './track';
import { LAP_DIRECTION } from './track-data';

/** Puts the car on the centreline: at the nearest point, or on the grid before the start line. */
export function respawn(toGrid = false): void {
  const n = track.N;
  const i = toGrid ? (game.startIdx - 30 * LAP_DIRECTION + n) % n : nearestOnTrack(car.x, car.z).i;
  car.x = track.X[i];
  car.z = track.Z[i];
  car.th = lapHeading(i);
  car.vx = car.vz = car.r = car.delta = 0;
  car.gear = 1;
  car.spin = 0;
  car.boost = 0;
  car.omega.fill(0);
  car.axb = 0;
  car.ayb = 0;
  game.idx = i;
  if (game.chain) dropChain('Chain lost');
  if (!toGrid) {
    game.lapValid = false;
    showToast('Back on track', true);
  }
  for (let w = 0; w < 4; w++) skids.lift(w);
  snapCamera();
}

/** Tracks progress round the lap. A lap only counts if both sectors were passed on the way. */
export function updateLap(): void {
  const n = track.N;
  const prevIdx = game.idx;
  const nearest = nearestOnTrack(car.x, car.z, prevIdx, 70);
  game.idx = nearest.i;
  game.lat = nearest.lat;

  // Stations past the start line, counted the way the lap runs.
  const fromStart = (i: number) => ((i - game.startIdx) * LAP_DIRECTION + n) % n;
  const before = fromStart(prevIdx);
  const after = fromStart(nearest.i);
  if (after > n * 0.3 && after < n * 0.45) game.sec[0] = true;
  if (after > n * 0.62 && after < n * 0.8 && game.sec[0]) game.sec[1] = true;

  if (before > n * 0.9 && after < n * 0.1) {
    if (game.lapStart === null) {
      game.lapStart = game.now;
      game.sec = [false, false];
      game.lapScore = 0;
      game.lapValid = true;
      showToast('Timing started');
    } else if (game.sec[0] && game.sec[1]) {
      if (game.chain) bankChain();
      const time = game.now - game.lapStart;
      game.last = time;
      const valid = game.lapValid;
      if (valid && (game.best === null || time < game.best)) {
        game.best = time;
        store.set(recordKey('lap', options.car), time);
      }
      if (game.bestScore === null || game.lapScore > game.bestScore) {
        game.bestScore = Math.round(game.lapScore);
        store.set(recordKey('score', options.car), game.bestScore);
      }
      showToast(`Lap ${game.lap}  ${formatTime(time)}  ·  ${Math.round(game.lapScore)} pts${valid ? '' : '  (reset used)'}`);
      game.lap++;
      game.lapStart = game.now;
      game.sec = [false, false];
      game.lapScore = 0;
      game.lapValid = true;
    }
  }
}

/** Runs the drift chain: points grow with angle and speed, and the multiplier with time held. */
export function updateScoring(dt: number): void {
  const sinH = Math.sin(car.th);
  const cosH = Math.cos(car.th);
  const vForward = car.vx * sinH + car.vz * cosH;
  const vRight = car.vx * cosH - car.vz * sinH;
  const speed = Math.hypot(car.vx, car.vz);
  const angle = speed > 2 ? (Math.abs(Math.atan2(vRight, vForward)) * 180) / Math.PI : 0;
  game.angle = angle;

  const pavedWheels = car.surf.filter((surface) => surface === 'tarmac' || surface === 'kerb').length;
  const drifting = speed > 7 && angle > 9 && angle < 115 && vForward > 0 && pavedWheels >= 2;

  if (car.impact > 3.2) {
    if (game.chain) dropChain('Wall. Chain lost');
    shakeCamera(Math.min(1, car.impact / 10));
    playImpact(car.impact, car.hitKind);
  }
  car.impact = 0;

  game.offT = pavedWheels === 0 ? game.offT + dt : 0;
  if (game.chain && game.offT > 0.45) dropChain('Off the asphalt. Chain lost');

  if (drifting) {
    game.chain ??= { pts: 0, t: 0, idle: 0, mult: 1 };
    const chain = game.chain;
    chain.t += dt;
    chain.idle = 0;
    chain.mult = Math.min(5, 1 + Math.floor(chain.t / 1.6));
    chain.pts += (angle - 6) * speed * dt * 0.9 * chain.mult;
  } else if (game.chain) {
    game.chain.idle += dt;
    if (game.chain.idle > 0.85) bankChain();
  }
}

function bankChain(): void {
  const points = Math.round(game.chain!.pts);
  game.chain = null;
  if (points > 0) {
    game.lapScore += points;
    showToast(`+${points}`);
  }
}

function dropChain(message: string): void {
  game.chain = null;
  flashChainLost();
  showToast(message, true);
}

/** A new car starts a new session: back to the grid, timing cleared, and that car's own records. */
export function resetSession(): void {
  game.lap = 1;
  game.lapStart = null;
  game.last = null;
  game.lapScore = 0;
  game.chain = null;
  game.lapValid = true;
  game.sec = [false, false];
  game.best = store.get<number | null>(recordKey('lap', options.car), null);
  game.bestScore = store.get<number | null>(recordKey('score', options.car), null);
  app.started = false;
  prepareEngine(options.car);
  respawn(true);
}

export function startOrResume(): void {
  startAudio();
  applySoundOption();
  if (app.mode === 'menu' && !app.started) {
    respawn(true);
    app.started = true;
  }
  app.mode = 'play';
  document.body.classList.add('playing');
  byId('menu').hidden = true;
  byId('hud').hidden = false;
  byId('btnStart').textContent = 'Resume';
  viewCanvas.focus();
}

export function togglePause(): void {
  if (app.mode === 'play') {
    app.mode = 'menu';
    document.body.classList.remove('playing');
    byId('menu').hidden = false;
    byId('hud').hidden = true;
    suspendAudio();
  } else if (app.started) {
    startOrResume();
  }
}
