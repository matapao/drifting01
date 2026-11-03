// The corners: a back button that leaves the game, and a menu with the camera, back on track, pause and
// zirbel's revisions, so nothing sits in the middle of the view. On zirbel.app these stand in for zirbel's own
// bar, which is hidden; its buttons still do the work.

import { cameraName, cycleCamera } from './camera';
import { byId } from './dom';
import { respawn, togglePause } from './game';
import { viewCanvas } from './stage';
import { app } from './state';

/** zirbel.app adds its stage to every game page it serves. */
const onZirbel = document.querySelector('meta[name="zirbel-stage"]') !== null;
const zirbelButton = (selector: string) => document.querySelector<HTMLButtonElement>(`.game-tools-dock ${selector}`);

export function initTopbar(): void {
  const toggle = byId('btnMenu');
  const sheet = byId('menuSheet');
  const camName = byId('mCamName');
  document.body.classList.toggle('on-zirbel', onZirbel);
  byId('btnBack').hidden = !onZirbel;
  byId('mRevisions').hidden = !onZirbel;

  const open = (show: boolean) => {
    sheet.hidden = !show;
    toggle.setAttribute('aria-expanded', String(show));
    camName.textContent = cameraName();
  };
  // Back to the drive: keys go to the game again, not to the last button tapped.
  const done = () => {
    open(false);
    if (app.mode === 'play') viewCanvas.focus();
  };
  toggle.addEventListener('click', () => open(toggle.getAttribute('aria-expanded') !== 'true'));
  addEventListener('pointerdown', (event) => {
    if (!sheet.hidden && !(event.target as Element).closest('.topbar-menu')) open(false);
  });
  addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !sheet.hidden) done();
  });

  // The sheet stays open on the camera, so a few taps step through the views.
  byId('mCam').addEventListener('click', () => {
    cycleCamera();
    camName.textContent = cameraName();
  });
  byId('mReset').addEventListener('click', () => {
    done();
    respawn();
  });
  byId('mPause').addEventListener('click', () => {
    open(false);
    togglePause();
  });
  byId('mRevisions').addEventListener('click', () => {
    open(false);
    if (app.mode === 'play') togglePause();
    zirbelButton('.game-tools-revisions')?.click();
  });
  byId('btnBack').addEventListener('click', () => {
    const leave = zirbelButton('[aria-label="Leave game"]');
    if (leave) leave.click();
    else location.href = '/';
  });
}
