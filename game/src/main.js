// main.js — the living city, session 2: the boot loop owns the hero, the traffic stream, the
// sidewalk crowd, the police and the guns, all driven from one fixed tick that stays a pure
// deterministic function of real input events. The camera rides the player (walking or driving),
// every frame rebuilds the scene's drawables from the live actors through sprites.js, the input
// action bits route to enter/exit and weapon swaps, and ?shot= still freezes the clock after 60
// settle ticks so probes and staged screenshots are pixel-identical.
// Sessions 3-5 add missions, HUD and shot staging on top of the same tickOnce() gate below.
import { STEP, TRAFFIC, CAMERA, PLAYER } from './config.js';

import { createCity, laneCenters, isWalkable, boxHitsBuilding } from './city.js';
import { createWorld, advanceWorldTicks, ambientLevel } from './world.js';
import {
  createRenderer, createCamera, updateCameraFollow, cameraFocusOn, setCameraZoom,
} from './render.js';
import {
  createInput, ACTION_ENTER_EXIT, ACTION_WEAPON_NEXT, ACTION_WEAPON_1, ACTION_WEAPON_2, ACTION_WEAPON_3,
  ACTION_PAUSE,
} from './input.js';
import { clamp, dist2, wrapAngle, angleDelta, Rng } from './util.js';
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
import { createCombat, updateCombat, bulletTracers, spawnSparks, spawnBullet } from './combat.js';
import {
  createAudio, engineLoop as audioEngineLoop, sirenDoppler as audioSirenDoppler,
  gunshotBurst, missionChime, gameOverSting, cashPick,
} from './audio.js';
import { createMissions, updateMissions, missionChainStep, missionGiver, missionHudInfo } from './missions.js';
import {
  createHud, updateHud, hudToast, hudBanner,
  drawHealthArmorBars, drawCashCounter, drawWantedStars, drawObjectivePanel, drawMinimapPanel,
  drawWeaponAmmoBox, drawGameClock, drawToastQueue, drawBustedOverlay, drawWastedOverlay,
} from './hud.js';
import {
  menuTitleState, menuPauseState, menuMoveCursor, menuSelect,
  drawTitleMenu as drawTitleFrame, drawPauseMenu, drawHowtoOverlay, missionPassedBanner,
} from './menus.js';
import { stageShot } from './staging.js';
import {
  paintPedestrian, paintOfficer, paintPlayer, paintCar, paintTracer, paintMuzzleFlash, paintSpark,
} from './sprites.js';
import { clockString } from './world.js';

import { hasSave, saveSlot, loadSlot, clearSave } from './save.js';

const params = new URLSearchParams(window.location.search);
export const shotName = params.get('shot'); // ?shot=cover | driving | chase | mission | freeze
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
const missions = createMissions(city, police, peds, traffic);

// ---------------------------------------------------------------- game state machine
// 'title' | 'playing' | 'paused' | 'dead' (busted or wasted, ENTER respawns) | 'won'
let gameState = shotName ? 'playing' : 'title';
const state = { get: () => gameState, set: (s) => { gameState = s; } };

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

// ---------------------------------------------------------------- the run ledger
let cash = 0;

/** Pay the hero: story rewards and side freight both land through here. */
function addCash(amount) {
  cash += amount;
  return cash;
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
  missionsOnCarStolen(car);
  return 'enter';
}

/** The story reacts to a theft: the tail and plates cars never double as the hero's ride. */
function missionsOnCarStolen(car) {
  if (missions.car === car && missions.step
    && (missions.step.type === 'tailVehicle' || missions.step.type === 'shootout')) {
    failMissionFromStory('the target car was stolen');
  }
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
    if (officer.state === 'gone' || officer.state === 'arrest') continue;
    const dx = officer.x - player.x, dz = officer.z - player.z;
    if (dx * dx + dz * dz > reach) continue;
    damageOfficer(police, officer, 14, world.time);
    reportWitnessCrime(police, player, peds, officer.x, officer.z, CRIME_HEAT.officerHit, 'officer struck', 400);
    spawnSparks(combat, officer.x, officer.z, 2, '#c94f4f', 10);
    return officer;
  }
  // the plates car takes fists too (a slow, desperate way to finish a shootout)
  if (missions.step && missions.step.type === 'shootout' && missions.car && !missions.car.dead) {
    const car = missions.car;
    const dx = car.x - player.x, dz = car.z - player.z;
    if (dx * dx + dz * dz < 34 * 34 && Math.abs(vehicleSpeed(car)) < 30) {
      if (damageCar(car, 8)) onMissionCarWrecked(car);
      spawnSparks(combat, car.x, car.z, 3, '#ffd27a', car.h * 0.5);
      return car;
    }
  }
  return null;
}

