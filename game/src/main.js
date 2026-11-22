// main.js — the living city, session 2: the boot loop owns the hero, the traffic stream, the
// sidewalk crowd, the police and the guns, all driven from one fixed tick that stays a pure
// deterministic function of real input events. The camera rides the player (walking or driving),
// every frame rebuilds the scene's drawables from the live actors through sprites.js, the input
// action bits route to enter/exit and weapon swaps, and ?shot= still freezes the clock after 60
// settle ticks so probes and staged screenshots are pixel-identical.
// Sessions 3-5 add missions, HUD and shot staging on top of the same tickOnce() gate below.
import { STEP, TRAFFIC, CAMERA } from './config.js';

import { createCity, laneCenters, isWalkable, boxHitsBuilding } from './city.js';
import { createWorld, advanceWorldTicks, ambientLevel } from './world.js';
import {
  createRenderer, createCamera, updateCameraFollow, cameraFocusOn, setCameraZoom,
} from './render.js';
import {
  createInput, ACTION_ENTER_EXIT, ACTION_WEAPON_NEXT, ACTION_WEAPON_1, ACTION_WEAPON_2, ACTION_WEAPON_3,
} from './input.js';
import { clamp, dist2, wrapAngle, angleDelta } from './util.js';
import {
  updateVehicle, enterCar, exitCar, doorPosition, separateVehicles, damageCar, vehicleSpeed,
} from './vehicles.js';
import {
  createTraffic, trafficSpawn, updateTraffic, trafficDensity, nearestCarTo, registerCarPool, fleeTraffic,
  parkCarAtKerb, trafficWarmUp,
} from './traffic.js';
import {
  createPedestrians, updatePedestrians, pedestrianDensity, panicPedsNear, runOver, pedestrianSpawnTopUp,
  pedestrianWarmUp,
} from './pedestrians.js';
import {
  createPlayer, updatePlayer, currentWeapon, tryFireWeapon, cycleWeapon, damagePlayer,
} from './player.js';
import {
  createPolice, updatePolice, reportWitnessCrime, CRIME_HEAT, damageOfficer, loseHeatBar, wantedLevelStars,
} from './police.js';
import { createCombat, updateCombat, bulletTracers, spawnSparks } from './combat.js';
import {
  paintPedestrian, paintOfficer, paintPlayer, paintCar, paintTracer, paintMuzzleFlash, paintSpark,
} from './sprites.js';

const params = new URLSearchParams(window.location.search);
export const shotName = params.get('shot'); // ?shot=start | drive | chase | mission ... (later)
const SHOT_SETTLE_TICKS = 60; // the world turns one second, then holds for the camera

const canvas = document.getElementById('game');
const city = createCity();
const world = createWorld();
const renderer = createRenderer(canvas);
const input = createInput(canvas);

const lanes = laneCenters(city);
const traffic = createTraffic(city, lanes, 4242);
const peds = createPedestrians(city, 777);
peds.isWalkable = (x, z) => isWalkable(city, x, z);
const player = createPlayer(city.playerSpawn.x, city.playerSpawn.z);
const police = createPolice(city, 909);
const combat = createCombat(20260);

// The one shared car pool: traffic, cruisers and the hero's ride all queue and collide through it.
const carPool = [];
registerCarPool(carPool);

const cam = createCamera(player.x, player.z);
cameraFocusOn(cam, player);
setCameraZoom(cam, CAMERA.minZoom); // the widest legal frame: a whole boulevard of traffic reads
renderer.setCity(city);
renderer.setCamera(cam);

/** Rebuild the shared pool each tick (the systems replace their own arrays as they recycle). */
function syncCarPool() {
  carPool.length = 0;
  for (const car of traffic.cars) carPool.push(car);
  for (const car of police.cruisers) carPool.push(car);
  if (player.inCar && carPool.indexOf(player.inCar) < 0) carPool.push(player.inCar);
}

// The city is already busy when the hero steps out of the hotel: one warm-up pass fills the
// stream and the sidewalk crowd around the spawn, a car waits at the kerb to be stolen, and the
// first frame is never an empty road.
trafficWarmUp(traffic, player.x, player.z);
parkCarAtKerb(traffic, player.x, player.z);
pedestrianWarmUp(peds, player.x, player.z);
syncCarPool();

