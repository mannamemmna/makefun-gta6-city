// traffic.js — the living stream of cars on Calvera Bay's boulevards. trafficSpawn drops cars
// onto true lane centers near the camera focus and always DENSELY (this is what fills a staged
// screenshot of a boulevard), cruiseTraffic drives them block to block with right-hand turns at
// intersections, cars queue behind whatever occupies the lane ahead (a red-light-length queue
// reads as a busy street), fleeTraffic scatters them when the player is wanted or shooting
// nearby, and despawnTraffic recycles whatever has drifted out of range. No lane-to-node map is
// stored; a car remembers its lane index and a per-lane rng, and picks its turn when it reaches
// the next intersection by axis and direction, exactly like the deterministic grid it drives on.
import { TRAFFIC, TILE, BLOCK_TILES } from './config.js';
import { Rng, clamp, dist2, wrapAngle, angleDelta, hash2 } from './util.js';
import { createVehicle, updateVehicle, separateVehicles, vehicleSpeed } from './vehicles.js';

const TRAFFIC_KINDS = ['sedan', 'sedan', 'sedan', 'pickup', 'van'];
const CRUISE_SPEED = 88;
const FLEE_SPEED = 150;

/**
 * The traffic system object. createTraffic(city) keeps its own Rng so the stream is a pure
 * function of the seed; lanes come from city.js laneCenters (108 lanes, right-hand traffic).
 */
export function createTraffic(city, lanes, seed = 4242) {
  return {
    city,
    lanes,
    rng: new Rng(seed),
    cars: [],
    trafficSeed: seed,
    panicUntil: 0, // world tick until which traffic flees (shots fired nearby)
  };
}

/**
 * Spawn one car onto a lane near (focusX, focusZ), within spawnRadius, facing its lane's dir,
 * skipping any spot that already has a car close by so clusters never stack into one another.
 * Returns the car or null when no free spot was found this call.
 */
export function trafficSpawnLane(traffic, focusX, focusZ) {
  const r = traffic.rng;
  const lanes = traffic.lanes;
  for (let attempt = 0; attempt < 14; attempt += 1) {
    // 7 in 10 spawns pick a boulevard the camera can actually see; the rest keep the wide city alive
    let lane;
    if (r.chance(0.7)) {
      const near = lanes.filter((l) => Math.abs(l.at - (l.axis === 'x' ? focusZ : focusX)) < 260);
      lane = near.length ? near[r.int(near.length)] : lanes[r.int(lanes.length)];
    } else {
      lane = lanes[r.int(lanes.length)];
    }
    // spot along the lane, near the focus, biased INTO frame so screenshots fill up
    const reach = r.chance(0.75) ? 260 : TRAFFIC.spawnRadius;
    const alongLow = Math.max(lane.from, (lane.axis === 'x' ? focusX : focusZ) - reach);
    const alongHigh = Math.min(lane.to, (lane.axis === 'x' ? focusX : focusZ) + reach);
    if (alongHigh - alongLow < 40) continue;
    const along = r.range(alongLow, alongHigh);
    const cross = lane.at;
    const x = lane.axis === 'x' ? along : cross;
    const z = lane.axis === 'x' ? cross : along;
    const heading = lane.axis === 'x' ? (lane.dir > 0 ? Math.PI / 2 : -Math.PI / 2)
      : (lane.dir > 0 ? 0 : Math.PI);
    // occupied: something close in general, or a queue-mate in the SAME lane right ahead/behind
    let blocked = false;
    for (const other of traffic.cars) {
      if (dist2(other.x, other.z, x, z) < 26 * 26) { blocked = true; break; }
      const sameLane = other.lane && other.lane.axis === lane.axis && other.lane.at === lane.at;
      if (sameLane && Math.abs((lane.axis === 'x' ? other.x : other.z) - along) < 46) {
        blocked = true; break;
      }
    }
    if (blocked) continue;
    const car = createVehicle(traffic.city, x, z, heading, TRAFFIC_KINDS[r.int(TRAFFIC_KINDS.length)], r);
    car.driver = 'npc';
    car.lane = lane;
    car.laneIndex = traffic.lanes.indexOf(lane);
    car.cruise = CRUISE_SPEED * r.range(0.85, 1.15);
    car.despawnGrace = 0;
    traffic.cars.push(car);
    return car;
  }
  return null;
}

/**
 * Park one car at the kerb near (focusX, focusZ) — the steal-me car downtown, and the busy
 * boulevard's stationary furniture. It sits on a lane facing the focus, engine off, so the
 * first thing a staged screenshot sees from the hotel steps is a street that has traffic.
 * Returns the parked car or null when no lane is close enough.
 */
