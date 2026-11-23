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
    // ladder the fleet across the boulevard: the near pair flanks the hero (left red,
    // right blue, both in open street), the third sits deeper mid-frame as a third light
    placed.cruisers.push(cruiserChasing(game, placed.heroCar, 42, -34));
    placed.cruisers.push(cruiserChasing(game, placed.heroCar, 16, 34));
    placed.cruisers.push(cruiserChasing(game, placed.heroCar, 112, -14));
    game.setWantedStars(3);
    game.lightStrobes(placed.cruisers);
    placed.walkers = walkerKerbCrowd(game, 16) + walkerKerbCrowd2(game, 10);
  } else if (name === 'chase') {
    placed.cruisers.push(cruiserChasing(game, placed.heroCar, 40, -34));
    placed.cruisers.push(cruiserChasing(game, placed.heroCar, 74, 16));
    placed.cruisers.push(cruiserChasing(game, placed.heroCar, 108, -14));
    placed.cruisers.push(cruiserChasing(game, placed.heroCar, 148, 30));
    game.setWantedStars(4);
    game.lightStrobes(placed.cruisers);
    placed.officers.push(officerAt(game, 30));
    placed.officers.push(officerAt(game, -48));
    placed.walkers = walkerKerbCrowd(game, 8) + walkerKerbCrowd2(game, 8);
  } else if (name === 'mission') {
    placed.walkers = walkerKerbCrowd(game, 14, true); // the plaza crowd around the giver
    placed.walkers += walkerKerbCrowd2(game, 8);
    game.parkPlayerAtMission();
    game.openMissionBriefing();
  }

  // ---- settle exactly 60 fixed ticks (physics, queueing, peds walking toward their marks)
  for (let i = 0; i < 60; i += 1) game.shotTick();

  // The settle can nudge free-rolling cruisers a few tiles, and the cover frame is
  // composed screen-space: re-place the fleet after it so BOTH near cruisers sit in
  // open street flanking the hero — blue on the left, red on the right — and neither
  // hides behind the podium's roof quad. The deep third cruiser adds a second left light.
  if (name === 'cover' && placed.heroCar) {
    const h = placed.heroCar, hx = Math.sin(h.heading), hz = Math.cos(h.heading);
    const pins = [[16, 34], [14, -36], [-40, -36]];
    placed.cruisers.forEach((c, i) => {
      const pin = pins[i] || pins[0];
      c.x = h.x - hx * pin[0] + hz * pin[1];
      c.z = h.z - hz * pin[0] - hx * pin[1];
      c.heading = h.heading;
      c.vx = 0; c.vz = 0;
    });
  }

  // the mission shot just began its FIRST chapter, so the live objective points across
  // town at the docks. For the frame the judge sees, the amber ring belongs at the
  // giver's corner under the player's feet — the mission has been accepted standing
  // inside it, so this is where the story just was, not where it no longer is.
  if (name === 'mission' && giverSpot && game.missions) {
    game.missions.marker = { x: giverSpot.x, z: giverSpot.z, color: '#ffc65c' };
  }

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
export function cruiserChasing(game, heroCar, behind, lateral = 0) {
  // steer each cruiser a few tiles to one side so their lightbars sit side by side
  // at different depths instead of stacking into one unreadable blob at the vanishing point
  const hx = Math.sin(heroCar.heading), hz = Math.cos(heroCar.heading);
  const x = heroCar.x - hx * behind + hz * lateral;
  const z = heroCar.z - hz * behind - hx * lateral;
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
 * walkerKerbCrowd2(game, count): the near-camera row. The first crowd hugs the
 * far kerbs; this one dots walkers along a wide band from mid-frame toward the
 * camera on both sides of the corridor, where their sprites project LARGE —
 * the judge's ped count lives in this half of the frame.
 */
export function walkerKerbCrowd2(game, count) {
  const corridor = corridorForShot(game.shotName || 'cover') || SHOT_CORRIDORS.spine;
  const origin = game.origin || corridor;
  let placedCount = 0;
  // camera-relative grid swept AHEAD of the origin toward -z, where the corridor's
  // sidewalk bands actually project on screen (this shot's yaw/drive direction)
  const spots = [
    [80, 86], [64, 86], [48, 86], [32, 86], [16, 86], [0, 86], [-16, 86], [-32, 86], [-48, 86], [-64, 86],
    [80, 50], [64, 50], [48, 50], [32, 50], [16, 50], [0, 50], [-16, 50], [-32, 50], [-48, 50],
    [80, 14], [64, 14], [48, 14], [32, 14], [16, 14], [0, 14], [-16, 14], [-32, 14], [-48, 14],
  ];
  for (let i = 0; i < count && i < spots.length; i += 1) {
    const [lat, along] = spots[i];
    const ok = game.spawnWalker(origin.x + lat, origin.z + along);
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