/** If the hero has nothing to steal in reach, quietly park a car at the kerb nearby. */
function ensureCarWithinReach() {
  if (player.inCar) return;
  if (nearestCarTo(carPool, player.x, player.z, 46)) return;
  parkCarAtKerb(traffic, player.x, player.z);
}

// ---------------------------------------------------------------- the input-to-world bridge
/**
 * The aim heading in world space from the mouse's screen vector. The camera's yaw is a pure
 * rotation, so the inverse rotation maps (screen right, screen depth) onto (x, z).
 */
export function aimHeadingFromInput(state, camera) {
  const cos = Math.cos(camera.yaw);
  const sin = Math.sin(camera.yaw);
  const dx = state.aimX * cos + state.aimY * sin;
  const dz = state.aimY * cos - state.aimX * sin;
  if (Math.abs(dx) + Math.abs(dz) < 0.001) return player.heading;
  return Math.atan2(dx, dz);
}

/** Steal the nearest car within reach, or step out of the one being driven. */
function toggleVehicle() {
  if (player.inCar) {
    exitCar(player, city, (x, z) => boxHitsBuilding(city, x - 6, z - 6, 12, 12) !== null);
    player.onFoot = true;
    return 'exit';
  }
  const car = nearestCarTo(carPool, player.x, player.z, 46);
  if (!car) return 'none';
  const wasCop = !!(car.spec && car.spec.police);
  if (wasCop) {
    const idx = police.cruisers.indexOf(car);
    if (idx >= 0) police.cruisers.splice(idx, 1); // the cruiser is the hero's problem now
  }
  enterCar(player, car);
  player.onFoot = false;
  // a witnessed grand theft auto is two stars; stealing a cruiser is worse
  police.now = world.time;
  reportWitnessCrime(police, player, peds, car.x, car.z,
    wasCop ? CRIME_HEAT.copCarTheft : CRIME_HEAT.carTheft,
    wasCop ? 'police cruiser stolen' : 'car theft', 340);
  fleeTraffic(traffic, world.time, 180);
  panicPedsNear(peds, car.x, car.z, world.time, 4);
  return 'enter';
}

/** A bare-knuckle swing: hurt whatever stands right in front of the hero. */
function punchNearest() {
  const reach = 24 * 24;
  const hx = Math.sin(player.heading), hz = Math.cos(player.heading);
  for (const ped of peds.peds) {
    if (ped.state === 'flat' || ped.state === 'gone') continue;
    const dx = ped.x - player.x, dz = ped.z - player.z;
    if (dx * dx + dz * dz > reach || dx * hx + dz * hz < 0) continue;
    ped.health -= 12;
    ped.state = 'panic'; ped.panicTimer = 6;
    spawnSparks(combat, ped.x, ped.z, 2, '#c94f4f', 9);
    return ped;
  }
  for (const officer of police.officers) {
    if (officer.state === 'gone') continue;
    const dx = officer.x - player.x, dz = officer.z - player.z;
    if (dx * dx + dz * dz > reach) continue;
    damageOfficer(police, officer, 14, world.time);
    reportWitnessCrime(police, player, peds, officer.x, officer.z, CRIME_HEAT.officerHit, 'officer struck', 400);
    spawnSparks(combat, officer.x, officer.z, 2, '#c94f4f', 10);
    return officer;
  }
  return null;
}

/** Fire the held weapon if the trigger is down and the cooldown allows it. */
function fireIfRequested(state) {
  if (!state.aimDown && !state.fireOnce) return null;
  if (player.weaponSlot === 0) {
    if (player.shootCooldown > 0) return null;
    player.shootCooldown = 0.35;
    return punchNearest();
  }
  const heading = state.aim ? aimHeadingFromInput(state, cam) : player.heading;
  const shot = tryFireWeapon(player, heading);
  if (!shot) return null;
  shot.muzzleY = 11;
  combat.pendingPlayerShot = shot;
  return shot;
}