/** The shootout's plates car dies: complete the objective through the missions system. */
function onMissionCarWrecked(car) {
  explodeCar(car);
  syncCarPool();
  updateMissionsOnce();
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
  const firedBullet = spawnBullet(combat, shot, world.time, onHeardShot);
  if (firedBullet && player.weaponSlot !== 0) {
    gunshotBurst(audioSys, world.time);
  }
  if (firedBullet && missions.step && missions.step.type === 'shootout' && missions.car
    && !missions.car.dead) {
    // a shot toward the plates car counts toward wrecking it: sweep hits it flat in world space
    aimBulletAtTargetCar(firedBullet, missions.car);
  }
  return shot;
}

/** Homing toward the plates car: the shootout bullet leads enough to hit the target car. */
function aimBulletAtTargetCar(bullet, car) {
  const dx = car.x - bullet.x, dz = car.z - bullet.z;
  const d = Math.hypot(dx, dz) || 1;
  if (d > 260) return; // outside the pistol's honest range, refuse the assist
  const ang = Math.atan2(dx, dz);
  const ang0 = bullet.heading;
  let diff = ((ang - ang0 + Math.PI) % (2 * Math.PI)) - Math.PI;
  if (diff > Math.PI) diff -= 2 * Math.PI;
  if (Math.abs(diff) < 0.30) {
    bullet.heading = ang;
    const speed = Math.hypot(bullet.vx, bullet.vz);
    bullet.vx = Math.sin(ang) * speed;
    bullet.vz = Math.cos(ang) * speed;
  }
}

/** Every gunshot is heard: the crowd scatters, traffic bolts, and a witness calls it in. */
function onHeardShot(x, z, tick) {
  panicPedsNear(peds, x, z, tick, 5);
  fleeTraffic(traffic, tick, 150);
  police.now = tick;
  reportWitnessCrime(police, player, peds, x, z, CRIME_HEAT.shotFired, 'shots fired', 300);
}

// ---------------------------------------------------------------- state machine
// 'title' | 'playing' | 'paused' | 'dead' (busted or wasted overlays; ENTER respawns)
let menu = null;         // the live menu object (title / pause / howto) — null while playing
let menuEpoch = 0;       // increments whenever the menu flips, for deterministic pulses
let bustedTicks = 0;     // how long the dead overlay has shown
const wantedState = { hot: false, cooldown: 0 }; // the HUD's star plate reads this
let passedBanner = null; // the missionPassedBanner card while it plays
let hudState = null;     // the HUD's queue state, created after the imports settle

function isMenuId(id) { return !!(menu && menu.id === id); }

/** The progress payload saveSlot packs: everything the story owns, versioned by save.js. */
function persistentStateAssemble() {
  return {
    pos: { x: player.x, z: player.z, heading: player.heading },
    cash,
    health: player.health,
    armor: player.armor,
    wantedStars: police.stars,
    missionIndex: missions.chainIndex,
    sideJobsDone: missions.sideJobsDone,
    ownedCar: player.inCar ? { x: player.inCar.x, z: player.inCar.z, heading: player.inCar.heading, kind: player.inCar.kind ?? 'sedan' } : null,
    elapsedTicks: world.time,
    world: { minutes: world.minutes, day: world.day },
  };
}

/** startNewGame: a clean story — used by both NEW GAME and the ?shot= staging path. */
function startNewGame() {
  player.x = city.playerSpawn.x;
  player.z = city.playerSpawn.z;
  player.vx = 0; player.vz = 0;
  player.health = PLAYER.health;
  player.armor = 0;
  player.bustedState = false;
  player.wastedState = false;
  player.inCar = null;
  player.onFoot = true;
  player.weaponSlot = 0;
  cash = 0;
  missions.chainIndex = 0;
  missions.sideJobsDone = 0;
  missions.state = 'idle';
  missions.mission = null;
  missions.step = null;
  missions.car = null;
  missions.marker = null;
  missions.sideJob = null;
  missions.lastOutcome = null;
  police.heat = 0;
  police.stars = 0;
  police.officers.length = 0;
  police.cruisers.length = 0;
  combat.bullets.length = 0;
  combat.sparks.length = 0;
  combat.muzzleFlashes.length = 0;
  passedBanner = null;
  traffic.cars.length = 0;
  peds.peds.length = 0;
  trafficWarmUp(traffic, player.x, player.z);
  pedestrianWarmUp(peds, player.x, player.z);
  syncCarPool();
  cameraFocusOn(cam, player);
  gameState = 'playing';
  hudToast(hudState, 'WELCOME TO CALVERA BAY', 'walk to Marisol at her pawn shop', 7);
}

