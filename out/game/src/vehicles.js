// vehicles.js — everything with four wheels in Calvera Bay: the carCarry physics model
// (throttle/brake/steer with speed-scaled grip so fast corners drift), wall collisions against
// the city's AABBs (slide plus crash damage), the four body kinds with distinct palettes,
// enterCar/exitCar (the player warps to the door position like every GTA before it), health
// and explodeCar with a seeded boom effect, plus the police light-bar strobe hooks (sirenOn +
// lightPhase) that the renderer flashes red/blue every six ticks.
import { CAR, PALETTE } from './config.js';
import { boxHitsBuilding } from './city.js';
import { clamp, lerp, Rng, angleDelta, wrapAngle, dist2, moveToward } from './util.js';

// ---------------------------------------------------------------- body kinds & palettes
const KIND_SPECS = {
  sedan:      { name: 'Sedan',      body: ['#b23b3b', '#3b62b2', '#c8c8cf', '#2f7a4f', '#8a6ec8', '#caa23b'], roof: '#242830', trim: '#d8d8de', speed: 1.00, mass: 1.0 },
  pickup:     { name: 'Pickup',     body: ['#7a4a2b', '#4a6a52', '#80858e', '#a8442b'],                     roof: '#3a3f47', trim: '#c8c3b2', speed: 0.92, mass: 1.2, bed: true },
  van:        { name: 'Van',        body: ['#d8d5cb', '#7d8592', '#c1a26a', '#6f7b84'],                      roof: '#e4e1d8', trim: '#8b909b', speed: 0.84, mass: 1.5, tall: true },
  sedan_police:{ name: 'Cruiser',   body: ['#e8e9ec'], roof: '#22262e', trim: '#2f5fa8', speed: 1.08, mass: 1.1, police: true, lightbar: true },
};

let nextVehicleId = 1;

/** Build a car at x,z facing heading (radians; 0 = +z). kind is a KIND_SPECS key. */
export function createVehicle(city, x, z, heading, kind, rng) {
  const r = rng || new Rng(1337);
  const spec = KIND_SPECS[kind] ?? KIND_SPECS.sedan;
  const body = spec.body[(r.next() * spec.body.length) | 0];
  return {
    id: nextVehicleId++,
    kind, spec,
    x, z, y: 0,
    heading: wrapAngle(heading),
    vx: 0, vz: 0,
    steer: 0,
    throttle: 0, brakeInput: 0, handbrake: false,
    w: CAR.width, l: CAR.length, h: spec.tall ? CAR.height * 1.5 : CAR.height,
    body, roof: spec.roof, trim: spec.trim,
    health: 100, smoke: 0,
    sirenOn: false, lightPhase: 0, horn: 0,
    driver: null, // 'player' | 'npc' | 'cop' | null (parked)
    dead: false, burn: 0, // burn = seconds since explodeCar, for the boom effect
    radius: Math.max(CAR.width, CAR.length) * 0.5,
    lastImpact: 0,
  };
}

// ---------------------------------------------------------------- the carCarry physics step
/**
 * One tick of car physics: controls { throttle -1..1, steer -1..1, handbrake bool }.
 * Forward velocity accrues by CAR.accel, lateral velocity decays by grip (weakened at speed
 * and slashed by the handbrake, which is exactly the drift lever), the heading swings by steer
 * scaled down at high speed, then the world pushes back through collideCarWalls.
 */
export function updateVehicle(car, city, controls, dt) {
  const f = { x: Math.sin(car.heading), z: Math.cos(car.heading) };
  const r = { x: f.z, z: -f.x };
  let vf = car.vx * f.x + car.vz * f.z; // forward speed
  let vl = car.vx * r.x + car.vz * r.z; // lateral slip

  const topSpeed = CAR.maxSpeed * (car.spec.speed ?? 1);
  if (controls.throttle > 0) {
    vf += CAR.accel * (car.spec.mass ? 1 / car.spec.mass : 1) * controls.throttle * dt * (1 - 0.55 * Math.max(0, vf / topSpeed));
  } else if (controls.throttle < 0) {
    if (vf > 4) vf -= CAR.brake * dt; // braking while rolling forward
    else vf = Math.max(vf - CAR.reverseAccel * dt, -CAR.maxReverse);
  }
  if (controls.handbrake) vf = moveToward(vf, 0, CAR.brake * 0.45 * dt); // handbrake drags the wheels
  vf = clamp(vf, -CAR.maxReverse, topSpeed);

  // grip: lateral slip survives more at speed (drift) and far more under the handbrake
  const speedFrac = Math.abs(vf) / topSpeed;
  const driftWeaken = 1 + speedFrac * speedFrac * 1.6;
  let grip = controls.handbrake ? CAR.handbrakeGrip : CAR.grip;
  grip = Math.pow(grip, (dt * 60) / driftWeaken);
  vl *= grip;

  // steering: lock eases off as speed rises, reversed when rolling backwards
  const steerEff = CAR.steer / (1 + Math.abs(vf) / 90);
  car.steer = moveToward(car.steer, controls.steer, 8 * dt);
  const dirSign = vf < -2 ? -1 : 1;
  car.heading = wrapAngle(car.heading + car.steer * steerEff * dirSign * dt * clamp(Math.abs(vf) / 14, 0, 1));

  // recompose after the heading turned, so the car carries its slip through the turn
  car.vx = f.x * vf + r.x * vl;
  car.vz = f.z * vf + r.z * vl;
  const nx = car.x + car.vx * dt;
  const nz = car.z + car.vz * dt;
  collideCarWalls(car, city, nx, nz, dt);
  tickVehicleCommon(car, dt);
  return car;
}

