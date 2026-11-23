// police.js — the heat system of Calvera Bay. reportWitnessCrime converts witnessed misdeeds
// into heat (a stolen car is worth two stars' worth, a shot one star's, striking an officer
// three) via witnesses that must actually see the act, wantedLevelStars maps that heat onto
// the five-star meter, spawnFootOfficers and spawnPoliceCruisers scale the response to the
// star level, pursuePlayer drives them all — officers close in on foot, cruisers steer the
// grid after the hero, arrest when they get close to a slow hero, open fire when the hero is
// armed — and the loseHeatTimer ticks down while no unit has line of sight until the stars
// fade and everyone despawns. Every cruiser is a sedan_police with the sirenOn strobe the
// vehicles layer already flashes red and blue every six ticks.
import { WANTED, TILE } from './config.js';
import { boxHitsBuilding } from './city.js';
import { Rng, clamp, dist2, wrapAngle, angleDelta, moveToward, lerp } from './util.js';
import { createVehicle, updateVehicle, doorPosition, separateVehicles, tickVehicleCommon, vehicleSpeed } from './vehicles.js';

const OFFICER_COLORS = { shirt: '#2c4a7c', pants: '#22283a', skin: '#d9a184' };
const COP_SHOOT_RANGE = 190;
const COP_ARREST_RANGE = 18;
const COP_WALK = 26;
const COP_RUN = 52;
const COP_GIVEUP_RANGE = 560;

let nextCopId = 1;

/** The police + wanted system. createPolice(city) keeps its own seeded stream. */
export function createPolice(city, seed = 909) {
  return {
    city,
    rng: new Rng(seed),
    officers: [], // foot cops
    cruisers: [], // cars
    heat: 0, // continuous wanted value; stars come off WANTED.starHeat
    stars: 0,
    seenTick: 0, // last tick any unit had the hero in view
    loseCooldown: 0, // 0..1 decoy of the heat-loss cooldown, for the HUD bar
    sparkedTick: 0, // last tick a shot was reported (cruisers sprint-spawn after it)
    policeSeed: seed,
  };
}

/** The star count for a heat value, from the config's star thresholds. */
export function wantedLevelStars(police) {
  let s = 0;
  for (let i = 1; i < WANTED.starHeat.length; i += 1) {
    if (police.heat >= WANTED.starHeat[i]) s = i;
  }
  return Math.min(s, WANTED.maxStars);
}

/**
 * A witnessed crime: heat rises only when a civilian was within witnessRange of the act
 * (Calvera Bay is a small town — at zero stars with nobody around, a crime can land quietly).
 * crimeName is metadata for the report log; starHint documents the design call.
 */
export function reportWitnessCrime(police, player, peds, x, z, heat, crimeName, witnessRange = 300) {
  let witnessed = true; // the hero themselves count as the scene; assume seen unless told nobody is around
  if (peds && (peds.peds || peds.trafficCars)) {
    witnessed = false;
    const r2 = witnessRange * witnessRange;
    for (const ped of peds.peds || []) {
      if (ped.state === 'gone') continue;
      if (dist2(ped.x, ped.z, x, z) < r2) { witnessed = true; break; }
    }
    if (!witnessed) {
      // drivers at the wheel are witnesses too: a boulevard full of traffic sees everything
      for (const car of peds.trafficCars || []) {
        if (car.driver !== 'npc') continue;
        if (dist2(car.x, car.z, x, z) < r2) { witnessed = true; break; }
      }
    }
    if (peds.officersNear && peds.officersNear(x, z, witnessRange)) witnessed = true;
  }
  if (!witnessed) return 0;
  const before = wantedLevelStars(police);
  police.heat = Math.min(police.heat + heat, WANTED.starHeat[WANTED.maxStars] + 60);
  police.stars = wantedLevelStars(police);
  // fresh crime resets the hunt: cops get a clean bead on where trouble is
  police.seenTick = police.now ?? 0;
  police.crimes = police.crimes || [];
  police.crimes.push({ name: crimeName, heat, tick: police.now ?? 0, stars: police.stars });
  return police.stars - before;
}

