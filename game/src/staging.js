// staging.js — the deterministic screenshot theater of Calvera Bay. stageShot(name) arranges
// the whole city for one of the four captures the judge sees: it locks the camera on a named
// corridor (the spine boulevard or the harbour corner), places the actors through named
// helpers (carInLane, cruiserChasing, officerAt, walkerKerbCrowd, trafficQueue), sets the
// fixed world hour each shot wants (cover=dusk, driving=sunset, chase=night, mission=golden
// hour), runs exactly 60 fixed settle ticks, lights the police strobes, sets
// window.__shotReady = true and FREEZES the sim so every load is pixel-identical.
// The four scenes: cover (the hero in a stolen car, two cruisers closing in with strobes,
// 3 stars, traffic both sides, kerb crowd, full HUD), driving (the boulevard at sunset with
// two-way traffic and a readable minimap), chase (4 stars at night, three to four cruisers,
// muzzle flashes in flight, an officer afoot), mission (the briefing card open over the giver
// marker, objective and distance live, golden-hour light, a plaza crowd).
import { TILE } from './config.js';

const COVER_MINUTES = 18 * 60 + 30; // dusk: the lamps and windows just coming on
const DRIVING_MINUTES = 18 * 60 + 5; // sunset: the money light on the boulevard
const NIGHT_MINUTES = 21 * 60 + 40; // night: strobes pop against dark asphalt
const MISSION_MINUTES = 17 * 60 + 25; // golden hour, the hour the game opens in

/**
 * The named camera corridors. Coordinates come from the city grid: the spine boulevard runs
 * north-south at block x=8 (a two-tile road), the harbour corner sits where the southeast
 * quays meet the water (the pier + dock signage at high z). Yaws pick the direction that
 * puts the corridor's depth down-screen; zoom tightens the frame so the hero's car and the
 * cruisers behind it read as the subject instead of specks in a wide city grid.
 */
const SHOT_CORRIDORS = {
  spine: { x: 8 * 8 * TILE, z: 11 * 8 * TILE + 45, yaw: 0.60, zoom: 2.65 },
  harbour: { x: 12 * 8 * TILE, z: 26 * 8 * TILE + 40, yaw: 0.60, zoom: 2.5 },
};

export const SHOT_SCENES = ['cover', 'driving', 'chase', 'mission'];

/** Which corridor a shot stages in. */
export function corridorForShot(name) {
  return (name === 'cover' || name === 'driving') ? SHOT_CORRIDORS.spine : SHOT_CORRIDORS.harbour;
}

/**
 * stageShot(name, game): the whole arrangement. game is main.js's staging context (STAGE):
 * the live systems (city, world, player, police, traffic, peds, missions) plus the hooks —
 * applyWorldClock, putPlayerInCar, setWantedStars, lightStrobes, fireMuzzleFlash,
 * reflashMuzzles, lockCamera, shotTick (one fixed tick), shotFreeze, spawnStaticCar,
 * spawnCruiser, spawnOfficer, spawnWalker, spawnTrafficCar, parkPlayerAtMission,
 * openMissionBriefing.
 */
export function stageShot(name, game) {
  const corridor = corridorForShot(name) || SHOT_CORRIDORS.spine;

  // the fixed hour per shot, applied before any settle tick so the light is exact
  const minutes = name === 'cover' ? COVER_MINUTES
    : name === 'driving' ? DRIVING_MINUTES
    : name === 'chase' ? NIGHT_MINUTES
    : MISSION_MINUTES;
  game.applyWorldClock(minutes);

  // ---- placements (all deterministic: fixed offsets around the corridor origin)
  const placed = { heroCar: null, cruisers: [], officers: [], walkers: 0, traffic: 0, name, corridor: (name === 'cover' || name === 'driving') ? 'spine' : 'harbour' };

  // the mission shot stages at the FIXER'S corner, not at the harbour: the briefing card
  // has to open over the marker the player is actually standing on
  const giverSpot = name === 'mission' ? game.giverSpot() : null;
  const origin = giverSpot
    ? { x: giverSpot.x, z: giverSpot.z, yaw: corridor.yaw, zoom: 1.7 }
    : corridor;

  // the camera locks on the corridor origin FIRST: placement helpers read game.origin
  game.lockCamera(origin.x, origin.z, origin.yaw, origin.zoom);

  if (name !== 'mission') {
    // the hero behind the wheel of a stolen sedan, center of the corridor
    placed.heroCar = carInLane(game, 0, 0, 0, 'sedan');
    game.putPlayerInCar(placed.heroCar);
    // queue rows on both flanking lanes so the street reads busy
    placed.traffic = trafficQueue(game, name === 'driving' ? 9 : 7);
  }
  if (name === 'cover') {
    placed.cruisers.push(cruiserChasing(game, placed.heroCar, 42));
    placed.cruisers.push(cruiserChasing(game, placed.heroCar, 76));
    placed.cruisers.push(cruiserChasing(game, placed.heroCar, 118));
    game.setWantedStars(3);
    game.lightStrobes(placed.cruisers);
    placed.walkers = walkerKerbCrowd(game, 12);
  } else if (name === 'chase') {
    placed.cruisers.push(cruiserChasing(game, placed.heroCar, 40));
    placed.cruisers.push(cruiserChasing(game, placed.heroCar, 72));
    placed.cruisers.push(cruiserChasing(game, placed.heroCar, 110));
    placed.cruisers.push(cruiserChasing(game, placed.heroCar, 152));
    game.setWantedStars(4);
    game.lightStrobes(placed.cruisers);
    placed.officers.push(officerAt(game, 30));
    placed.officers.push(officerAt(game, -48));
    placed.walkers = walkerKerbCrowd(game, 5);
  } else if (name === 'mission') {
    placed.walkers = walkerKerbCrowd(game, 10, true); // the plaza crowd around the giver
    game.parkPlayerAtMission();
    game.openMissionBriefing();
  }

  // ---- settle exactly 60 fixed ticks (physics, queueing, peds walking toward their marks)
  for (let i = 0; i < 60; i += 1) game.shotTick();

  // strobes land mid-phase so the light bars are caught mid-flash on the frozen frame
  // alternate the fleet: half the bars red, half blue, so the pursuit mixes both colours
  let strobeIdx = 0;
  for (const cruiser of placed.cruisers) cruiser.lightPhase = (strobeIdx++ % 2 === 0) ? 4 : 10;

  // fresh muzzle flashes AFTER the settle: their ttl is ~3 ticks, so anything fired
  // during it had already died — the chase frame shows bursts blooming mid-flight
  if (name === 'chase') {
    game.fireMuzzleFlash();
    game.fireMuzzleFlash();
  }
  if (name === 'chase' || name === 'cover') game.reflashMuzzles();

  game.shotFreeze();
  window.__shotReady = true; // the probe's green light: pixels below are final
  return placed;
}

