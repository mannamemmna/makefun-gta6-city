// missions.js — the "Dock Hand" story chain of Calvera Bay: five named jobs passed down by two
// fixers, Marisol (at the pawn shop) and Quill (outside Club Mirador). Every mission carries its
// briefing text, a map marker the HUD and the minimap both blip, a sequence of objectives
// (driveTo, deliverCrate, tailVehicle with a live broker's sedan, shootout that ends by
// wrecking the plates car, chaseEscape that starts the story finale at three stars), fail
// conditions (wasted/busted, the timer running out, the tail or the wreck getting away), a cash
// reward, and next-mission gating: the chain only advances when the job is passed, so the story
// plays in order. missionChainStep(name) starts any chapter by name, which is how the probe
// harness and the staged screenshots step the story deterministically. After the finale the
// chain is done and repeatable free-roam freight runs spawn at the Harbour Gate forever.
import { Rng, clamp, dist2 } from './util.js';
import { WANTED } from './config.js';
import { createVehicle, vehicleSpeed } from './vehicles.js';

// The chain, in gating order. Each name matches a chapter definition at createMissions().
export const MISSION_CHAIN = [
  'First Shift', 'Crate Run', 'Tail the Broker', 'Burn the Plates', 'Dock Hand',
];

/** The named fixers and where they wait. */
export const FIXER_SPOTS = { marisol: 'pawn', quill: 'club' };

/** A sidewalk spot in front of a landmark building (the fixer's corner, marker included). */
function landmarkSpot(city, id) {
  const lm = city.landmarks.find((l) => l.id === id);
  if (!lm) return null;
  return { x: lm.x, z: lm.z + lm.d / 2 + 18, name: lm.name, id };
}

/** The five chapters as runtime mission objects, their targets pinned to real landmarks. */
function buildChainMissions(city) {
  const dock = landmarkSpot(city, 'dock');
  const market = landmarkSpot(city, 'market');
  const club = landmarkSpot(city, 'club');
  const autos = landmarkSpot(city, 'autos');
  const pawn = landmarkSpot(city, 'pawn');
  return [
    {
      name: 'First Shift', giver: 'marisol', reward: 250, timeLimit: 0,
      briefing: 'Marisol snaps her gum: "Night shift at the Harbour Gate. Take any car, be there before the foreman changes his mind."',
      steps: [
        { type: 'driveTo', ...dock, radius: 66, text: 'Drive to the Harbour Gate' },
      ],
    },
    {
      name: 'Crate Run', giver: 'marisol', reward: 400, timeLimit: 300,
      briefing: 'Marisol hefts a sealed crate into your arms: "Bayside Market. Sealed. Unopened. Clock is running."',
      steps: [
        { type: 'driveTo', ...dock, radius: 66, text: 'Load the crate at the Harbour Gate' },
        { type: 'deliverCrate', ...market, radius: 70, text: 'Deliver the crate — stop at Bayside Market' },
      ],
    },
    {
      name: 'Tail the Broker', giver: 'quill', reward: 650, timeLimit: 320,
      briefing: 'Quill flicks his lighter: "A broker skims Quill profitssss. Follow his sedan, keep your distance, do not spook him."',
      steps: [
        { type: 'tailVehicle', text: 'Tail the sedan — hold 60-260 units for 15s', tailSeconds: 15 },
        { type: 'driveTo', ...club, radius: 66, text: 'Report back to Quill at the club' },
      ],
    },
    {
      name: 'Burn the Plates', giver: 'quill', reward: 900, timeLimit: 320,
      briefing: 'Quill drops a mag in your palm: "That sedan carries the printing plates. Wreck it, burn it, come back clean."',
      steps: [
        { type: 'shootout', text: 'Wreck the plates car', escapeSeconds: 12 },
        { type: 'driveTo', ...autos, radius: 70, text: 'Ditch the heat at Sunset Autos' },
      ],
    },
    {
      name: 'Dock Hand', giver: 'marisol', reward: 1500, timeLimit: 320,
      briefing: 'Marisol, quiet for once: "The docks are yours if you want them. Draw the heat off the harbour, then LOSE the stars. Go."',
      steps: [
        { type: 'chaseEscape', text: 'Shake the law — lose the wanted stars', stars: 3 },
        { type: 'driveTo', ...dock, radius: 66, text: 'Meet Marisol at the Harbour Gate' },
      ],
    },
  ];
}