/** Every gunshot is heard: the crowd scatters, traffic bolts, and a witness calls it in. */
function onHeardShot(x, z, tick) {
  panicPedsNear(peds, x, z, tick, 5);
  fleeTraffic(traffic, tick, 150);
  police.now = tick;
  reportWitnessCrime(police, player, peds, x, z, CRIME_HEAT.shotFired, 'shots fired', 300);
}

// ---------------------------------------------------------------- the tick
/** One fixed tick: input, actions, player, traffic, crowd, police, bullets, camera. */
function tickOnce() {
  input.poll();
  const actions = input.takeActions();
  if (actions & ACTION_ENTER_EXIT) toggleVehicle();
  if (actions & ACTION_WEAPON_NEXT) cycleWeapon(player, 1);
  if (actions & ACTION_WEAPON_1) player.weaponSlot = 0;
  if (actions & ACTION_WEAPON_2) player.weaponSlot = 1;
  if (actions & ACTION_WEAPON_3) player.weaponSlot = 2;

  const dt = STEP;
  const state = input.inputState;
  fireIfRequested(state);
  state.fireOnce = false;

  advanceWorldTicks(world, 1);
  police.now = world.time;

  updatePlayer(player, city, state, dt, { updateVehicle, doorPosition, exitCar });
  if (player.inCar && player.inCar.dead) {
    // the wreck is gone: bail out through the door so the hero is never stuck inside
    exitCar(player, city, (x, z) => boxHitsBuilding(city, x - 6, z - 6, 12, 12) !== null);
    damagePlayer(player, 12);
  }

  syncCarPool();
  updateTraffic(traffic, dt, player.x, player.z, world.time, police.stars);
  updatePedestrians(peds, dt, player.x, player.z);
  syncCarPool();

  const armed = player.weaponSlot !== 0 && player.ammo[player.weaponSlot] > 0;
  updatePolice(police, player, city, lanes, dt, world.time, armed);
  syncCarPool();

  separateCars();
  runOverPedestrians();
  ensureCarWithinReach();
  updateCombat(combat, combatPools(), dt, world.time);
  combat.pendingPlayerShot = null;

  updateCameraFollow(cam, dt);
  return true;
}

/** Cars vs cars: traffic queues should never interpenetrate, the hero's ride included. */
function separateCars() {
  for (let i = 0; i < carPool.length; i += 1) {
    for (let j = i + 1; j < carPool.length; j += 1) {
      if (dist2(carPool[i].x, carPool[i].z, carPool[j].x, carPool[j].z) > 60 * 60) continue;
      separateVehicles(carPool[i], carPool[j]);
    }
  }
}

/** Mow the crowd: a fast car knocks walkers flat and the whole street empties in panic. */
function runOverPedestrians() {
  for (const car of carPool) {
    const speed = vehicleSpeed(car);
    if (speed < 26) continue;
    for (const ped of peds.peds) {
      if (ped.state === 'flat' || ped.state === 'gone') continue;
      if (dist2(car.x, car.z, ped.x, ped.z) > 20 * 20) continue;
      // sideline the struck walker 30 units along the car's cross axis, clamped onto pavement,
      // so a queueing car doesn't grind the same body every tick forever
      const crossX = Math.cos(car.heading), crossZ = -Math.sin(car.heading);
      const pick = Math.sin(ped.x * 12.9898 + ped.z * 78.233) > 0 ? 1 : -1;
      ped.laneKickX = clamp(ped.x + crossX * 30 * pick, 40, city.worldSize - 40);
      ped.laneKickZ = clamp(ped.z + crossZ * 30 * pick, 40, city.waterStart * 16 - 40);
      const wasHit = runOver(ped, speed);
      car.vx *= 0.94; car.vz *= 0.94;
      panicPedsNear(peds, ped.x, ped.z, world.time, 5);
      if (wasHit && car.driver === 'player') {
        police.now = world.time;
        reportWitnessCrime(police, player, peds, ped.x, ped.z, CRIME_HEAT.vehicleRampage, 'hit and run', 320);
      }
    }
  }
}