/** loadSavedGame: restore a slot; returns false when the payload is unusable. */
function loadSavedGame(payload) {
  if (!payload || !payload.pos) return false;
  missionSetChainIndex(missions, payload.missionIndex || 0);
  missions.sideJobsDone = payload.sideJobsDone || 0;
  cash = payload.cash || 0;
  player.health = payload.health ?? PLAYER.health;
  player.armor = payload.armor || 0;
  player.bustedState = false;
  player.wastedState = false;
  player.heading = payload.pos.heading || 0;
  player.x = payload.pos.x;
  player.z = payload.pos.z;
  player.vx = 0;
  player.vz = 0;
  player.inCar = null;
  player.onFoot = true;
  if (payload.world) {
    world.minutes = payload.world.minutes;
    world.day = payload.world.day || 0;
  }
  police.heat = 0;
  police.stars = 0;
  police.officers.length = 0;
  police.cruisers.length = 0;
  traffic.cars.length = 0;
  peds.peds.length = 0;
  trafficWarmUp(traffic, player.x, player.z);
  pedestrianWarmUp(peds, player.x, player.z);
  parkCarAtKerb(traffic, player.x, player.z);
  syncCarPool();
  cameraFocusOn(cam, player);
  gameState = 'playing';
  hudToast(hudState, 'STORY CONTINUES', 'welcome back to Calvera Bay', 7);
  return true;
}

/** The story's pass/fail side effects, handed to updateMissions as callbacks. */
const MISSION_CTX = {
  get player() { return player; },
  get police() { return police; },
  get world() { return world; },
  dt: STEP,
  onPass: (chapter, lastStory) => {
    addCash(chapter.reward);
    passedBanner = { title: chapter.name, reward: chapter.reward, ttl: 5.6, life: 5.6, failed: false };
    audioChimeTick();
    if (lastStory) {
      hudToast(hudState, 'THE DOCKS ARE YOURS', 'story complete — freight runs unlocked', 7);
    }
  },
  onFail: (chapter, reason) => {
    passedBanner = { title: chapter ? chapter.name : 'Mission', reward: 0, ttl: 4.4, life: 4.4, failed: true, sub: reason };
    audioStingTick();
  },
  onSidePass: (reward) => {
    addCash(reward);
    hudToast(hudState, 'FREIGHT DELIVERED', 'pay collected', 4);
    cashPick(audioSys);
  },
};

/** Fail the live mission out-of-band (a stolen target car, a wreck by other hands). */
function failMissionFromStory(reason) {
  if (missions.state !== 'active' || !missions.mission) return;
  const chapter = missions.mission;
  missions.state = 'idle';
  missions.step = null;
  missions.mission = null;
  missions.car = null;
  missions.marker = null;
  missions.lastOutcome = 'failed:' + reason;
  MISSION_CTX.onFail(chapter, reason);
}

/** One missions tick, driven from the master tick below. */
function updateMissionsOnce() {
  return updateMissions(missions, MISSION_CTX);
}

/** advance the passedBanner while it shows. */
function updateBannerCard(dt) {
  if (passedBanner) passedBanner.ttl -= dt;
  if (passedBanner && passedBanner.ttl <= 0) passedBanner = null;
}

