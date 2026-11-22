// pedestrians.js — the sidewalk crowd of Calvera Bay. pedestrianSpawn drops walkers onto the
// sidewalk corner spots near the camera (densely: the street should never look empty),
// wanderCornerToCorner walks them between sidewalk corners along the block rings,
// panicRun makes them sprint away from a gunshot or crime with their arms up,
// runOver knocks a struck pedestrian flat with a despawn timer, and the pacify timer lets
// a scared crowd calm back down to a wander when the trouble has passed. All positions and
// choices come from the system's own seeded Rng so the crowd is fully deterministic.
import { TRAFFIC } from './config.js';
import { Rng, clamp, dist2, moveToward, angleDelta, wrapAngle } from './util.js';

const PALETTES = [
  { shirt: '#c94f4f', pants: '#31384a', skin: '#d9a184' },
  { shirt: '#4f7ec9', pants: '#2a2f3a', skin: '#8a5f45' },
  { shirt: '#e0d6b8', pants: '#4a4238', skin: '#e8b48f' },
  { shirt: '#57a05c', pants: '#333a44', skin: '#a06c4c' },
  { shirt: '#b8874f', pants: '#262b30', skin: '#d9a184' },
  { shirt: '#8a6ec8', pants: '#3a3f47', skin: '#e8b48f' },
  { shirt: '#c8c8cf', pants: '#2f3640', skin: '#8a5f45' },
  { shirt: '#d05a8a', pants: '#31384a', skin: '#a06c4c' },
];

let nextPedId = 1;

/** The crowd system: createPedestrians(city) seeds its own stream of walkers. */
export function createPedestrians(city, seed = 777) {
  return { city, rng: new Rng(seed), peds: [], panicUntil: 0, pedSeed: seed };
}

/**
 * Spawn one pedestrian on a sidewalk corner near the focus. Walkers live on the block-ring
 * corners city.js exported as sidewalkSpots; spawn is skipped when the spot is occupied.
 */
export function pedestrianSpawn(peds, focusX, focusZ) {
  const r = peds.rng;
  const spots = peds.city.sidewalkSpots;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const spot = spots[r.int(spots.length)];
    if (dist2(spot.x, spot.z, focusX, focusZ) > TRAFFIC.spawnRadius * TRAFFIC.spawnRadius) continue;
    let occupied = false;
    for (const other of peds.peds) {
      if (dist2(other.x, other.z, spot.x, spot.z) < 26 * 26) { occupied = true; break; }
    }
    if (occupied) continue;
    const look = PALETTES[r.int(PALETTES.length)];
    const ped = {
      id: nextPedId++,
      x: spot.x + r.range(-4, 4), z: spot.z + r.range(-4, 4),
      vx: 0, vz: 0, heading: r.angle(),
      look, bob: r.int(64),
      state: 'walk', // walk | panic | flat | gone
      speed: r.range(11, 16),
      target: null, // the corner being walked toward
      flatTimer: 0, // seconds since knocked flat
      panicTimer: 0, // seconds of panicRun left before pacify
      health: 30,
    };
    pickCornerTarget(peds, ped);
    peds.peds.push(ped);
    return ped;
  }
  return null;
}

/** Top up the crowd around the focus; called every tick, spawns at most a few walkers at a time. */
export function pedestrianSpawnTopUp(peds, focusX, focusZ, max = TRAFFIC.pedestrians) {
  let want = max;
  for (let i = 0; peds.peds.length < want && i < 3; i += 1) {
    if (!pedestrianSpawn(peds, focusX, focusZ)) break;
  }
}

/** Choose the next sidewalk corner to stroll toward — corner-to-corner around the ring. */
function pickCornerTarget(peds, ped) {
  const r = peds.rng;
  const spots = peds.city.sidewalkSpots;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const spot = spots[r.int(spots.length)];
    const d2 = dist2(spot.x, spot.z, ped.x, ped.z);
    if (d2 < 30 * 30 || d2 > 320 * 320) continue;
    ped.target = { x: spot.x, z: spot.z };
    return;
  }
  ped.target = null; // keep strolling the same heading for a while
}

/** pickCornerTarget exported under its walk behaviour name for the outline. */
export { pickCornerTarget as wanderCornerToCorner };

/**
 * Panic the crowd near a trouble point: everyone within panicRadius sprints away from it with
 * their arms up for `duration` seconds, then the pacify timer brings them back to wandering.
 */