// Convenience amounts the callers use — the star design notes live with the math.
export const CRIME_HEAT = {
  carTheft: WANTED.starHeat[2] + 8, // stealing a car: 2 stars
  shotFired: WANTED.starHeat[1] + 4, // a gunshot: 1 star
  officerHit: WANTED.starHeat[3] + 10, // striking an officer: 3 stars
  vehicleRampage: 26, // mowing down pedestrians
  copCarTheft: WANTED.starHeat[3] + 20, // stealing a cruiser: 3+ stars in one pull
};

/** A foot officer at x,z. He is a pedestrian-shaped actor with a beat and a gun. */
export function spawnFootOfficer(police, x, z) {
  const r = police.rng;
  const officer = {
    id: nextCopId++,
    kind: 'officer',
    x, z, vx: 0, vz: 0,
    heading: r.next() * Math.PI * 2,
    state: 'patrol', // patrol | pursue | arrest | gone
    look: OFFICER_COLORS,
    bob: r.int(64),
    speed: COP_WALK,
    shootCooldown: 0, burst: 0,
    seesPlayer: false,
    health: 60,
    flatTimer: 0,
  };
  police.officers.push(officer);
  return officer;
}

/** A police cruiser spawns straight onto a lane heading, lights already strobing. */
export function spawnPoliceCruiser(police, lanes, x, z, heading, worldTick) {
  const car = createVehicle(police.city, x, z, heading, 'sedan_police', police.rng);
  car.driver = 'cop';
  car.sirenOn = true;
  car.lightPhase = (worldTick / 6) | 0;
  car.copArrestTick = 0;
  police.cruisers.push(car);
  return car;
}

/**
 * Staff the response to the star level: a mix of foot officers (walking out of the precinct
 * house) and cruisers (rolling up the boulevard) near the trouble, capped by star count.
 */
export function spawnPoliceResponse(police, city, lanes, focusX, focusZ, worldTick) {
  const stars = police.stars;
  const targetUnits = WANTED.policeUnitsPerStar[stars] ?? 0;
  const wantCruisers = Math.min(stars, Math.ceil(targetUnits / 2));
  const wantFoot = Math.max(0, targetUnits - wantCruisers);
  const r = police.rng;
  // cruisers roll in from ~400 units out, on a real lane, facing the trouble
  while (police.cruisers.length < wantCruisers) {
    const lane = lanes[r.int(lanes.length)];
    const alongPos = (lane.axis === 'x' ? focusX : focusZ) + r.range(-320, 320);
    if (alongPos < lane.from || alongPos > lane.to) continue;
    const x = lane.axis === 'x' ? alongPos : lane.at;
    const z = lane.axis === 'x' ? lane.at : alongPos;
    if (dist2(x, z, focusX, focusZ) < 120 * 120) continue; // never right on top of the hero
    const heading = lane.axis === 'x'
      ? (lane.dir > 0 ? Math.PI / 2 : -Math.PI / 2)
      : (lane.dir > 0 ? 0 : Math.PI);
    spawnPoliceCruiser(police, lanes, x, z, heading, worldTick);
  }
  // foot officers walk out near the trouble, a block or so off
  while (police.officers.length < wantFoot) {
    const a = r.next() * Math.PI * 2;
    const d = r.range(140, 240);
    spawnFootOfficer(police, focusX + Math.sin(a) * d, focusZ + Math.cos(a) * d);
  }
}

/**
 * The catch: any unit close enough, with the hero slow or stopped, ends the chase — busted.
 * Driving straight at an arresting officer should not be an automatic bust, hence the speed gate.
 */