/** Health smoke, siren strobe phase, burn timer — shared by driven and parked cars alike. */
export function tickVehicleCommon(car, dt) {
  car.smoke = car.health < 35 ? (35 - car.health) / 35 : 0;
  if (car.sirenOn && car.spec.lightbar) car.lightPhase = (car.lightPhase + 1) % 12;
  if (car.burn > 0) car.burn += dt;
}

/**
 * Wall collision: try the full move; if a building blocks it, try axis by axis so the car
 * SLIDES along the wall instead of sticking, and take damage proportional to the impact speed.
 */
export function collideCarWalls(car, city, nx, nz, dt) {
  const half = Math.max(car.w * 0.5 + 4, car.l * 0.36);
  const startSpeed = Math.hypot(car.vx, car.vz);
  const free = !city || !boxHitsCity(city, nx - half, nz - half, half * 2, half * 2);
  if (free) { car.x = nx; car.z = nz; return; }
  // axis-separated slide
  if (!boxHitsCity(city, nx - half, car.z - half, half * 2, half * 2)) {
    car.x = nx;
    car.vz *= -0.18; car.vx *= 0.55;
    crashDamage(car, Math.abs(car.vx), startSpeed);
  } else if (!boxHitsCity(city, car.x - half, nz - half, half * 2, half * 2)) {
    car.z = nz;
    car.vx *= -0.18; car.vz *= 0.55;
    crashDamage(car, Math.abs(car.vz), startSpeed);
  } else {
    car.vx *= -0.25; car.vz *= -0.25;
    crashDamage(car, startSpeed, startSpeed);
  }
}

function boxHitsCity(city, x, z, w, d) {
  return boxHitsBuilding(city, x, z, w, d);
}

function crashDamage(car, impactSpeed, speedAtStart) {
  const hitSpeed = Math.max(impactSpeed, speedAtStart * 0.6) - 26;
  if (hitSpeed > 0) {
    car.lastImpact = hitSpeed;
    damageCar(car, hitSpeed * 0.09);
  }
}

/** Damage a car; at zero health it goes up in flame via explodeCar. Returns true if it died. */
export function damageCar(car, amount) {
  if (car.dead) return false;
  car.health -= amount;
  if (car.health <= 0) { explodeCar(car); return true; }
  return false;
}

/** The boom: flag the wreck, clear the driver, seed the fireball effect the renderer draws. */
export function explodeCar(car) {
  if (car.dead) return;
  car.dead = true;
  car.health = 0;
  car.burn = 0.001;
  car.driver = null;
  car.sirenOn = false;
  car.body = shadeCarToWreck(car.body);
}

function shadeCarToWreck(hex) {
  // a plain charred tone; keep it local so util imports stay one-way
  return '#31302c';
}

// ---------------------------------------------------------------- enter / exit (the door warp)
/** The driver-door position beside the car (left side, a metre out). */
export function doorPosition(car) {
  const f = { x: Math.sin(car.heading), z: Math.cos(car.heading) };
  const left = { x: -f.z, z: f.x };
  const off = car.w * 0.5 + 6;
  return { x: car.x + left.x * off, z: car.z + left.z * off };
}

/** Put the player behind the wheel. Caller checks proximity and handles witness reporting. */
export function enterCar(player, car) {
  player.inCar = car;
  car.driver = 'player';
  car.sirenOn = false;
  player.x = car.x; player.z = car.z;
  return true;
}

/** Step out at the door; refuses to drop the player inside a building, then tries one tile back. */
export function exitCar(player, city, tryLanding) {
  const car = player.inCar;
  if (!car) return false;
  const door = doorPosition(car);
  let landing = { x: door.x, z: door.z };
  if (city && tryLanding && tryLanding(door.x, door.z)) {
    const f = { x: Math.sin(car.heading), z: Math.cos(car.heading) };
    landing = { x: car.x - f.x * (car.l * 0.5 + 12), z: car.z - f.z * (car.l * 0.5 + 12) };
  }
  player.x = landing.x; player.z = landing.z;
  player.vx = 0; player.vz = 0;
  player.inCar = null;
  car.driver = null;
  car.throttle = 0; car.brakeInput = 1;
  return true;
}

/** Speed along the heading, unsigned — used by runOver tests and the arrest check. */
export function vehicleSpeed(car) {
  return Math.hypot(car.vx, car.vz);
}

/**
 * A gentle car-vs-car separation so gridlocked streets never interpenetrate: push both boxes
 * apart along the smaller overlap axis, damped so nudges do not launch anyone.
 */
export function separateVehicles(a, b) {
  const dx = b.x - a.x, dz = b.z - a.z;
  const dist = Math.hypot(dx, dz) || 0.001;
  const minDist = (a.l + b.l) * 0.36;
  if (dist > minDist) return false;
  const push = (minDist - dist) * 0.5;
  const ux = dx / dist, uz = dz / dist;
  a.x -= ux * push * 0.6; a.z -= uz * push * 0.6;
  b.x += ux * push * 0.6; b.z += uz * push * 0.6;
  return true;
}

export { KIND_SPECS };
