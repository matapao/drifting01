import { applySoundOption, startAudio } from './audio';
import { cycleCamera } from './camera';
import { byId } from './dom';
import { respawn, togglePause } from './game';
import { clamp } from './math';
import { isTouchDevice } from './stage';
import { app, controls, options } from './state';

const keys = new Set<string>();
const touch = { steer: 0, gas: 0, brake: 0, hand: false, active: false };

export function bindKeyboard(): void {
  addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLInputElement) return;
    const key = event.key.toLowerCase();
    keys.add(key);
    if ([' ', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'].includes(key)) event.preventDefault();
    if (event.repeat) return;
    if (key === 'c') cycleCamera();
    if (key === 'r') respawn();
    if (key === 'p' || key === 'escape') togglePause();
    if (key === 'm') {
      options.sound = !options.sound;
      byId<HTMLInputElement>('optSound').checked = options.sound;
      applySoundOption();
    }
  });
  addEventListener('keyup', (event) => keys.delete(event.key.toLowerCase()));
  addEventListener('blur', () => keys.clear());
}

export function bindTouch(): void {
  if (!isTouchDevice) return;
  byId('touch').hidden = false;
  document.body.classList.add('touch-on');

  blockPageGestures();

  const pad = byId('steerPad');
  const rail = byId('steerRail');
  const knob = byId('steerKnob');
  let pointer: number | null = null;
  let originX = 0;
  const travel = () => rail.clientWidth / 2 - knob.offsetWidth / 2;

  // Sound picks up again on the first touch after a pause: some phones only allow it inside a tap.
  pad.addEventListener('pointerdown', (event) => {
    startAudio();
    pointer = event.pointerId;
    originX = event.clientX;
    pad.setPointerCapture(pointer);
    touch.active = true;
    // The rail comes to the thumb, wherever on the pad it lands.
    rail.classList.add('held');
    rail.style.transform = '';
    const rest = rail.getBoundingClientRect();
    const area = pad.getBoundingClientRect();
    const dx = clamp(event.clientX - (rest.left + rest.width / 2), area.left - rest.left, area.right - rest.right);
    const dy = clamp(event.clientY - (rest.top + rest.height / 2), area.top - rest.top, area.bottom - rest.bottom);
    rail.style.transform = `translate(${dx}px, ${dy}px)`;
  });
  pad.addEventListener('pointermove', (event) => {
    if (event.pointerId !== pointer) return;
    const offset = clamp((event.clientX - originX) / Math.max(60, travel()), -1, 1);
    touch.steer = -offset;
    knob.style.transform = `translateX(${offset * travel()}px)`;
  });
  const release = (event: PointerEvent) => {
    if (event.pointerId === pointer) {
      pointer = null;
      touch.steer = 0;
      knob.style.transform = '';
      rail.classList.remove('held');
      rail.style.transform = '';
    }
  };
  pad.addEventListener('pointerup', release);
  pad.addEventListener('pointercancel', release);

  const bindPedal = (id: string, press: () => void, lift: () => void) => {
    const pedal = byId(id);
    pedal.addEventListener('pointerdown', (event) => {
      startAudio();
      pedal.setPointerCapture(event.pointerId);
      pedal.classList.add('active');
      press();
      touch.active = true;
    });
    const up = () => {
      pedal.classList.remove('active');
      lift();
    };
    pedal.addEventListener('pointerup', up);
    pedal.addEventListener('pointercancel', up);
    pedal.addEventListener('lostpointercapture', up);
  };
  bindPedal('tGas', () => (touch.gas = 1), () => (touch.gas = 0));
  bindPedal('tBrake', () => (touch.brake = 1), () => (touch.brake = 0));
  bindPedal('tHand', () => (touch.hand = true), () => (touch.hand = false));
  addEventListener('contextmenu', (event) => event.preventDefault());
}

/**
 * Safari on iPhone and iPad zooms on a double tap or a pinch whatever touch-action says, and ignores
 * user-scalable=no. Mid-drive that throws the controls off screen. While driving, no touch outside the corner
 * buttons starts a page gesture at all (the pedals and the pad run on pointer events, which still arrive); in
 * the menus, a quick second tap is kept from zooming and gets its click here instead.
 */
function blockPageGestures(): void {
  const native = (target: EventTarget | null) => (target as Element).closest?.('.topbar, .game-tools-panel');
  document.addEventListener(
    'touchstart',
    (event) => {
      if (app.mode === 'play' && !native(event.target)) event.preventDefault();
    },
    { passive: false },
  );
  let lastTap = 0;
  document.addEventListener(
    'touchend',
    (event) => {
      const quick = event.timeStamp - lastTap < 400;
      lastTap = event.timeStamp;
      if (!quick || event.touches.length || (event.target as Element).closest?.('.game-tools-panel, select')) return;
      event.preventDefault();
      const touchPoint = event.changedTouches[0];
      const clickable = 'button, a[href], label, input, summary';
      const tapped = (event.target as Element).closest?.<HTMLElement>(clickable);
      const under = document.elementFromPoint(touchPoint.clientX, touchPoint.clientY)?.closest(clickable);
      if (tapped && tapped === under) tapped.click();
    },
    { passive: false },
  );
  for (const type of ['gesturestart', 'gesturechange']) document.addEventListener(type, (event) => event.preventDefault());
}

let keyboardSteer = 0;

/** Merges keyboard and touch into `controls`. Keyboard steering eases in, and faster when reversing lock. */
export function readControls(dt: number): void {
  const left = keys.has('a') || keys.has('arrowleft');
  const right = keys.has('d') || keys.has('arrowright');
  const target = (left ? 1 : 0) - (right ? 1 : 0);
  const rate = target === 0 ? 6 : Math.sign(target) !== Math.sign(keyboardSteer) && keyboardSteer !== 0 ? 9 : 4;
  keyboardSteer += clamp(target - keyboardSteer, -rate * dt, rate * dt);

  let steer = keyboardSteer;
  let gas = keys.has('w') || keys.has('arrowup') ? 1 : 0;
  let brake = keys.has('s') || keys.has('arrowdown') ? 1 : 0;
  let hand = keys.has(' ');
  let analog = false;
  if (touch.active) {
    if (Math.abs(touch.steer) > 0.01) {
      steer = touch.steer;
      analog = true;
    }
    gas = Math.max(gas, touch.gas);
    brake = Math.max(brake, touch.brake);
    hand = hand || touch.hand;
  }
  controls.steer = steer;
  controls.gas = gas;
  controls.brake = brake;
  controls.hand = hand;
  controls.analog = analog;
  controls.assist = options.assist;
}
