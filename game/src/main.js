// main.js — the boot stub for session 1: it wires the static world together and keeps the fixed
// 1/60 tick running (rAF-led, with a setInterval heartbeat that catches up if rAF stalls), so the
// city renders and the probe API is live while sessions 2-5 add the player, traffic, police,
// missions and HUD on top. ?shot=name is parsed here and exposed as shotName; once staging lands
// (a later session) it will freeze the pinned scene and set window.__shotReady, but for now any
// ?shot= only freezes the world clock after a short settle so probes always render a static frame.
import { STEP } from './config.js';

import { createCity } from './city.js';
import { createWorld, advanceWorldTicks } from './world.js';
import { createRenderer, createCamera, updateCameraFollow } from './render.js';
import { createInput } from './input.js';

const params = new URLSearchParams(window.location.search);
export const shotName = params.get('shot'); // ?shot=start | drive | chase | mission ... (later)
const SHOT_SETTLE_TICKS = 60; // the world turns one second, then holds for the camera

const canvas = document.getElementById('game');
const city = createCity();
const world = createWorld();
const renderer = createRenderer(canvas);
const input = createInput(canvas);

const cam = createCamera(city.playerSpawn.x, city.playerSpawn.z);
renderer.setCity(city);
renderer.setCamera(cam);

// The fixed tick: input is polled, the world clock advances, then the camera eases. Every
// gameplay module later sessions add hooks this one place; tick(n) replays n of them exactly.
function tickOnce() {
  input.poll();
  input.takeActions(); // drained here; session 2+ routes the flag bits
  advanceWorldTicks(world, 1);
  updateCameraFollow(cam, STEP * 4); // a slow drift onto the spawn; actors steer it later
  return true;
}

// window.__game: the probe API the harness and the shot staging drive.
window.__game = {
  player: null, // session 2 sets the player actor here
  wanted: null, // session 3 sets the wanted level state here
  city,
  world,
  cam,
  renderer,
  input,
  tick(n) {
    const count = Number.isInteger(n) ? n : 1;
    for (let i = 0; i < count; i += 1) tickOnce();
    renderer.render(world, null);
    return world.time;
  },
};

window.__shotReady = false; // only a staged shot (added by a later session) ever sets this true

// Let the shot settle a moment (the camera easing onto its focus), then freeze the clock so
// probes and staged screenshots are pixel-identical run to run.
let settleTicks = 0;
function steppedFrame() {
  if (settleTicks < SHOT_SETTLE_TICKS) {
    tickOnce();
    settleTicks += 1;
    if (settleTicks >= SHOT_SETTLE_TICKS && shotName) {
      // staged shot not implemented yet (a later session owns it): freeze, never signal ready
    }
  }
  renderer.render(world, null);
}

// The frame loop: rAF paints; a 33ms interval is the fallback heartbeat that keeps ticks and
// paint coming when rAF is throttled (a hidden or backgrounded tab during a probe run).
let rafAlive = false;
function frame() {
  rafAlive = true;
  steppedFrame();
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
setInterval(() => {
  if (!rafAlive || document.hidden) steppedFrame();
  rafAlive = false;
}, 33);