export function panicPedsNear(peds, x, z, worldTick, duration = 6, panicRadius = 260) {
  peds.panicUntil = Math.max(peds.panicUntil, worldTick + duration * 60);
  const r2 = panicRadius * panicRadius;
  for (const ped of peds.peds) {
    if (ped.state === 'flat' || ped.state === 'gone') continue;
    if (dist2(ped.x, ped.z, x, z) < r2) {
      ped.state = 'panic';
      ped.panicTimer = duration;
      const away = Math.atan2(ped.z - z, ped.x); // screen-x away from danger: heading is atan2(dz,dx) space here
      ped.heading = away;
      ped.target = null;
    }
  }
}

/**
 * A pedestrian struck by a moving car: knocked flat on the spot, a despawn timer runs out and
 * the body quietly leaves the crowd (the pool spawns a fresh walker elsewhere).
 */
export function runOver(ped, impactSpeed) {
  if (ped.state === 'flat' || ped.state === 'gone') return false;
  if (impactSpeed < 24 && ped.state !== 'panic') {
    // a slow bump: just a shove, the walker is annoyed but keeps going
    ped.state = 'panic';
    ped.panicTimer = 3;
    return false;
  }
  ped.state = 'flat';
  ped.flatTimer = 0;
  ped.vx = 0; ped.vz = 0;
  return true; // knocked flat
}

/** One tick of a single walker: wander, panic, or lie flat, plus the pacify countdown. */
export function updatePedestrian(peds, ped, dt) {
  if (ped.state === 'gone') return;
  if (ped.state === 'flat') {
    ped.flatTimer += dt;
    if (ped.flatTimer > 14) ped.state = 'gone';
    return;
  }
  if (ped.state === 'panic') {
    ped.panicTimer -= dt; // the pacify timer: panic cools off and becomes a walk again
    if (ped.panicTimer <= 0) {
      ped.state = 'walk';
      pickCornerTarget(peds, ped);
    } else {
      // sprint away, arms up (the renderer paints the raised arms when state==='panic')
      const sp = 34;
      ped.vx = Math.sin(ped.heading) * sp;
      ped.vz = Math.cos(ped.heading) * sp;
      stepAndCollide(peds, ped, dt);
      keepOffWaterAndWalls(peds, ped);
      return;
    }
  }
  // wandering: amble toward the target corner, or drift along the heading
  let hx = ped.heading, hz = 0;
  if (ped.target) {
    const dx = ped.target.x - ped.x;
    const dz = ped.target.z - ped.z;
    if (dx * dx + dz * dz < 16 * 16) { pickCornerTarget(peds, ped); }
    else {
      const want = Math.atan2(dx, dz);
      ped.heading = wrapAngle(ped.heading + clamp(angleDelta(ped.heading, want), -2.6 * dt, 2.6 * dt));
    }
  } else if (peds.rng.chance(0.01)) {
    ped.heading = wrapAngle(ped.heading + peds.rng.range(-1.2, 1.2));
  }
  hx = Math.sin(ped.heading); hz = Math.cos(ped.heading);
  ped.vx = hx * ped.speed;
  ped.vz = hz * ped.speed;
  stepAndCollide(peds, ped, dt);
  keepOffWaterAndWalls(peds, ped);
}

function stepAndCollide(peds, ped, dt) {
  ped.x += ped.vx * dt;
  ped.z += ped.vz * dt;
  ped.bob = (ped.bob + 1) & 63;
}

/**
 * Peds never swim and never walk through storefronts: if the step landed somewhere unwalkable,
 * back off and pick a new corner to head for.
 */
function keepOffWaterAndWalls(peds, ped) {
  const walkable = peds.isWalkable && peds.isWalkable(ped.x, ped.z);
  if (walkable) return;
  ped.x -= ped.vx * 0.06;
  ped.z -= ped.vz * 0.06;
  pickCornerTarget(peds, ped);
  ped.heading = wrapAngle(ped.heading + Math.PI / 2);
}

/**
 * The system tick: top up the crowd near the focus, update every walker, recycle the flat and
 * the gone, despawn whoever wandered out of range.
 */
export function updatePedestrians(peds, dt, focusX, focusZ) {
  pedestrianSpawnTopUp(peds, focusX, focusZ);
  const keep = [];
  const despawn2 = TRAFFIC.despawnRadius * TRAFFIC.despawnRadius;
  for (const ped of peds.peds) {
    updatePedestrian(peds, ped, dt);
    const far = dist2(ped.x, ped.z, focusX, focusZ) > despawn2;
    if (ped.state !== 'gone' && !far) keep.push(ped);
  }
  peds.peds = keep;
}

/** How many walkers stand within radius of the focus — the density check for staging. */
export function pedestrianDensity(peds, focusX, focusZ, radius = TRAFFIC.spawnRadius) {
  const r2 = radius * radius;
  let n = 0;
  for (const ped of peds.peds) {
    if (ped.state !== 'flat' && dist2(ped.x, ped.z, focusX, focusZ) < r2) n += 1;
  }
  return n;
}