function tryArrest(police, player, unit, unitSpeed) {
  if (player.bustedState || player.wastedState) return true;
  const d2 = dist2(unit.x, unit.z, player.x, player.z);
  if (d2 < COP_ARREST_RANGE * COP_ARREST_RANGE && player.speed < 16) {
    player.bustedState = true;
    player.inCar = null;
    return true;
  }
  return false;
}

/** Steer a pursuing cruiser along the streets: aim at the hero, road logic kept simple. */
export function cruiserPursueControls(police, car, player, others) {
  const dx = player.x - car.x;
  const dz = player.z - car.z;
  const want = Math.atan2(dx, dz);
  const turn = clamp(angleDelta(car.heading, want) * 2.0, -1, 1);
  const dist = Math.hypot(dx, dz);
  const speed = vehicleSpeed(car);
  const forward = Math.sin(car.heading) * car.vx + Math.cos(car.heading) * car.vz;
  let throttle = 1;
  if (dist < 60 && speed < 40) throttle = 0.5;
  if (dist < 26) throttle = forward > 10 ? -1 : 0; // box the hero in for the arrest
  return { throttle, steer: turn, handbrake: car.slipCrash && false };
}

/** Line of sight from a unit to the hero: sampled along the segment, buildings block it. */
export function canOfficerSeePlayer(police, city, fromX, fromZ, player) {
  const dx = player.x - fromX;
  const dz = player.z - fromZ;
  const dist = Math.hypot(dx, dz);
  if (dist > 340) return false; // beyond the beat's sightline
  const steps = 10;
  for (let s = 1; s < steps; s += 1) {
    const t = s / steps;
    if (boxHitsBuilding(city, fromX + dx * t - 2, fromZ + dz * t - 2, 4, 4)) return false;
  }
  return true;
}

/**
 * pursuePlayer: the whole department's tick. Foot officers run at the hero and open fire when
 * they see him armed; cruisers steer in, sirens strobing; the arrest lands on contact with a
 * slow hero; a runner far out of reach gives his unit the slip (they stop and watch the road,
 * keeping the heat alive), and the loseHeatTimer grinds the heat down whenever no unit has line
 * of sight until the stars fade and everyone despawns.
 */