/** The missions system: the chain index, the live run, the marker and the side jobs. */
export function createMissions(city, seed = 3313, cars, police) {
  return {
    city,
    rng: new Rng(seed),
    cars: cars || [], // the shared traffic list the mission cars join (broker sedan, plates car)
    police,
    chain: buildChainMissions(city),
    chainIndex: 0, // 0..5: the next chapter to hand out
    state: 'idle', // 'idle' | 'active'
    mission: null, // the live chapter object while active
    step: null, // the live objective
    stepIndex: 0,
    timeLeft: 0, // mission timer, seconds; 0 = untimed
    briefingTtl: 0, // seconds the briefing card stays up
    showBriefing: false,
    marker: null, // {x, z, color} — the HUD + minimap blip
    tailProgress: 0, // 0..1 of the tail held
    tailBrokenFor: 0, // seconds the tail has been blown
    escapeBurn: 0, // seconds the wreck has been out of reach
    car: null, // the mission vehicle (broker sedan / plates car)
    sideJobsDone: 0,
    sideJob: null, // {to:{x,z,name}, reward, text} — repeatable freight run
    lastOutcome: null, // 'passed' | 'failed:<reason>' for probes
  };
}

/** The giver of the next story chapter — the marker the idle HUD and minimap show. */
export function missionGiver(missions) {
  if (missions.chainIndex >= missions.chain.length) return null;
  const chapter = missions.chain[missions.chainIndex];
  const spot = landmarkSpot(missions.city, FIXER_SPOTS[chapter.giver]);
  if (!spot) return null;
  return { ...spot, giver: chapter.giver, chapter: chapter.name, kind: 'giver' };
}

/** missionChainStep(name): start (or restart, or skip straight into) any chapter by name. */
export function missionChainStep(missions, name) {
  const index = MISSION_CHAIN.indexOf(name);
  if (index < 0) return null;
  if (missions.state === 'active' && missions.mission && missions.mission.name === name) {
    return missions.mission; // already running this chapter
  }
  missions.chainIndex = index; // the named chapter becomes the next step of the story
  return beginMission(missions, null);
}

/** Grab a car from the traffic stream for a mission role (the broker's sedan, the plates car). */
function spawnMissionCar(missions, heading) {
  const r = missions.rng;
  const player = missions.__player || { x: 700, z: 700 };
  const dx = Math.sin(heading), dz = Math.cos(heading);
  const x = clamp(player.x + dx * 240 + r.range(-60, 60), 60, missions.city.worldSize - 80);
  const z = clamp(player.z + dz * 240 + r.range(-60, 60), 60, missions.city.waterStart * 16 - 80);
  const car = createVehicle(missions.city, x, z, heading, 'sedan', r);
  car.driver = 'npc';
  car.cruise = 96;
  if (missions.cars.indexOf(car) < 0) missions.cars.push(car);
  return car;
}

/** Begin the chapter the chain points at (auto after the giver's talk). */
function beginMission(missions, player) {
  if (missions.chainIndex >= missions.chain.length) return null;
  const chapter = missions.chain[missions.chainIndex];
  missions.__player = player || missions.__player;
  missions.state = 'active';
  missions.mission = chapter;
  missions.stepIndex = 0;
  missions.step = chapter.steps[0];
  missions.timeLeft = chapter.timeLimit || 0;
  missions.briefingTtl = 14;
  missions.showBriefing = true;
  missions.tailProgress = 0; missions.tailBrokenFor = 0; missions.escapeBurn = 0;
  missions.car = null;
  armStep(missions, player, missions.police);
  return chapter;
}

/** Set up whichever step just became live (spawn cars, light the finale stars). */
function armStep(missions, player, police) {
  const step = missions.step;
  if (!step) return;
  missions.marker = { x: step.x, z: step.z, color: '#ffc65c' };
  if (step.type === 'tailVehicle') {
    missions.car = spawnMissionCar(missions, (missions.rng.chance(0.5)) ? Math.PI / 2 : -Math.PI / 2);
    missions.marker = { x: missions.car.x, z: missions.car.z, color: '#ff7b54' };
  }
  if (step.type === 'shootout') {
    missions.car = spawnMissionCar(missions, (missions.rng.chance(0.5)) ? Math.PI / 2 : -Math.PI / 2);
    missions.marker = { x: missions.car.x, z: missions.car.z, color: '#e0393f' };
  }
  if (step.type === 'chaseEscape' && police) {
    // the finale opens with the whole department on the hero's tail
    police.heat = WANTED.starHeat[step.stars] + 12;
    police.stars = step.stars;
    police.seenTick = Infinity; // units spawn from the star level alone
    missions.marker = null; // no blip: the objective is to vanish
  }
  return step;
}