export function parkCarAtKerb(traffic, focusX, focusZ) {
  const lanes = traffic.lanes;
  let bestLane = null;
  let bestD = Infinity;
  for (const lane of lanes) {
    const d = Math.abs(lane.at - (lane.axis === 'x' ? focusZ : focusX));
    if (d < bestD) { bestD = d; bestLane = lane; }
  }
  if (!bestLane || bestD > 120) return null;
  const r = traffic.rng;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const along = (bestLane.axis === 'x' ? focusX : focusZ) + r.range(30, 110) * (r.chance(0.5) ? 1 : -1);
    if (along < bestLane.from + 30 || along > bestLane.to - 30) continue;
    const x = bestLane.axis === 'x' ? along : bestLane.at;
    const z = bestLane.axis === 'x' ? bestLane.at : along;
    let blocked = false;
    for (const other of traffic.cars) {
      if (dist2(other.x, other.z, x, z) < 40 * 40) { blocked = true; break; }
    }
    if (blocked) continue;
    const heading = bestLane.axis === 'x' ? (bestLane.dir > 0 ? Math.PI / 2 : -Math.PI / 2)
      : (bestLane.dir > 0 ? 0 : Math.PI);
    const car = createVehicle(traffic.city, x, z, heading, TRAFFIC_KINDS[r.int(TRAFFIC_KINDS.length)], r);
    car.driver = null; // parked, nobody aboard: in play it is the hero's to steal
    car.lane = bestLane;
    car.cruise = CRUISE_SPEED * r.range(0.85, 1.15);
    traffic.cars.push(car);
    return car;
  }
  return null;
}

/** Top up the population: called each tick; fills up to TRAFFIC.cars around the focus. */
export function trafficSpawn(traffic, focusX, focusZ) {
  let want = TRAFFIC.cars;
    while (traffic.cars.length < want) {
    if (!trafficSpawnLane(traffic, focusX, focusZ)) {
      want = traffic.cars.length; // no free spot this tick; try again next tick
      break;
    }
  }
}

/**
 * Boot warm-up: spawn passes until the stream stops growing (up to 24 passes), so the very
 * first rendered frame already carries a full boulevard — the staging sessions rely on this.
 */
export function trafficWarmUp(traffic, focusX, focusZ) {
  let last = -1;
  for (let i = 0; i < 24; i += 1) {
    trafficSpawn(traffic, focusX, focusZ);
    if (traffic.cars.length === last) break; // the grid around the focus is full
    last = traffic.cars.length;
  }
}

/** Distance between two cars measured along/behind a car's heading: positive = ahead. */
function gapAhead(city, me, maxDist = 90) {
  const f = { x: Math.sin(me.heading), z: Math.cos(me.heading) };
  let best = maxDist;
  for (const other of trafficCarsNear(city, me)) {
    if (other === me) continue;
    const dot = (other.x - me.x) * f.x + (other.z - me.z) * f.z;
    if (dot <= 4) continue;
    const lateral = Math.abs((other.x - me.x) * f.z - (other.z - me.z) * f.x);
    if (lateral > 18) continue;
    if (dot < best) best = dot;
  }
  return best;
}

// a tiny per-frame cache of "all cars" for gap tests; main.js registers every live car
let allCarsCache = [];
export function registerCarPool(cars) { allCarsCache = cars; }
function trafficCarsNear(city, me) {
  const out = [];
  for (const c of allCarsCache) {
    if (c === me || c.dead) continue;
    if (dist2(c.x, c.z, me.x, me.z) < 140 * 140) out.push(c);
  }
  return out;
}

/**
 * One intersection every BLOCK_TILES: when a car crosses a cross-street's lane coordinate it
 * may turn onto it (right-hand rule keeps it in the correct one-way half). The choice is
 * hashed from (laneSeed, intersection) so the same traffic always takes the same routes.
 */
function maybeTurnAtIntersection(traffic, car) {
  const grid = BLOCK_TILES * TILE;
  const along = car.lane.axis === 'x' ? car.x : car.z;
  const idx = Math.floor((along - 8) / grid);
  const center = idx * grid + 8; // the intersection strip centre (roads occupy tiles 0..1)
  if (Math.abs(along - center) > 10) return;
  if (car.nextCrossIdx === idx) return; // already decided here
  car.nextCrossIdx = idx;
  const r = new Rng(Math.imul(car.id, 2654435761) ^ Math.imul(idx + 7, 40503) ^ traffic.trafficSeed);
  const choice = r.next();
  const lanes = traffic.lanes.filter((l) => l !== car.lane
    && l.axis !== car.lane.axis
    && Math.abs(l.at - car.lane.at) < 40);
  if (choice < 0.55 || lanes.length === 0) return; // straight through most intersections
  // pick the legal turn: a lane that runs the way we'd sweep into
  const target = lanes[r.int(lanes.length)];
  car.lane = target;
  car.laneIndex = traffic.lanes.indexOf(target);
  // snap onto the new lane's cross coordinate, aimed down its direction
  if (target.axis === 'x') {
    car.z = target.at;
    car.heading = target.dir > 0 ? Math.PI / 2 : -Math.PI / 2;
  } else {
    car.x = target.at;
    car.heading = target.dir > 0 ? 0 : Math.PI;
  }
}