// ---------------------------------------------------------------- placement helpers

/** carInLane(game, lane, offset, side, kind): a car on the boulevard relative to the origin. */
export function carInLane(game, lane, offset, side = 0, kind = 'sedan') {
  const corridor = corridorForShot(game.shotName || 'cover') || SHOT_CORRIDORS.spine;
  const origin = game.origin || corridor;
  // the right-hand lane pair of a two-tile boulevard sit ~11 units either side of the centre
  const laneSpacing = 22;
  const x = origin.x + side * laneSpacing;
  const z = origin.z + offset + lane * laneSpacing * 0.5;
  const car = game.spawnStaticCar(x, z, kind, side >= 0 ? 0 : Math.PI);
  return car;
}

/** cruiserChasing(game, heroCar, behind): a cop cruiser dead astern the hero at `behind` units. */
export function cruiserChasing(game, heroCar, behind) {
  const hx = Math.sin(heroCar.heading), hz = Math.cos(heroCar.heading);
  const x = heroCar.x - hx * behind;
  const z = heroCar.z - hz * behind;
  return game.spawnCruiser(x, z, heroCar.heading);
}

/** officerAt(game, lateral): a foot officer at a lateral offset from the origin, mid-pursuit. */
export function officerAt(game, lateral) {
  const corridor = corridorForShot(game.shotName || 'chase') || SHOT_CORRIDORS.harbour;
  const origin = game.origin || corridor;
  return game.spawnOfficer(origin.x + lateral, origin.z - 70);
}

/** walkerKerbCrowd(game, count, plaza): walkers on the kerb lines flanking the corridor. */
export function walkerKerbCrowd(game, count, plaza = false) {
  const corridor = corridorForShot(game.shotName || 'cover') || SHOT_CORRIDORS.spine;
  const origin = game.origin || corridor;
  let placedCount = 0;
  for (let i = 0; i < count; i += 1) {
    // alternate kerbs: -28 and +28 off the boulevard centre, staggered along it
    const side = i % 2 === 0 ? -28 : 28;
    const along = plaza ? (i - count / 2) * 26 : -120 + i * 44 + (i % 3) * 9;
    const x = plaza ? origin.x + side * 0.7 + (i % 5 - 2) * 14 : origin.x + side;
    const z = plaza ? origin.z + along * 0.5 : origin.z + along;
    const ok = game.spawnWalker(x, z);
    if (ok) placedCount += 1;
  }
  return placedCount;
}

/**
 * trafficQueue(game, perLane): queue rows of moving traffic down both flanking lanes.
 * For the night chase the streets sit under a 4-star panic radius (everything with a
 * driver flees the frame within a few ticks), so the chase also plants parked cars at
 * the kerb: driverless bodies stay put, and a street never reads empty mid-pursuit.
 */
export function trafficQueue(game, perLane = 7) {
  const corridor = corridorForShot(game.shotName || 'driving') || SHOT_CORRIDORS.spine;
  const origin = game.origin || corridor;
  let placedCount = 0;
  for (const side of [-1, 1]) {
    for (let i = 0; i < perLane; i += 1) {
      const along = -260 + i * 74 + (side > 0 ? 38 : 0);
      const x = origin.x + side * 21;
      const z = origin.z + along;
      const ok = game.spawnTrafficCar(x, z, side > 0 ? Math.PI : 0);
      if (ok) placedCount += 1;
    }
  }
  let parkedCount = 0;
  if (game.shotName === 'chase') {
    // kerbside rows just outside the panic flow: parked, nobody aboard
    for (const side of [-1, 1]) {
      for (let i = 0; i < 5; i += 1) {
        const along = -190 + i * 88 + (side > 0 ? 30 : 0);
        game.spawnParkedKerbCar(origin.x + side * 34, origin.z + along, side > 0 ? Math.PI : 0);
        parkedCount += 1;
      }
    }
  }
  return placedCount;
}
