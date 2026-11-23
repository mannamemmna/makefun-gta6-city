// player.js — the protagonist of Calvera Bay. createPlayer drops them downtown on foot with
// the full on-foot kit: walk, run and a sprint that burns stamina, damagePlayer routed through
// armor first, the weapon carousel (fist, pistol, SMG — ammo lives per slot), a shootCooldown
// between trigger pulls, the in-car state bridge to vehicles.js (enter/exit warps through the
// door position; while driving the same WASD hands become throttle and steer), and the
// bustedState / wastedState flags the police and the game-over flow read. updatePlayer is one
// fixed tick: read the input state, integrate, collide against the city's walls.
import { PLAYER, CAR, WEAPONS, STEP } from './config.js';
import { clamp, lerp, moveToward, wrapAngle, dist2, angleDelta } from './util.js';
import { boxHitsBuilding } from './city.js';

/** The weapon slots: index 0 is the bare fist, then the config table's entries by id. */
const FIST = { id: 'fist', name: 'Fist', damage: 8, range: 20, cooldown: 0.35 };
export function weaponSlots() {
  const pistol = WEAPONS.find((w) => w.id === 'pistol') ?? WEAPONS[0];
  const smg = WEAPONS.find((w) => w.id === 'smg') ?? WEAPONS[1];
  const slots = [FIST, pistol, smg];
  return slots;
}

/**
 * The player actor. spawnX/spawnZ come from city.playerSpawn (downtown, session 1).
 */
export function createPlayer(spawnX, spawnZ) {
  const p = {
    x: spawnX, z: spawnZ, y: 0,
    vx: 0, vz: 0,
    heading: 0,
    health: PLAYER.health,
    armor: 0,
    maxHealth: PLAYER.health,
    stamina: 100,
    sprinting: false,
    speed: 0, // signed ground speed, for the arrest check and the HUD
    radius: PLAYER.radius,
    onFoot: true,
    inCar: null, // the vehicles.js car while driving
    weaponSlot: 0, // 0 fist, 1 pistol, 2 smg
    weapons: weaponSlots(),
    ammo: [Infinity, WEAPONS.find((w) => w.id === 'pistol').ammo, WEAPONS.find((w) => w.id === 'smg').ammo],
    shootCooldown: 0, // seconds until the next shot may fire
    aim: false, aimHeading: 0,
    bob: 0,
    bustedState: false, // arrested: control frozen, camera stays
    wastedState: false, // dead: ditto; session 5 shows the wasted screen
    lastShotTick: -999,
    hurtFlash: 0,
  };
  return p;
}

/** The weapon currently held, as its slot spec. */
export function currentWeapon(player) {
  return player.weapons[player.weaponSlot];
}

/** Cycle the weapon carousel, skipping empty guns. Returns the new slot. */
export function cycleWeapon(player, dir = 1) {
  for (let i = 1; i <= player.weapons.length; i += 1) {
    const slot = (player.weaponSlot + dir * i + player.weapons.length * 2) % player.weapons.length;
    if (slot === 0 || player.ammo[slot] > 0) { player.weaponSlot = slot; return slot; }
  }
  player.weaponSlot = 0;
  return 0;
}

/**
 * Hurting the hero: armor eats two thirds of the incoming damage until it breaks; the rest
 * comes off health. Reaching zero sets wastedState (the wasted flow is session 5's to render).
 */
export function damagePlayer(player, amount) {
  if (player.bustedState || player.wastedState) return;
  const absorbed = Math.min(player.armor, amount * 0.66);
  player.armor -= absorbed;
  player.health -= amount - absorbed;
  player.hurtFlash = 1;
  if (player.health <= 0) {
    player.health = 0;
    wastedPlayer(player);
  }
}

/** Busted: the arrest lands, control is gone, the cruiser drives off with the hero. */
export function bustedPlayer(player) {
  player.bustedState = true;
}

/** Wasted: health hit zero. Meanwhile the actor simply lies still. */
export function wastedPlayer(player) {
  player.wastedState = true;
  player.health = 0;
  if (player.inCar) player.inCar.driver = null;
  player.inCar = null;
}

/** Grant armor (a later session's pickups call this). */
export function giveArmor(player, amount) {
  player.armor = Math.min(100, player.armor + amount);
}

/**
 * One fixed tick of the hero on foot: sprint stamina, acceleration and friction on the
 * WALK/SPRINt plan, turning toward the aim or the movement, and collision with the walls.
 */