/** Queueing: a car closing on the one ahead eases to a stop behind it, so boulevards stack up. */
function cruiseControls(traffic, car, worldTick, fleeing) {
  const gap = gapAhead(traffic.city, car);
  const lane = car.lane;
  let crossErr = 0;
  let alongPos = 0;
  let wantHeading = car.heading;
  if (lane) {
    // steer toward the exact lane centre line
    crossErr = lane.axis === 'x' ? (car.z - lane.at) : (car.x - lane.at);
    alongPos = lane.axis === 'x' ? car.x : car.z;
    wantHeading = lane.axis === 'x'
      ? (lane.dir > 0 ? Math.PI / 2 : -Math.PI / 2) + clamp(-crossErr * lane.dir * 0.02, -0.5, 0.5)
      : (lane.dir > 0 ? 0 : Math.PI) + clamp(crossErr * lane.dir * 0.02, -0.5, 0.5);
  }
  const targetSpeed = gap < 34 ? 0
    : fleeing ? FLEE_SPEED
    : (gap < 60 ? car.cruise * 0.5 : car.cruise);

    const speed = vehicleSpeed(car);
    const alongForward = Math.sin(car.heading) * car.vx + Math.cos(car.heading) * car.vz;
    let steer = clamp(angleDelta(car.heading, wantHeading) * 2.2, -1, 1);
    let throttle = 0;
    const nearEnd = lane && ((lane.dir > 0 && alongPos > lane.to - 60)
      || (lane.dir < 0 && alongPos < lane.from + 60));
  if (nearEnd) {
    throttle = -1; // roll to a stop at the city rim
    if (speed < 6) car.shouldDespawn = true;
  } else if (targetSpeed > alongForward + 4) {
    throttle = clamp((targetSpeed - alongForward) / 60, 0, 1);
  } else if (targetSpeed < alongForward - 4) {
    throttle = alongForward > 20 ? -1 : 0;
  }
  return { throttle, steer, handbrake: false };
}

/** Mark the whole stream as fleeing until worldTick (shots fired, sirens blazing). */
export function fleeTraffic(traffic, worldTick, duration = 240) {
  traffic.panicUntil = Math.max(traffic.panicUntil, worldTick + duration);
}

/**
 * The per-tick driver of every traffic car: turn at intersections, queue behind the leader,
 * flee when panicked, and recycle via despawnTraffic when far from the focus.
 */
export function updateTraffic(traffic, dt, focusX, focusZ, worldTick, wantedStars = 0) {
  // sirens scatter the civilians: cars near the trouble bolt, the far city keeps cruising
  const panic = worldTick < traffic.panicUntil || wantedStars > 0;
  trafficSpawn(traffic, focusX, focusZ);
  const toRemove = [];
  const flee2 = 520 * 520;
  for (const car of traffic.cars) {
    if (car.driver === 'player') continue; // the hero's ride: physics is player.js's business
    maybeTurnAtIntersection(traffic, car);
    const fleeing = panic && dist2(car.x, car.z, focusX, focusZ) < flee2;
    const controls = cruiseControls(traffic, car, worldTick, fleeing);
    if (car.driver === 'npc' && !car.dead) {
      updateVehicle(car, traffic.city, controls, dt);
    } else {
      // wrecked or driverless: just settle
      car.vx *= 0.9; car.vz *= 0.9;
    }
    // pairwise separation among nearby traffic so queues interlock but never overlap
    for (const other of traffic.cars) {
      if (other.id > car.id) separateVehicles(car, other);
    }
    const far = dist2(car.x, car.z, focusX, focusZ) > TRAFFIC.despawnRadius * TRAFFIC.despawnRadius;
    if (far || car.shouldDespawn) toRemove.push(car);
  }
  despawnTraffic(traffic, toRemove);
  return panic;
}

/** Remove a batch of cars from the live list (they are simply gone; spawn backfills later). */
export function despawnTraffic(traffic, cars) {
  if (!cars.length) return;
  const drop = new Set(cars);
  traffic.cars = traffic.cars.filter((c) => !drop.has(c));
}

/** Count how many live traffic cars sit within radius of the focus — the density check. */
export function trafficDensity(traffic, focusX, focusZ, radius = TRAFFIC.spawnRadius) {
  let n = 0;
  const r2 = radius * radius;
  for (const car of traffic.cars) if (dist2(car.x, car.z, focusX, focusZ) < r2) n += 1;
  return n;
}

/** Nearest car (of any pool) to a point — used by the player's enterCar reach check. */
export function nearestCarTo(pool, x, z, maxDist = 42) {
  let best = null;
  let bestD = maxDist * maxDist;
  for (const car of pool) {
    if (car.dead) continue;
    const d = dist2(car.x, car.z, x, z);
    if (d < bestD) { bestD = d; best = car; }
  }
  return best;
}
