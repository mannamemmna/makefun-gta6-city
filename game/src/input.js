// input.js — the keyboard and mouse map for Calvera Bay. One normalized inputState object is
// read by the fixed tick (never polled ad hoc), so a key held between frames is one state, and
// one-shot presses (pause, enter/exit, weapon swaps) are queued as flags the tick drains once.
// Nothing here touches the game state; sessions later only ever read inputState and takeActions.

import { WEAPONS } from './config.js';

/** One-shot actions, taken once per press: bit flags drained by the tick. */
export const ACTION_PAUSE = 1;
export const ACTION_ENTER_EXIT = 2; // E: steal a car / get out
export const ACTION_WEAPON_NEXT = 4;
export const ACTION_WEAPON_1 = 8;
export const ACTION_WEAPON_2 = 16;
export const ACTION_WEAPON_3 = 32;
export const ACTION_HORN = 64;

/** Create the input listener set for the whole game. target is the canvas. */
export function createInput(target) {
  const held = {
    forward: false, back: false, left: false, right: false,
    brake: false, sprint: false, aim: false, horn: false,
  };

  /** The state every system reads: move axes in -1..1, aim in world space of mouse. */
  const inputState = {
    moveX: 0, // strafe / steer: -1..1
    moveY: 0, // forward+: -1..1
    brake: false, // space: handbrake in a car, brake on foot
    sprint: false, // shift
    aim: false, // F held (or right mouse): aiming
    aimX: 0, aimY: 0, // aim vector, normalized, screen space for now
    aimDown: false, // fire pressed this frame (mouse button while aiming)
    weapon: 0, // index into WEAPONS
    paused: false,
  };

  let actions = 0;

  const KEYMAP = {
    KeyW: 'forward', ArrowUp: 'forward',
    KeyS: 'back', ArrowDown: 'back',
    KeyA: 'left', ArrowLeft: 'left',
    KeyD: 'right', ArrowRight: 'right',
    Space: 'brake',
    ShiftLeft: 'sprint', ShiftRight: 'sprint',
    KeyF: 'aim',
    KeyH: 'horn',
  };

  window.addEventListener('keydown', (event) => {
    const key = KEYMAP[event.code];
    if (key) {
      held[key] = true;
      event.preventDefault();
      return;
    }
    switch (event.code) {
      case 'KeyP': case 'Escape':
        if (!event.repeat) actions |= ACTION_PAUSE;
        break;
      case 'KeyE':
        if (!event.repeat) actions |= ACTION_ENTER_EXIT;
        break;
      case 'Digit1': if (!event.repeat) actions |= ACTION_WEAPON_1; break;
      case 'Digit2': if (!event.repeat) actions |= ACTION_WEAPON_2; break;
      case 'Digit3': if (!event.repeat) actions |= ACTION_WEAPON_3; break;
      case 'KeyQ': if (!event.repeat) actions |= ACTION_WEAPON_NEXT; break;
      default: return;
    }
    event.preventDefault();
  });

  window.addEventListener('keyup', (event) => {
    const key = KEYMAP[event.code];
    if (key) held[key] = false;
  });

  // A key released while the tab is hidden never sends keyup: drop everything on blur.
  window.addEventListener('blur', () => {
    for (const key of Object.keys(held)) held[key] = false;
    inputState.aimDown = false;
  });

  // Mouse aim: the pointer's offset from the canvas centre, as a normalized vector, plus
  // left-click as fire while aiming. Each pointer event updates only inputState fields, so the
  // tick always reads the same consistent value.
  const rectOf = () => target.getBoundingClientRect();
  function setAimFromEvent(event) {
    const rect = rectOf();
    const dx = event.clientX - (rect.left + rect.width / 2);
    const dy = event.clientY - (rect.top + rect.height / 2);
    const len = Math.hypot(dx, dy) || 1;
    inputState.aimX = dx / len;
    inputState.aimY = dy / len;
  }
  target.addEventListener('pointermove', setAimFromEvent);
  target.addEventListener('pointerdown', (event) => {
    setAimFromEvent(event);
    if (event.button === 0) inputState.aimDown = true;
    if (event.button === 2) inputState.aim = true;
  });
  window.addEventListener('pointerup', (event) => {
    if (event.button === 0) inputState.aimDown = false;
    if (event.button === 2) inputState.aim = false;
  });
  target.addEventListener('contextmenu', (event) => event.preventDefault());

  /** Refresh inputState from the raw held keys. Called once per fixed tick before anyone reads. */
  function poll() {
    inputState.moveX = (held.right ? 1 : 0) - (held.left ? 1 : 0);
    inputState.moveY = (held.forward ? 1 : 0) - (held.back ? 1 : 0);
    inputState.brake = held.brake;
    inputState.sprint = held.sprint;
    inputState.aim = held.aim || inputState.aim; // keyboard F or right mouse hold
    inputState.weapon = Math.min(inputState.weapon, WEAPONS.length - 1);
  }

  /** Drain the one-shot action flags since the last call. */
  function takeActions() {
    const taken = actions;
    actions = 0;
    return taken;
  }

  /** Test hook: press and release a key by code, deterministically. */
  function press(code) {
    const key = KEYMAP[code];
    if (key) held[key] = true;
  }
  function release(code) {
    const key = KEYMAP[code];
    if (key) held[key] = false;
  }

  return { inputState, poll, takeActions, press, release };
}
