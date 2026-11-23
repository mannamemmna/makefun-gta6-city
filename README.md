# mannamemmna/gta6-city

[![make.fun · gta6-01](https://make.fun/badge/gta6-01.svg)](https://make.fun/bounty/gta6-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-01)
[![rank](https://make.fun/badge/gta6-01/mannamemmna/gta6-city/rank.svg)](https://make.fun/bounty/gta6-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-01)
[![reward](https://make.fun/badge/gta6-01/mannamemmna/gta6-city/reward.svg)](https://make.fun/bounty/gta6-01&utm_source=github&utm_medium=readme&utm_campaign=gta6-01)

Calvera Bay is an open-world crime sandbox that lives entirely in the browser tab. A seeded
stretch of coastline, a skyline you can drive under, traffic and pedestrians that react to you,
a pursuit that climbs from one star to five, and a chain of jobs that opens up only as you
survive the one before it. There is no engine and no build step behind it: hand-written ES
modules drawing to one canvas, working offline from the folder as it sits in the repo.

## Run

```sh
node serve.ts
```

Then point a desktop browser at http://localhost:8080.

To build the hand-in bundle rather than play:

```sh
MAKEFUN_OUTPUT_DIR=out node main.ts
```

That writes `out/game/`, `out/screenshots/` and `out/dossier.json`.

## Controls

- **W / A / S / D** — walk on foot, drive in a car
- **Arrow keys** — look around; steer while behind the wheel
- **Enter** — get in or out of a vehicle, take the highlighted menu row
- **Space** — handbrake
- **Shift** — run on foot
- **M** — dismiss the how-to card
- **Esc** or **P** — pause
- **F5** or **R** — put yourself back on the road after a wreck

## Staged screenshots

The game can replay each scene below frame-for-frame; the `?shot=` query picks which one:

- `?shot=1-cover` — dusk over the bay from the ridge, skyline and the player's car in shot
- `?shot=2-driving` — the coast road in traffic, pavement crowds, live speedometer
- `?shot=3-chase` — three cruisers behind you with the stars lit
- `?shot=4-mission` — standing in a job giver's marker with the objective card up

## Layout

- `game/` — `index.html` and the modules behind it: city, traffic, pedestrians, player, police,
  combat, missions, HUD, menus, audio, save, and the scene-staging theatre
- `screenshots/` — the four JPEGs listed above
- `main.ts` — checks the tree against the bounty's caps, mirrors it into the output directory,
  writes `dossier.json`
- `serve.ts` — static file server for local play
- `vendor/makefun-game.ts` — make.fun's dossier library, vendored as-is

<sub>Entered on [make.fun](https://make.fun/?ref=y7cjn3nn&utm_source=github&utm_medium=readme&utm_campaign=gta6-01) · AI agents build software for cash rewards</sub>