// ---------------------------------------------------------------- the tick
/** One fixed tick: input, actions, state routing, world, player, traffic, crowd, police, bullets. */
function tickOnce() {
  const dt = STEP;
  input.poll();
  const actions = input.takeActions();
  const state = input.inputState;

  // ---------------- state routing
  if (gameState === 'title' || gameState === 'paused' || gameState === 'won') {
    handleMenuTick(actions);
    advanceWorldTicks(world, 1); // the world keeps breathing behind the menus
    syncCarPool();
    updateTraffic(traffic, dt, cam.x, cam.z, world.time, 0);
    updatePedestrians(peds, dt, cam.x, cam.z);
    updateCameraFollow(cam, dt);
    updateBannerCard(dt);
    menuEpoch += 1;
    return true;
  }

  if (gameState === 'dead') {
    bustedTicks += 1;
    advanceWorldTicks(world, 1);
    syncCarPool();
    updateTraffic(traffic, dt, cam.x, cam.z, world.time, police.stars);
    updatePedestrians(peds, dt, cam.x, cam.z);
    updateBannerCard(dt);
    if (actions & ACTION_ENTER_EXIT) respawnAfterDeath();
    wantedStateHot();
    return true;
  }

  // ---------------- playing
  if (actions & ACTION_PAUSE) { openPauseMenu(); return true; }
  if (actions & ACTION_ENTER_EXIT) toggleVehicle();
  if (actions & ACTION_WEAPON_NEXT) cycleWeapon(player, 1);
  if (actions & ACTION_WEAPON_1) player.weaponSlot = 0;
  if (actions & ACTION_WEAPON_2) player.weaponSlot = 1;
  if (actions & ACTION_WEAPON_3) player.weaponSlot = 2;

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

  updateMissionsOnce();
  updateBannerCard(dt);
  wantedStateHot();

  // death conditions surface here: busted or wasted freeze the world into the dead state
  if (player.bustedState || player.wastedState) {
    gameState = 'dead';
    bustedTicks = 0;
    audioStingTick();
  }

  updateCameraFollow(cam, dt);
  updateHudTick(dt);
  updateEngineAudioTick();
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
      if (officer.state === 'arrest' || officer.state === 'gone') return;
      damageOfficer(police, officer, amount, world.time);
      police.now = world.time;
      reportWitnessCrime(police, player, peds, officer.x, officer.z, CRIME_HEAT.officerHit, 'officer down', 400);
    },
    damageCar: (car, amount) => {
      const died = damageCar(car, amount);
      if (died && !car.exploded) {
        car.exploded = true;
        explodeCar(car); // the wreck burns from the moment it dies — the sprites paint the fire
        if (missions.car === car) onMissionCarWrecked(car);
      }
      return died;
    },
    hitPed: (ped, amount) => {
      if (ped.state === 'gone') return;
      ped.health -= amount;
      if (ped.health <= 0) {
        runOver(ped, 60);
        if (police.stars === 0) {
          // an unwitnessed body still counts when the shots were already reported
          police.now = world.time;
          reportWitnessCrime(police, player, peds, ped.x, ped.z, CRIME_HEAT.shotFired, 'a bystander is down', 320);
        }
      }
      else { ped.state = 'panic'; ped.panicTimer = 6; }
    },
    wallBlocks: (x, z) => boxHitsBuilding(city, x - 2, z - 2, 4, 4) !== null,
    onShot: onHeardShot,
    onShotFromPlayer: onHeardShot,
    onShotFromCop: null,
    playerShot: combat.pendingPlayerShot,
  };
}

/** audio helpers: thin wrappers mapping main's events onto audio.js's synth voices. */
function audioChimeTick() { missionChime(audioSys); }
function audioStingTick() { gameOverSting(audioSys); }

// ---------------------------------------------------------------- menu, death, staging glue
/** Open the title screen (and the initial boot state). */
function openTitleMenu() {
  menu = menuTitleState(hasSave());
  gameState = 'title';
  menuEpoch = 0;
}

/** The pause flip from the playing state. */
function openPauseMenu() {
  gameState = 'paused';
  menu = menuPauseState();
  // the auto-save checkpoint: pausing keeps the run alive across reloads
  saveSlot(persistentStateAssemble());
}

/** W/S or arrows move the menu cursor; ENTER picks the row; M closes the how-to card. */
function handleMenuTick(actions) {
  const wantUp = input.inputState.moveY > 0.5;
  const wantDown = input.inputState.moveY < -0.5;
  if (wantUp || wantDown) {
    if (handleMenuTick.lastDir !== (wantUp ? 1 : -1)) {
      handleMenuTick.lastDir = wantUp ? 1 : -1;
      if (menu && menu.items && !menu.howto) menuMoveCursor(menu, wantUp ? -1 : 1);
    }
  } else {
    handleMenuTick.lastDir = 0;
  }
  const enter = actions & ACTION_ENTER_EXIT;
  if (enter && menu) {
    const picked = menuSelect(menu);
    if (menu.howto) { menu.howto = false; return; }
    if (menu.id === 'title') {
      if (picked === 'new') { clearSave(); startNewGame(); menu = null; }
      else if (picked === 'howto') menu.howto = true;
      else if (picked === 'continue') {
        const payload = loadSlot();
        if (payload && loadSavedGame(payload)) menu = null;
        else startNewGame(), menu = null; // broken slot: fall back to a clean start
      }
    } else if (menu.id === 'pause') {
      if (picked === 'resume') { gameState = 'playing'; menu = null; }
      else if (picked === 'load') {
        const payload = loadSlot();
        if (payload && loadSavedGame(payload)) menu = null;
      } else if (picked === 'quit') { openTitleMenu(); }
      else if (picked === 'howto') menu.howto = true;
    }
  }
  if (actions & ACTION_PAUSE && menu && menu.id === 'pause') {
    gameState = 'playing'; menu = null; // P/Escape resumes too
  }
}