export function pursuePlayer(police, player, city, lanes, dt, worldTick, playerArmed) {
  const stars = police.stars;
  police.now = worldTick;
  let anySees = false;

  for (const officer of police.officers) {
    if (officer.state === 'gone') continue;
    const d2 = dist2(officer.x, officer.z, player.x, player.z);
    const dist = Math.sqrt(d2);
    // a runner far out of reach and out of sight gives this unit the slip: hold the beat
    if (dist > COP_GIVEUP_RANGE) { officer.seesPlayer = false; continue; }
    officer.seesPlayer = canOfficerSeePlayer(police, city, officer.x, officer.z, player);
    if (officer.seesPlayer) anySees = true;
    const run = stars > 0 && d2 > COP_ARREST_RANGE * COP_ARREST_RANGE;
    officer.heading = wrapAngle(officer.heading
      + clamp(angleDelta(officer.heading, Math.atan2(player.x - officer.x, player.z - officer.z)), -6 * dt, 6 * dt));
    const sp = stars > 0 ? COP_RUN : COP_WALK;
    officer.vx = Math.sin(officer.heading) * sp * (run ? 1 : 0.55);
    officer.vz = Math.cos(officer.heading) * sp * (run ? 1 : 0.55);
    officer.x += officer.vx * dt;
    officer.z += officer.vz * dt;
    officer.bob = (officer.bob + 1) & 63;
    if (tryArrest(police, player, officer)) { officer.state = 'arrest'; }
    // open fire only with a clear line of sight — a measured burst, not a wall of lead,
    // and never through storefronts
    officer.shootCooldown -= dt;
    if (playerArmed && stars > 0 && !player.bustedState && officer.seesPlayer
      && d2 < COP_SHOOT_RANGE * COP_SHOOT_RANGE && officer.shootCooldown <= 0) {
      officer.shootCooldown = 1.1;
      officer.burst = 3;
      police.wantShoot = police.wantShoot || [];
      police.wantShoot.push({
        x: officer.x, z: officer.z, heading: Math.atan2(player.x - officer.x, player.z - officer.z),
        damage: 7, range: COP_SHOOT_RANGE, fromPlayer: false, shooter: officer,
      });
    }
  }

  for (const car of police.cruisers) {
    const controls = cruiserPursueControls(police, car, player);
    updateVehicle(car, city, controls, dt);
    const emergingStars = Math.max(police.stars, wantedLevelStars(police));
    // sirens blaze the moment the department is after the hero: the strobe is the screenshot
    car.sirenOn = emergingStars > 0 && !player.bustedState;
    tickVehicleCommon(car, dt);
    const d2 = dist2(car.x, car.z, player.x, player.z);
    if (d2 < 360 * 360) anySees = true;
    // the cruiser's officers bail out to make the arrest when the hero is nearly cornered
    if (d2 < 70 * 70 && vehicleSpeed(car) < 30 && !player.inCar) {
      if (tryArrest(police, player, car)) car.sirenOn = false;
    }
  }
  for (const a of police.cruisers) for (const b of police.cruisers) if (a.id < b.id) separateVehicles(a, b);

  if (anySees) {
    police.seenTick = worldTick;
    police.loseCooldown = Math.max(0, police.loseCooldown - dt * 0.5);
  } else {
    const sinceSeen = worldTick - police.seenTick;
    // out-of-sight grace, then the heat decays; a shooting star (5) cools slower than a fender bender
    if (sinceSeen > 160) {
      police.heat = Math.max(0, police.heat - WANTED.heatDecayPerSecond * dt * (1 - stars * 0.09));
      police.loseCooldown = clamp((sinceSeen - 160) / 400, 0, 1);
      const newStars = wantedLevelStars(police);
      if (newStars !== police.stars) police.stars = newStars;
    }
  }
  if (police.heat <= 0) police.stars = 0;
}

/**
 * Stand down: at zero stars every unit despawns (the precinct calls them home), refunding the
 * spawn budget so the next crime answers fresh. Called from the main tick each frame.
 */
export function despawnPolice(police) {
  if (police.stars > 0) return;
  police.officers.length = 0;
  police.cruisers.length = 0;
}

/**
 * The system tick main.js calls: staff the response, run the pursuit, drain wantShoot into
 * combat (reader), clean out downed officers and wrecked cruisers.
 */
export function updatePolice(police, player, city, lanes, dt, worldTick, playerArmed, despawnRadius = 1200) {
  police.stars = wantedLevelStars(police);
  if (police.stars > 0) {
    spawnPoliceResponse(police, city, lanes, player.x, player.z, worldTick);
    pursuePlayer(police, player, city, lanes, dt, worldTick, playerArmed);
  } else {
    // stub: nothing to pursue; decay whatever remains
    police.heat = Math.max(0, police.heat - WANTED.heatDecayPerSecond * dt);
  }
  police.officers = police.officers.filter((o) => o.state !== 'gone' && o.health > 0);
  police.cruisers = police.cruisers.filter((c) => !c.dead
    && dist2(c.x, c.z, player.x, player.z) < despawnRadius * despawnRadius);
  despawnPolice(police);
}

/** Damage an officer; three pistol hits put one down and tear the whole force onto the hero. */
export function damageOfficer(police, officer, amount, worldTick) {
  officer.health -= amount;
  if (officer.health <= 0) officer.state = 'gone';
  else police.seenTick = worldTick; // they know exactly where the trouble is now
}

/** The heat-cooldown bar data the HUD will draw: {fraction, active}. */
export function loseHeatBar(police) {
  return { fraction: police.loseCooldown, active: police.loseCooldown > 0 && police.stars > 0 };
}
