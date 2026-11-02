import { byId } from './dom';
import { clamp } from './math';
import { CAR } from './physics';
import { car, game } from './state';
import { edgePoint, track } from './track';

const hud = {
  lapNo: byId('lapNo'),
  lapTime: byId('lapTime'),
  best: byId('bestLap'),
  last: byId('lastLap'),
  lapScore: byId('lapScore'),
  bestScore: byId('bestScore'),
  pts: byId('driftPts'),
  mult: byId('driftMult'),
  box: byId('driftBox'),
  angle: byId('angleFill'),
  angleTxt: byId('angleTxt'),
  speed: byId('speed'),
  gear: byId('gear'),
  rpm: byId('rpmFill'),
  rpmBox: document.querySelector('.rpm') as HTMLElement,
};

let sinceRefresh = 0;
let toastTimer: ReturnType<typeof setTimeout> | undefined;

const minimap = {
  cv: byId<HTMLCanvasElement>('minimap'),
  bg: null as HTMLCanvasElement | null,
  scale: 1,
  ox: 0,
  oz: 0,
};

export function showToast(text: string, bad = false): void {
  const toast = byId('toast');
  toast.textContent = text;
  toast.classList.toggle('bad', bad);
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 1800);
}

export function flashChainLost(): void {
  const box = byId('driftBox');
  box.classList.add('lost');
  setTimeout(() => box.classList.remove('lost'), 700);
}

export function formatTime(seconds: number | null): string {
  if (seconds == null) return '–';
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return `${minutes}:${rest.toFixed(3).padStart(6, '0')}`;
}

/** Draws the track once into an offscreen canvas; the car is drawn over it each refresh. */
export function buildMinimap(): void {
  const { width, height } = minimap.cv;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < track.N; i++) {
    minX = Math.min(minX, track.X[i]);
    maxX = Math.max(maxX, track.X[i]);
    minZ = Math.min(minZ, track.Z[i]);
    maxZ = Math.max(maxZ, track.Z[i]);
  }
  const pad = 8;
  minimap.scale = Math.min((width - pad * 2) / (maxX - minX), (height - pad * 2) / (maxZ - minZ));
  minimap.ox = pad + (width - pad * 2 - (maxX - minX) * minimap.scale) / 2 - minX * minimap.scale;
  minimap.oz = pad + (height - pad * 2 - (maxZ - minZ) * minimap.scale) / 2 - minZ * minimap.scale;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const tracePath = () => {
    ctx.beginPath();
    for (let i = 0; i <= track.N; i += 2) {
      const station = i % track.N;
      const x = track.X[station] * minimap.scale + minimap.ox;
      const y = track.Z[station] * minimap.scale + minimap.oz;
      if (i) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
    }
    ctx.closePath();
  };
  ctx.strokeStyle = 'rgba(242,240,234,0.25)';
  ctx.lineWidth = 6;
  tracePath();
  ctx.stroke();
  ctx.strokeStyle = 'rgba(242,240,234,0.85)';
  ctx.lineWidth = 2;
  tracePath();
  ctx.stroke();

  const [ax, az] = edgePoint(game.startIdx, 1, 2);
  const [bx, bz] = edgePoint(game.startIdx, -1, 2);
  ctx.strokeStyle = '#d23a2f';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(ax * minimap.scale + minimap.ox, az * minimap.scale + minimap.oz);
  ctx.lineTo(bx * minimap.scale + minimap.ox, bz * minimap.scale + minimap.oz);
  ctx.stroke();
  minimap.bg = canvas;
}

function drawMinimap(): void {
  const ctx = minimap.cv.getContext('2d')!;
  ctx.clearRect(0, 0, minimap.cv.width, minimap.cv.height);
  if (minimap.bg) ctx.drawImage(minimap.bg, 0, 0);
  ctx.save();
  ctx.translate(car.x * minimap.scale + minimap.ox, car.z * minimap.scale + minimap.oz);
  ctx.rotate(-car.th);
  ctx.fillStyle = '#f2c230';
  ctx.beginPath();
  ctx.moveTo(0, 6);
  ctx.lineTo(4, -4);
  ctx.lineTo(-4, -4);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** The drift box tracks every frame; the numbers refresh at 20 Hz. */
export function updateHud(dt: number): void {
  sinceRefresh += dt;
  const chain = game.chain;
  hud.box.classList.toggle('on', !!chain);
  if (sinceRefresh < 0.05) return;
  sinceRefresh = 0;

  hud.lapNo.textContent = String(game.lap);
  hud.lapTime.textContent = game.lapStart === null ? '0:00.000' : formatTime(game.now - game.lapStart);
  hud.best.textContent = formatTime(game.best);
  hud.last.textContent = formatTime(game.last);
  hud.lapScore.textContent = String(Math.round(game.lapScore + (chain ? chain.pts : 0)));
  hud.bestScore.textContent = game.bestScore === null ? '–' : String(game.bestScore);
  hud.pts.textContent = String(chain ? Math.round(chain.pts) : 0);
  hud.mult.textContent = '×' + (chain ? chain.mult : 1);

  const angle = clamp(game.angle, 0, 90);
  hud.angle.style.width = `${100 - (angle / 90) * 100}%`;
  hud.angleTxt.textContent = `${Math.round(angle)}°`;

  const kmh = Math.hypot(car.vx, car.vz) * 3.6;
  hud.speed.textContent = String(Math.round(kmh));
  hud.gear.textContent = car.gear < 0 ? 'R' : String(car.gear);
  hud.rpm.style.width = `${clamp(car.rpm / CAR.redline, 0, 1) * 100}%`;
  hud.rpmBox.classList.toggle('limit', car.rpm > CAR.redline - 400);
  drawMinimap();
}