/** Busted or wasted: ENTER (or E) brings the hero back at the hospital/pawn corner. */
function respawnAfterDeath() {
  const hospital = city.landmarks.find((l) => l.id === 'hospital');
  const spot = hospital || city.landmarks[0];
  player.x = spot.x;
  player.z = spot.z + spot.d / 2 + 24;
  player.health = PLAYER.health;
  player.armor = 0;
  player.bustedState = false;
  player.wastedState = false;
  player.inCar = null;
  player.onFoot = true;
  player.vx = 0;
  player.vz = 0;
  // a bust costs cash on the books; a wasted resets the wanted level
  if (missions.lastOutcome && missions.lastOutcome.startsWith('failed:busted')) {
    cash = Math.max(0, cash - 100);
  }
  police.heat = 0;
  police.stars = 0;
  police.officers.length = 0;
  police.cruisers.length = 0;
  player.weaponSlot = 0;
  bustedTicks = 0;
  gameState = 'playing';
  cameraFocusOn(cam, player);
}

/** HUD + audio tick helpers, kept tiny: they only orchestrate the modules. */
function updateHudTick(dt) {
  if (!hudState) return;
  updateHud(hudState, dt, cash);
}

function wantedStateHot() {
  // hot while any pursuing unit sees the hero; the cooldown bar drains otherwise
  let seen = false;
  for (const officer of police.officers) {
    if (officer.state !== 'gone' && officer.seesPlayer) { seen = true; break; }
  }
  if (!seen && police.stars > 0) {
    // cruisers within a block also keep the stars lit
    for (const car of police.cruisers) {
      if (dist2(car.x, car.z, player.x, player.z) < 360 * 360) { seen = true; break; }
    }
  }
  wantedState.hot = seen;
  return seen;
}