/** The step just completed: next objective, or pass the whole chapter. */
function completeStep(missions, ctx) {
  missions.stepIndex += 1;
  if (missions.stepIndex >= missions.mission.steps.length) {
    passMission(missions, ctx);
    return;
  }
  missions.step = missions.mission.steps[missions.stepIndex];
  armStep(missions, ctx.player, ctx.police);
}

/** Pass: reward cash, banner, chime — and the chain gate opens the next chapter. */
function passMission(missions, ctx) {
  const chapter = missions.mission;
  missions.chainIndex = Math.min(missions.chainIndex + 1, missions.chain.length);
  const lastStory = missions.chainIndex >= missions.chain.length;
  missions.state = 'idle';
  missions.step = null;
  missions.mission = null;
  missions.car = null;
  missions.marker = null;
  missions.lastOutcome = 'passed';
  missions.briefingTtl = 0;
  missions.showBriefing = false;
  if (ctx.onPass) ctx.onPass(chapter, lastStory);
}

/** Fail: red banner, the chapter stays gated as the next one to retry. */
function failMission(missions, ctx, reason) {
  const chapter = missions.mission;
  missions.state = 'idle';
  missions.step = null;
  missions.mission = null;
  missions.car = null;
  missions.marker = null;
  missions.lastOutcome = 'failed:' + reason;
  missions.briefingTtl = 0;
  missions.showBriefing = false;
  if (ctx.onFail) ctx.onFail(chapter, reason);
}

/** Start a repeatable free-roam freight run once the story chain is finished. */
function beginSideJob(missions) {
  const r = missions.rng;
  const ids = ['market', 'pawn', 'autos', 'hospital', 'club'];
  const id = ids[r.int(ids.length)];
  const spot = landmarkSpot(missions.city, id);
  if (!spot) return false;
  const reward = 80 + r.int(9) * 10;
  missions.sideJob = { to: spot, reward, text: `Freight run: ${spot.name}` };
  missions.marker = { x: spot.x, z: spot.z, color: '#7fe08c' };
  return true;
}

/** One fixed tick of the story: proximity handouts, timers, objective tests, side freight. */
export function updateMissions(missions, ctx) {
  const { player, police, world } = ctx;
  const dt = ctx.dt ?? 1 / 60;
  missions.__player = player;
  if (missions.briefingTtl > 0) missions.briefingTtl = Math.max(0, missions.briefingTtl - dt);

  if (missions.state === 'idle') {
    // walk up to the fixer while a chapter waits: the briefing and the job begin
    if (missions.chainIndex < missions.chain.length) {
      const giver = missionGiver(missions);
      if (giver && dist2(giver.x, giver.z, player.x, player.z) < 58 * 58) {
        beginMission(missions, player);
        if (ctx.onStart) ctx.onStart(missions.mission);
      }
    } else {
      // story done: repeatable freight runs hang at the Harbour Gate forever
      const dock = landmarkSpot(missions.city, 'dock');
      if (dock && dist2(dock.x, dock.z, player.x, player.z) < 70 * 70) {
        if (!missions.sideJob) beginSideJob(missions);
      }
      if (missions.sideJob) {
        missions.timeLeft = 240;
        const to = missions.sideJob.to;
        const d = Math.hypot(to.x - player.x, to.z - player.z);
        missions.marker = { x: to.x, z: to.z, color: '#7fe08c' };
        if (d < 70 && player.inCar && player.speed < 24) {
          const reward = missions.sideJob.reward;
          missions.sideJobsDone += 1;
          missions.sideJob = null;
          missions.marker = null;
          missions.lastOutcome = 'side:passed';
          if (ctx.onSidePass) ctx.onSidePass(reward);
        }
      }
    }
    return missions.state;
  }

  // ---------------------------------------------------------------- active mission
  const step = missions.step;
  const chapter = missions.mission;
  if (!step || !chapter) { missions.state = 'idle'; return 'idle'; }

  if (chapter.timeLimit > 0) {
    missions.timeLeft -= dt;
    if (missions.timeLeft <= 0) { failMission(missions, ctx, 'out of time'); return 'failed'; }
  }

  if (player.bustedState || player.wastedState) {
    failMission(missions, ctx, player.bustedState ? 'busted' : 'wasted');
    return 'failed';
  }

  // the mission car drives its escape line while the step needs it
  if (missions.car && !missions.car.dead) {
    driveMissionCar(missions, dt);
  }

  if (step.type === 'driveTo' || step.type === 'deliverCrate') {
    const arrived = dist2(step.x, step.z, player.x, player.z) < step.radius * step.radius;
    if (step.type === 'deliverCrate') {
      // the crate leaves through the door: be there, driving, stopped
      if (arrived && player.inCar && player.speed < 24) completeStep(missions, ctx);
    } else if (arrived && player.inCar) {
      completeStep(missions, ctx);
    }
  } else if (step.type === 'tailVehicle') {
    const car = missions.car;
    if (!car || car.dead) { failMission(missions, ctx, 'the sedan is wrecked'); return 'failed'; }
    const d = Math.hypot(car.x - player.x, car.z - player.z);
    missions.marker = { x: car.x, z: car.z, color: '#ff7b54' };
    if (d >= 60 && d <= 260) {
      missions.tailProgress += dt / step.tailSeconds;
      missions.tailBrokenFor = 0;
    } else if (d > 460) {
      missions.tailBrokenFor += dt;
      if (missions.tailBrokenFor > 3) { failMission(missions, ctx, 'you lost the tail'); return 'failed'; }
    }
    if (missions.tailProgress >= 1) completeStep(missions, ctx);
  } else if (step.type === 'shootout') {
    const car = missions.car;
    if (car && car.dead) { completeStep(missions, ctx); }
    else if (car) {
      const d = Math.hypot(car.x - player.x, car.z - player.z);
      if (d > 700) {
        missions.escapeBurn += dt;
        if (missions.escapeBurn > step.escapeSeconds) {
          failMission(missions, ctx, 'the plates car got away');
          return 'failed';
        }
      } else missions.escapeBurn = 0;
    }
  } else if (step.type === 'chaseEscape') {
    const stars = police ? police.stars : 0;
    if (stars === 0) { completeStep(missions, ctx); }
    else if (police) police.seenTick = world.time; // the hunt stays hot while the story demands it
  }
  return missions.state;
}

