import { applySoundOption } from './audio';
import { buildCar, CAR_COLOURS, carStyle, loadCar, setCarStyle } from './car-model';
import { CAR_STYLES } from './car-style';
import { CARS } from './cars';
import { byId } from './dom';
import { resetSession } from './game';
import { drive, watchOrientation } from './mobile';
import { applyShadows } from './stage';
import { options, store } from './state';
import { initTopbar } from './topbar';
import { track } from './track';

type Toggle = 'assist' | 'sound' | 'shadows';

function bindToggle(id: string, option: Toggle, onChange?: () => void): void {
  const input = byId<HTMLInputElement>(id);
  input.checked = options[option];
  input.addEventListener('change', () => {
    options[option] = input.checked;
    store.set('opt', options);
    onChange?.();
  });
}

let switching = false;

const markCar = (id: string) =>
  document.querySelectorAll<HTMLElement>('.car-pick').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.car === id)));

/** The livery's lettering uses the page font; wait for it so the first drift build isn't in a stand-in. */
const liveryFont = () => document.fonts?.load('italic 700 40px "Saira Semi Condensed"').catch(() => []) ?? Promise.resolve([]);

const paintColour = () => CAR_COLOURS[options.color]?.[1] ?? CAR_COLOURS[0][1];

/**
 * Fetches a car if it isn't loaded yet, swaps it in and starts a fresh session with it. Returns false, and
 * keeps the car there was, if it won't load.
 */
export async function selectCar(id: string): Promise<boolean> {
  if (switching) return false;
  switching = true;
  const start = byId<HTMLButtonElement>('btnStart');
  start.disabled = true;
  start.textContent = 'Loading…';
  markCar(id);
  try {
    const { spec, shape } = await loadCar(id);
    if (carStyle() === 'drift') await liveryFont();
    options.car = spec.id;
    store.set('opt', options);
    buildCar(paintColour());
    resetSession();
    byId('factCar').textContent = `${shape.length.toFixed(2)} m`;
    byId('carBlurb').textContent = spec.blurb;
    return true;
  } catch (err) {
    console.warn(err);
    byId('carBlurb').textContent = `That car didn't load. Check the connection and pick it again.`;
    markCar(options.car);
    return false;
  } finally {
    switching = false;
    start.disabled = false;
    start.textContent = 'Drive';
  }
}

export function initMenu(): void {
  const picker = byId('cars');
  for (const spec of CARS) {
    const pick = document.createElement('button');
    pick.type = 'button';
    pick.className = 'car-pick';
    pick.dataset.car = spec.id;
    pick.setAttribute('role', 'radio');
    pick.setAttribute('aria-checked', String(spec.id === options.car));
    const name = document.createElement('b');
    name.className = 'num';
    name.textContent = spec.name;
    pick.append(name);
    for (const stat of [spec.power, `${spec.m.toLocaleString('en')} kg`]) {
      const line = document.createElement('span');
      line.textContent = stat;
      pick.append(line);
    }
    pick.addEventListener('click', () => void selectCar(spec.id));
    picker.append(pick);
  }

  const looks = byId('looks');
  for (const [look, label] of CAR_STYLES) {
    const pick = document.createElement('button');
    pick.type = 'button';
    pick.className = 'look-pick';
    pick.textContent = label;
    pick.setAttribute('role', 'radio');
    pick.setAttribute('aria-checked', String(look === carStyle()));
    pick.addEventListener('click', async () => {
      setCarStyle(look);
      looks.querySelectorAll('.look-pick').forEach((b) => b.setAttribute('aria-checked', String(b === pick)));
      if (look === 'drift') await liveryFont();
      buildCar(paintColour());
    });
    looks.append(pick);
  }

  const swatches = byId('swatches');
  CAR_COLOURS.forEach(([name, colour], i) => {
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'swatch';
    swatch.id = 'sw' + i;
    swatch.setAttribute('role', 'radio');
    swatch.setAttribute('aria-label', name);
    swatch.setAttribute('aria-checked', String(i === options.color));
    swatch.style.background = '#' + colour.toString(16).padStart(6, '0');
    swatch.addEventListener('click', () => {
      options.color = i;
      store.set('opt', options);
      swatches.querySelectorAll('.swatch').forEach((s, n) => s.setAttribute('aria-checked', String(n === i)));
      buildCar(CAR_COLOURS[i][1]);
    });
    swatches.appendChild(swatch);
  });

  bindToggle('optAssist', 'assist');
  bindToggle('optSound', 'sound', applySoundOption);
  bindToggle('optShadows', 'shadows', applyShadows);

  byId('btnStart').addEventListener('click', () => void drive());
  watchOrientation();
  initTopbar();

  byId('factLen').textContent = `${Math.round(track.length)} m`;
  byId('factWidth').textContent = `${Math.round(track.avgWidth)} m`;
}