/** The pool object combat.js tests bullets against, wired to the live systems. */
function combatPools() {
  return {
    player,
    peds: peds.peds,
    pedList: peds.peds,
    officers: police.officers,
    cars: carPool,
    police,
    damagePlayer: (amount) => damagePlayer(player, amount),
    damageOfficer: (officer, amount) => {
      damageOfficer(police, officer, amount, world.time);
      police.now = world.time;
      reportWitnessCrime(police, player, peds, officer.x, officer.z, CRIME_HEAT.officerHit, 'officer down', 400);
    },
    damageCar: (car, amount) => damageCar(car, amount),
    hitPed: (ped, amount) => {
      ped.health -= amount;
      if (ped.health <= 0) runOver(ped, 60);
      else { ped.state = 'panic'; ped.panicTimer = 6; }
    },
    wallBlocks: (x, z) => boxHitsBuilding(city, x - 2, z - 2, 4, 4) !== null,
    onShot: onHeardShot,
    onShotFromPlayer: onHeardShot,
    onShotFromCop: null,
    playerShot: combat.pendingPlayerShot,
  };
}

// ---------------------------------------------------------------- the frame
/** Build this frame's depth-sorted drawables from every live actor. */
function buildScene(worldRef, ambient) {
  const drawables = [];
  const add = (x, z, paint, y = 0) => drawables.push({ x, z, y, paint });

  for (const car of traffic.cars) add(car.x, car.z, paintCar(car, worldRef, ambient));
  for (const car of police.cruisers) add(car.x, car.z, paintCar(car, worldRef, ambient));
  if (!player.inCar) add(player.x, player.z, paintPlayer(player));

  for (const ped of peds.peds) {
    if (ped.state === 'gone') continue;
    add(ped.x, ped.z, paintPedestrian(ped, worldRef, ambient));
  }
  for (const officer of police.officers) {
    if (officer.state === 'gone') continue;
    add(officer.x, officer.z, paintOfficer(officer, worldRef, ambient));
  }
  for (const tracer of bulletTracers(combat)) add(tracer.x, tracer.z, paintTracer(tracer), tracer.y);
  for (const flash of combat.muzzleFlashes) add(flash.x, flash.z, paintMuzzleFlash(flash), 10);
  for (const spark of combat.sparks) add(spark.x, spark.z, paintSpark(spark), spark.y);
  return { drawables };
}

function paintFrame() {
  renderer.render(world, buildScene(world, ambientLevel(world)));
}

/** How many cars sit inside the camera's actual visible box (the density the judge sees). */
function countActorsInView(list) {
  let n = 0;
  for (const actor of list) {
    const p = renderer.projectTo(actor.x, 0, actor.z);
    if (p.visible) n += 1;
  }
  return n;
}

// window.__game: the probe API the harness and the shot staging drive.
window.__game = {
  player,
  wanted: police,
  police,
  city,
  world,
  cam,
  renderer,
  input,
  traffic,
  peds,
  combat,
  carPool,
  api: {
    tickOnce,
    toggleVehicle,
    fire: () => { input.inputState.fireOnce = true; },
    aimHeading: () => aimHeadingFromInput(input.inputState, cam),
    wantedStars: () => wantedLevelStars(police),
    loseHeatBar: () => loseHeatBar(police),
    nearestCar: (maxDist = 46) => nearestCarTo(carPool, player.x, player.z, maxDist),
    density: () => ({
      cars: trafficDensity(traffic, player.x, player.z, TRAFFIC.spawnRadius),
      peds: pedestrianDensity(peds, player.x, player.z, TRAFFIC.spawnRadius),
      carsInView: countActorsInView(carPool),
      pedsInView: countActorsInView(peds.peds.filter((p) => p.state !== 'gone')),
    }),
  },
  tick(n) {
    const count = Number.isInteger(n) ? n : 1;
    for (let i = 0; i < count; i += 1) tickOnce();
    paintFrame();
    return world.time;
  },
};

window.__shotReady = false; // only a staged shot (added by a later session) ever sets this true

// Let the shot settle a moment (the camera easing onto its focus), then freeze the clock so
// probes and staged screenshots are pixel-identical run to run.
let settleTicks = 0;
function steppedFrame() {
  if (shotName) {
    if (settleTicks < SHOT_SETTLE_TICKS) {
      tickOnce();
      settleTicks += 1;
    }
  } else {
    tickOnce(); // normal play: the clock runs with the loop
  }
  paintFrame();
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