export function updatePlayerOnFoot(player, city, input, dt) {
  const frozen = player.bustedState || player.wastedState;
  const ax = frozen ? 0 : input.moveX;
  const az = frozen ? 0 : input.moveY;
  const wants = Math.hypot(ax, az);
  player.sprinting = !frozen && input.sprint && wants > 0 && player.stamina > 1;
  if (player.sprinting) player.stamina = Math.max(0, player.stamina - 26 * dt);
  else player.stamina = Math.min(100, player.stamina + 16 * dt);

  const target = player.sprinting ? PLAYER.runSpeed : PLAYER.walkSpeed;
  if (wants > 0) {
    const moveHeading = Math.atan2(ax, az);
    player.vx += Math.sin(moveHeading) * PLAYER.accel * dt;
    player.vz += Math.cos(moveHeading) * PLAYER.accel * dt;
    if (!player.aim) player.heading = wrapAngle(player.heading + clamp(angleDelta(player.heading, moveHeading), -9 * dt, 9 * dt));
  }
  if (player.aim) player.heading = player.aimHeading;

  // friction toward the target speed, then coasting decay when the stick is neutral
  const speed = Math.hypot(player.vx, player.vz);
  if (speed > 0.001) {
    const cap = wants > 0 ? target : speed;
    const decayed = Math.max(speed - PLAYER.friction * (wants > 0 ? 1.4 : 22) * dt, 0);
    const nextSpeed = Math.min(cap, decayed);
    const k = nextSpeed / speed;
    player.vx *= k;
    player.vz *= k;
  }
  collidePlayerWalls(player, city, player.x + player.vx * dt, player.z + player.vz * dt);
  player.speed = Math.hypot(player.vx, player.vz);
  player.bob = (player.bob + player.speed * dt) | 0;
  if (player.shootCooldown > 0) player.shootCooldown -= dt;
  if (player.hurtFlash > 0) player.hurtFlash -= dt * 1.4;
}

/** Slide the hero along walls exactly like the cars do: axis-separated collision response. */
function collidePlayerWalls(player, city, nx, nz) {
  const r = PLAYER.radius;
  if (!boxHitsBuilding(city, nx - r, nz - r, r * 2, r * 2)) { player.x = nx; player.z = nz; return; }
  if (!boxHitsBuilding(city, nx - r, player.z - r, r * 2, r * 2)) {
    player.x = nx; player.vz = 0;
  } else if (!boxHitsBuilding(city, player.x - r, nz - r, r * 2, r * 2)) {
    player.z = nz; player.vx = 0;
  } else {
    player.vx *= -0.1; player.vz *= -0.1;
  }
}

// ---------------------------------------------------------------- the bridge into vehicles.js
/** Build the controls a driven car sees from the same WASD state the walker uses. */
export function drivingControls(player, input) {
  return {
    throttle: input.moveY,
    steer: -input.moveX, // A/D steer; heading math puts left where the A key turns it
    handbrake: input.brake,
  };
}

/** One fixed tick while driving: physics lives in vehicles.js; here the hero just rides along. */
export function updatePlayerDriving(player, city, input, dt) {
  const car = player.inCar;
  if (!car || car.dead) { exitCarStalled(player, city); return; }
  const frozen = player.bustedState || player.wastedState;
  const controls = frozen ? { throttle: 0, steer: 0, handbrake: true } : drivingControls(player, input);
  const { updateVehicle } = player.__vehicleApi;
  updateVehicle(car, city, controls, dt);
  player.x = car.x;
  player.z = car.z;
  player.heading = car.heading;
  player.speed = Math.hypot(car.vx, car.vz);
  if (player.shootCooldown > 0) player.shootCooldown -= dt;
  if (player.hurtFlash > 0) player.hurtFlash -= dt * 1.4;
}

/** Dropped out of a dead car: stand at the wreck's door. */
function exitCarStalled(player, city) {
  const car = player.inCar;
  const { doorPosition } = player.__vehicleApi;
  const door = doorPosition(car);
  player.x = door.x; player.z = door.z;
  player.vx = 0; player.vz = 0;
  player.inCar = null;
  player.onFoot = true;
}

/**
 * The router main.js calls every tick: walk or drive, then the shared cooldown decay.
 * vehicleApi = { updateVehicle, doorPosition, exitCar } wired at boot to avoid an import knot.
 */
export function updatePlayer(player, city, input, dt, vehicleApi) {
  if (vehicleApi) player.__vehicleApi = vehicleApi;
  const step = STEP;
  if (player.inCar) updatePlayerDriving(player, city, input, step);
  else updatePlayerOnFoot(player, city, input, step);
  if (!player.inCar) player.onFoot = true;
}

/** Try to fire the held weapon: returns the shot descriptor (or null on cooldown/empty). */
export function tryFireWeapon(player, aimHeading) {
  const wep = currentWeapon(player);
  if (player.shootCooldown > 0 || player.bustedState || player.wastedState) return null;
  if (player.weaponSlot !== 0 && player.ammo[player.weaponSlot] <= 0) return null;
  player.shootCooldown = wep.cooldown;
  if (player.weaponSlot !== 0) player.ammo[player.weaponSlot] -= 1;
  player.aimHeading = aimHeading;
  return {
    x: player.x + Math.sin(aimHeading) * 14,
    z: player.z + Math.cos(aimHeading) * 14,
    heading: aimHeading,
    damage: wep.damage,
    range: wep.range,
    fromPlayer: true,
  };
}

/** Eye position for a camera that frames the shot from behind the hero's shoulder. */
export function playerEye(player) {
  return { x: player.x, y: (player.inCar ? 12 : PLAYER.eyeHeight) + 4, z: player.z };
}
