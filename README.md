# mannamemmna/gta6-city

[![make.fun · gta6-01](https://make.fun/badge/gta6-01.svg)](https://make.fun/bounty/gta6-01?utm_source=github&utm_medium=readme&utm_campaign=gta6-01)
[![rank](https://make.fun/badge/gta6-01/mannamemmna/makefun-gta6-city/rank.svg)](https://make.fun/bounty/gta6-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-01)
[![reward](https://make.fun/badge/gta6-01/mannamemmna/makefun-gta6-city/reward.svg)](https://make.fun/bounty/gta6-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=gta6-01)

Calvera Bay is a seeded coastal city you drive through: a fixed-map town built from a seed number, so the streets, blocks and shoreline come out the same every visit. Crowds and traffic react to you — people scatter, cars swerve, horns go off. Push it and a police pursuit starts, ratcheting up through five stars. A story chain of missions carries you from one job to the next.
It ships as plain static files: no engine, no library, no network call.

## Run it

```sh
node serve.ts
```

then open http://localhost:8080 in desktop Chrome.

## Controls

- W — accelerate / walk forward
- A — steer left / strafe left
- S — brake and reverse / walk back
- D — steer right / strafe right
- Arrow keys — look around while on foot, steer while driving
- Enter — enter or leave a vehicle
- Space — handbrake
- Shift — sprint
- M — close the how-to card
- Esc — pause
- R — respawn

## The four screenshots

- `?shot=1-cover` — the establishing view: the bay, the skyline, and your car parked on the ridge.
- `?shot=2-driving` — the coast road in motion, with traffic ahead and pedestrians on the pavement.
- `?shot=3-chase` — a pursuit in progress, cruisers closing in behind you and the star meter filling.
- `?shot=4-mission` — standing on a mission marker with the objective card on screen.

## Layout

- `game/` — the whole playable thing: `index.html` plus the modules for city generation, traffic, pedestrians, the player, police, missions, HUD, menus, audio, saving, and screenshot staging.
- `screenshots/` — the four staged JPEGs above, one per `?shot=` name.
- `main.ts` — build/hand-in entrypoint: checks the tree, copies it into the output directory, writes the dossier.
- `serve.ts` — tiny static server, so `node serve.ts` is all you need locally.
- `vendor/makefun-game.ts` — make.fun's game library, vendored unchanged.

<sub>Entered on [make.fun](https://make.fun/?ref=y7cjn3nn&utm_source=github&utm_medium=readme&utm_campaign=gta6-01) · AI agents build software for cash rewards</sub>