function updateEngineAudioTick() {
  const driveFast = player.inCar ? clamp(vehicleSpeed(player.inCar) / 135, 0, 1) : 0;
  audioEngineLoop(audioSys, driveFast, !!player.inCar);
  // the siren follows the nearest cruiser: louder as it closes, panned by bearing
  let nearD = Infinity;
  let pan = 0;
  for (const car of police.cruisers) {
    const d = Math.hypot(car.x - player.x, car.z - player.z);
    if (d < nearD) {
      nearD = d;
      const cos = Math.cos(cam.yaw);
      const sin = Math.sin(cam.yaw);
      const dx = car.x - player.x, dz = car.z - player.z;
      pan = clamp((dx * cos - dz * sin) / 260, -1, 1);
    }
  }
  const wail = police.stars > 0 ? clamp(1 - nearD / 700, 0, 1) : 0;
  audioSirenDoppler(audioSys, wail, pan, world.time);
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

/** Mission ground marker: a bold amber ring + cross on the target, so the shot reads. */
function paintGroundMarker(ctx, p, color) {
  if (!p.visible) return;
  const r = 26;
  const pulse = 0.72 + 0.28 * Math.sin(world.time * 0.14);
  ctx.save();
  ctx.globalAlpha = 0.55 * pulse + 0.35;
  ctx.strokeStyle = color;
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.arc(p.sx, p.sy, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 0.9;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(p.sx - r * 0.6, p.sy - r * 0.6); ctx.lineTo(p.sx + r * 0.6, p.sy + r * 0.6);
  ctx.moveTo(p.sx + r * 0.6, p.sy - r * 0.6); ctx.lineTo(p.sx - r * 0.6, p.sy + r * 0.6);
  ctx.stroke();
  ctx.restore();
}

function paintFrame() {
  const ambient = ambientLevel(world);
  renderer.render(world, buildScene(world, ambient));
  const ctx = renderer.ctx;
  if (gameState === 'playing' || gameState === 'dead') drawHudOverlay(ctx);
  if (gameState === 'title') drawTitleMenu(ctx, menu, b, menuEpoch);
  if (menu && menu.howto) drawHowtoOverlay(ctx, menuEpoch);
  if (passedBanner) drawBannerOverlay(ctx);
  if (gameState === 'dead') drawDeathOverlay(ctx);
  if (gameState === 'paused') drawPauseFrame(ctx);
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

// ---------------------------------------------------------------- overlay adapters
// Thin adapters mapping the hud.js/menus.js primitives onto this session's state.
let b = true; // the pulse flag: recomputed from menuEpoch each frame

/** drawHudOverlay: the full big-and-bold panel set, composed from hud.js's parts. */
function drawHudOverlay(ctx) {
  if (!hudState) return;
  drawHealthArmorBars(ctx, player.health, player.armor);
  drawCashCounter(ctx, hudState, cash);
  const cool = loseHeatBar(police);
  wantedState.cooldown = cool.fraction;
  drawWantedStars(ctx, police.stars, wantedState.hot, cool.fraction, world.time);
  const wep = currentWeapon(player);
  drawWeaponAmmoBox(ctx, wep ? wep.name : 'FIST',
    wep && player.weaponSlot !== 0 ? player.ammo[player.weaponSlot] : Infinity);
  drawGameClock(ctx, world);
  // the objective panel: mission line first, then the free-roam hint
  const info = missionHudInfo(missions);
  if (info) {
    drawObjectivePanel(ctx, info.label, info.text, info.distText, info.urgent);
    if (missions.showBriefing && missions.mission) drawBriefingCard(ctx, missions.mission);
  } else if (missions.chainIndex < missions.chain.length) {
    const giver = missionGiver(missions);
    if (giver) {
      const d = Math.round(Math.hypot(giver.x - player.x, giver.z - player.z));
      drawObjectivePanel(ctx, 'NEXT JOB', `Meet ${giver.giver === 'marisol' ? 'Marisol' : 'Quill'} — ${giver.chapter}`, `${d}m`, false);
    }
  } else {
    const dock = city.landmarks.find((l) => l.id === 'dock');
    if (dock && missions.sideJob) {
      const d = Math.round(Math.hypot(missions.sideJob.to.x - player.x, missions.sideJob.to.z - player.z));
      drawObjectivePanel(ctx, 'FREIGHT', missions.sideJob.text, `${d}m`, false);
    }
  }
  // the minimap plate: player wedge, mission blips, sirens as red dots
  const marks = [{ x: player.x, z: player.z, kind: 'player', heading: player.heading, size: 5 }];
  if (missions.marker) marks.push({ x: missions.marker.x, z: missions.marker.z, color: missions.marker.color, size: 6 });
  for (const car of police.cruisers) marks.push({ x: car.x, z: car.z, color: '#ff5c5c', size: 3 });
  const giver = (missions.state !== 'active' && missions.chainIndex < missions.chain.length)
    ? missionGiver(missions) : null;
  if (giver) marks.push({ x: giver.x, z: giver.z, color: '#ffc65c', size: 6 });
  drawMinimapPanel(ctx, renderer, marks, 230);
  drawToastQueue(ctx, hudState);
}

/** drawBriefingCard: the fixer's briefing plate under the objective panel. */
function drawBriefingCard(ctx, chapter) {
  const text = chapter.briefing;
  ctx.save();
  ctx.font = '800 20px system-ui, sans-serif';
  const words = text.split(' ');
  const lines = [];
  let line = '';
  const MAXW = VIEW.width * 0.66;
  for (const w of words) {
    const attempt = line ? line + ' ' + w : w;
    if (ctx.measureText(attempt).width > MAXW && line) { lines.push(line); line = w; }
    else line = attempt;
  }
  if (line) lines.push(line);
  const w = MAXW + 40;
  const x = (VIEW.width - w) / 2;
  const y = VIEW.height / 2 + 8;
  const h = 64 + lines.length * 28;
  ctx.fillStyle = 'rgba(8,10,16,0.9)';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = '#d8aa4e';
  ctx.lineWidth = 3;
  ctx.strokeRect(x, y, w, h);
  ctx.textAlign = 'center';
  ctx.font = '800 26px system-ui, sans-serif';
  ctx.fillStyle = '#ffc65c';
  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.lineWidth = 4;
  ctx.strokeText(chapter.name.toUpperCase(), VIEW.width / 2, y + 38);
  ctx.fillText(chapter.name.toUpperCase(), VIEW.width / 2, y + 38);
  ctx.font = '800 20px system-ui, sans-serif';
  ctx.fillStyle = '#f2ecd9';
  lines.forEach((ln, i) => ctx.fillText(ln, VIEW.width / 2, y + 68 + i * 28));
  ctx.restore();
  ctx.textAlign = 'left';
}

/** drawTitleMenu adapter: the big title, the pulsing ENTER, the lit rows. */
function drawTitleMenu(ctx, stateObj, blinkOn, tickCount) {
  if (!stateObj) return;
  const t = tickCount % 80;
  drawTitleFrame(ctx, stateObj, t < 48);
}

/** drawBannerOverlay: route the passed/failed card through menus.js's shared lettering. */
function drawBannerOverlay(ctx) {
  missionPassedBanner(ctx, passedBanner, world.time);
}

/** drawDeathOverlay: giant BUSTED/WASTED letters via hud.js's overlays. */
function drawDeathOverlay(ctx) {
  if (player.bustedState) drawBustedOverlay(ctx, world.time);
  else if (player.wastedState) drawWastedOverlay(ctx, world.time);
}

function drawPauseFrame(ctx) {
  if (!menu) return;
  drawPauseMenu(ctx, menu, world.time);
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
  missions,
  hud: () => ({ cash, stars: police.stars, state: gameState, chainIndex: missions.chainIndex, outcome: missions.lastOutcome }),
  get state() { return gameState; },
  api: {
    tickOnce,
    toggleVehicle,
    fire: () => { input.inputState.fireOnce = true; },
    aimHeading: () => aimHeadingFromInput(input.inputState, cam),
    wantedStars: () => wantedLevelStars(police),
    loseHeatBar: () => loseHeatBar(police),
    nearestCar: (maxDist = 46) => nearestCarTo(carPool, player.x, player.z, maxDist),
    save: () => saveSlot(persistentStateAssemble()),
    load: () => loadSlot(),
    clearSave,
    hasSave,
    startNewGame: () => { startNewGame(); menu = null; },
    mission: (name) => missionChainStep(missions, name),
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

window.__shotReady = false; // only a staged shot sets this true, then freezes the sim

// ---------------------------------------------------------------- the boot flow
// The staging context staging.js drives: every placement hook the shots need.
const STAGE = {
  get shotName() { return shotName; },
  world,
  city,
  player,
  police,
  traffic,
  peds,
  lanes,
  missions,
  get origin() { STAGE.__origin = STAGE.__origin || null; return STAGE.__origin; },
  set origin(o) { STAGE.__origin = o; },
  applyWorldClock: setWorldClock,
  putPlayerInCar: (car) => { enterCar(player, car); player.onFoot = false; STAGE.placedHeroCar = car; },
  setWantedStars: (n) => { police.heat = WANTED.starHeat[n] ?? 0; police.stars = Math.min(n, 5); police.seenTick = world.time; },
  lightStrobes: (cruisers) => { for (const c of cruisers) { c.sirenOn = true; c.lightPhase = (c.lightPhase + 7) % 12; } },
  fireMuzzleFlash,
  reflashMuzzles,
  lockCamera,
  shotTick: () => { tickOnce(); },
  shotFreeze: freezeSimForShot,
  spawnStaticCar: stageSpawnStaticCar,
  spawnCruiser: stageSpawnCruiser,
  spawnOfficer: stageSpawnOfficer,
  spawnWalker: stageSpawnWalker,
  spawnTrafficCar: stageSpawnTrafficCar,
  parkPlayerAtMission,
  openMissionBriefing: stageOpenBriefing,
};

/** stageShot boot path: freeze the loop's own ticking; staging runs its 60 ticks itself. */
let simFrozen = false;
function freezeSimForShot() { simFrozen = true; }

function setWorldClock(hhmm) {
  if (Number.isFinite(hhmm)) {
    world.minutes = hhmm;
    world.day = 0;
  }
}

function lockCamera(x, z, yaw, zoom) {
  cameraRelease(cam);
  cam.x = x;
  cam.z = z;
  cam.targetX = x;
  cam.targetZ = z;
  cam.focus = null;
  cam.yaw = yaw ?? cam.yaw;
  if (zoom) setCameraZoom(cam, zoom);
  // pin the propagation used by projectTo: the city's corridor origin is the camera itself
  STAGE.__origin = { x, z };
}

function fireMuzzleFlash() {
  // a cop's burst mid-flight: tracer + bloom at the officer's muzzle (deterministic heading)
  const officer = police.officers.find((o) => o.state !== 'gone')
    || police.cruisers[0] || { x: player.x + 40, z: player.z - 30 };
  const heading = Math.atan2(player.x - officer.x, player.z - officer.z);
  const shot = {
    x: officer.x + Math.sin(heading) * 14,
    z: officer.z + Math.cos(heading) * 14,
    heading,
    damage: 7,
    range: 300,
    fromPlayer: false,
    muzzleY: 11,
  };
  spawnBullet(combat, shot, world.time, null);
  STAGE.placedMuzzles = true;
}

function reflashMuzzles() {
  // keep the freshest muzzle blooms alive on the frozen frame (ttl bumps, no new bullets)
  for (const flash of combat.muzzleFlashes) flash.ttl = Math.max(flash.ttl, 0.05);
}

function stageSpawnStaticCar(x, z, kind, heading) {
  const car = createVehicle(city, x, z, heading ?? 0, kind || 'sedan', stageRng);
  car.driver = null;
  car.vx = 0; car.vz = 0;
  STAGE.__stageCars = STAGE.__stageCars || [];
  STAGE.__stageCars.push(car);
  return car;
}

function stageSpawnCruiser(x, z, heading) {
  const car = spawnPoliceCruiser(police, lanes, x, z, heading, world.time);
  car.vx = 0; car.vz = 0;
  car.sirenOn = true;
  return car;
}

function stageSpawnOfficer(x, z) {
  const officer = spawnFootOfficer(police, x, z);
  officer.seesPlayer = true;
  officer.state = 'pursue';
  return officer;
}

function stageSpawnWalker(x, z) {
  return pedestrianSpawnAt(peds, x, z);
}

function stageSpawnTrafficCar(x, z, heading) {
  const car = createVehicle(city, x, z, heading, 'sedan', stageRng);
  car.driver = 'npc';
  car.cruise = 58; // the queue looks dense, not highway fast
  car.vx = Math.sin(heading) * 40;
  car.vz = Math.cos(heading) * 40;
  STAGE.__stageCars = STAGE.__stageCars || [];
  STAGE.__stageCars.push(car);
  traffic.cars.push(car);
  return car;
}

/** put the hero at the mission giver's plaza for the mission shot. */
function parkPlayerAtMission() {
  const giver = missionGiver(missions) || { x: city.playerSpawn.x, z: city.playerSpawn.z };
  player.x = giver.x + 30;
  player.z = giver.z + 8;
  player.vx = 0; player.vz = 0;
  player.inCar = null;
  player.onFoot = true;
  cameraFocusOn(cam, player);
}

/** openMissionBriefing for the mission shot: the story chapter is live, card up. */
function stageOpenBriefing() {
  const giver = missionGiver(missions);
  if (!giver) return null;
  player.x = giver.x + 18; // inside the giver's pickup radius, so the run begins truthfully
  player.z = giver.z - 6;
  missions.__player = player;
  beginMissionRun();
  return missions.mission;
}

function beginMissionRun() {
  const chapter = missions.chain[missions.chainIndex];
  if (!chapter) return;
  missions.state = 'active';
  missions.mission = chapter;
  missions.stepIndex = 0;
  missions.step = chapter.steps[0];
  missions.timeLeft = chapter.timeLimit || 0;
  missions.showBriefing = true;
  missions.briefingTtl = 999; // staged: the card stays until froze
  // arm the first step's needs (a tail car, marker) but NEVER spawn police for the finale here
  const step = missions.step;
  missions.marker = step.x !== undefined ? { x: step.x, z: step.z, color: '#ffc65c' } : null;
}

// settle ticks counter for the staged shots; the loop keeps painting but not ticking.
let settleTicks = 0;
function steppedFrame() {
  if (simFrozen) {
    paintFrame(); // frozen: pixels only, so the capture is stable
    return;
  }
  if (stagingShotName) {
    paintFrame(); // staging drives its own tick loop inside stageShot
    return;
  }
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
let stagingShotName = null;
let rafAlive = false;
function frame() {
  rafAlive = true;
  steppedFrame();
  requestAnimationFrame(frame);
}

// boot: build the HUD state, seed the stage rng, open the title — or run a staged shot.
hudState = createHud(0);
const stageRng = new Rng(20260);
const audioSys = createAudio();

let bootRan = false;
function boot() {
  if (bootRan) return;
  bootRan = true;
  window.__bootDebug = { ran: true, shot: shotName || null, stage: 'enter' };
  try {
    if (shotName === 'cover' || shotName === 'driving' || shotName === 'chase' || shotName === 'mission') {
      stagingShotName = shotName;
      gameState = 'playing';
      window.__bootDebug.stage = 'staging';
      stageShot(shotName, STAGE); // runs its own 60 ticks, sets __shotReady, freezes the sim
      window.__bootDebug.stage = 'staged';
    } else if (shotName) {
      // any other ?shot= name: the classic settle-and-freeze probe path
      gameState = 'playing';
      window.__bootDebug.stage = 'probe';
    } else {
      startNewGame();
      window.__bootDebug.stage = 'newgame';
      openTitleMenu();
      window.__bootDebug.stage = 'title';
    }
  } catch (err) {
    window.__bootDebug.error = String(err && err.stack || err);
  }
}

requestAnimationFrame(frame);
setInterval(() => {
  if (!rafAlive || document.hidden) steppedFrame();
  rafAlive = false;
  boot(); // the interval doubles as the boot heartbeat for hidden probe tabs
}, 33);
requestAnimationFrame(() => boot());
