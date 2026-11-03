// Phones play sideways. Drive asks for fullscreen and a landscape lock where the browser allows it (Chrome on
// Android); elsewhere, a phone held upright gets a card asking to turn it, and the drive waits, or pauses, until
// it's turned. Anyone who can't turn the screen can drive upright anyway.

import { startAudio } from './audio';
import { byId } from './dom';
import { startOrResume, togglePause } from './game';
import { isTouchDevice } from './stage';
import { app } from './state';

/** A phone held upright. A tablet has the width to drive either way round, so it isn't asked to turn. */
const upright = matchMedia('(orientation: portrait) and (max-width: 600px)');
const card = byId('rotate');
/** A drive waiting for the phone to turn: Drive tapped upright, or the phone turned upright mid-drive. */
let waiting = false;
/** The player chose to drive upright this visit; don't ask again. */
let uprightAnyway = false;

const needsTurning = () => isTouchDevice && upright.matches && !uprightAnyway;

async function goSideways(): Promise<void> {
  try {
    if (document.fullscreenEnabled && !document.fullscreenElement) {
      await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    }
    // Only allowed in fullscreen, and missing from some browsers and from TypeScript's types.
    const orientation = screen.orientation as ScreenOrientation & { lock?: (to: string) => Promise<void> };
    await orientation.lock?.('landscape');
  } catch {
    // Not allowed here (iPhone, or a browser that says no): the card asks instead.
  }
}

/** What the Drive button does: on a phone, go fullscreen and sideways first. */
export async function drive(): Promise<void> {
  if (!isTouchDevice) {
    startOrResume();
    return;
  }
  // Inside the tap, so sound is allowed to start even if the drive itself waits for the phone to turn.
  startAudio();
  if (upright.matches) await goSideways();
  if (needsTurning()) {
    waiting = true;
    card.hidden = false;
    return;
  }
  startOrResume();
}

export function watchOrientation(): void {
  if (!isTouchDevice) return;
  upright.addEventListener('change', () => {
    if (needsTurning()) {
      if (app.mode === 'play') {
        togglePause();
        waiting = true;
      }
      card.hidden = !waiting;
    } else {
      card.hidden = true;
      if (waiting) {
        waiting = false;
        startOrResume();
      }
    }
  });
  byId('btnUpright').addEventListener('click', () => {
    uprightAnyway = true;
    card.hidden = true;
    waiting = false;
    startOrResume();
  });
}