/** The mission car's simple escape line: straight down a boulevard, turning back at the quay. */
function driveMissionCar(missions, dt) {
  const car = missions.car;
  const speed = vehicleSpeed(car);
  const want = car.cruise || 96;
  const accel = clamp((want - speed) * 2.2, -60, 80);
  const hx = Math.sin(car.heading), hz = Math.cos(car.heading);
  car.vx += hx * accel * dt;
  car.vz += hz * accel * dt;
  car.x += car.vx * dt;
  car.z += car.vz * dt;
  // turn back before running into the sea
  const limit = (missions.city.waterStart - 4) * 16;
  const size = missions.city.worldSize - 60;
  if (car.x < 60 || car.x > size || car.z < 60 || car.z > limit) {
    car.heading = car.heading + Math.PI;
    car.vx *= -0.3; car.vz *= -0.3;
    car.x = clamp(car.x, 60, size);
    car.z = clamp(car.z, 60, limit);
  }
}

/** The HUD line for the live objective: text, meters to the target, urgent when the clock runs. */
export function missionHudInfo(missions) {
  if (missions.state !== 'active' || !missions.step) return null;
  const step = missions.step;
  const player = missions.__player || { x: 0, z: 0 };
  let distText = '';
  if (step.x !== undefined) {
    const d = Math.round(Math.hypot(step.x - player.x, step.z - player.z));
    distText = `${d}m`;
  } else if (missions.car) {
    const d = Math.round(Math.hypot(missions.car.x - player.x, missions.car.z - player.z));
    distText = `${d}m`;
  }
  let text = step.text;
  if (step.type === 'tailVehicle') {
    text = `Tail the sedan — hold ${Math.round(Math.max(0, 1 - missions.tailProgress) * step.tailSeconds)}s more`;
  }
  if (step.type === 'chaseEscape') {
    text = `Shake the pursuit — ${missions.policeStars ?? missions.step.stars} stars to lose`;
  }
  const urgent = missions.timeLeft > 0 && missions.timeLeft < 30;
  return { label: 'OBJECTIVE', text, distText, urgent };
}

/** How much mission clock is left, as the HUD shows it (null when untimed/idle). */
export function missionTimerInfo(missions) {
  if (missions.state !== 'active' || missions.mission.timeLimit <= 0) return null;
  const s = Math.max(0, Math.ceil(missions.timeLeft));
  return {
    text: `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`,
    urgent: missions.timeLeft < 30,
  };
}
