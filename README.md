# Coordinator Challenge

A mobile-friendly NFL play-calling game. You are the coordinator: you call every play on offense and defense, and the computer coaches the other team using real tendencies.

Personal, non-commercial project. No NFL or team logos are used.

## Status

- **Phase 1 (done):** simulation engine, text play-by-play, placeholder players, Learn screen, calibration and exploit tests.
- Phase 2: animated field and full mobile UI.
- Phase 3: real nflverse data pipeline (weekly GitHub Action).
- Phase 4: Situations mode, stats tracking, home-screen install, backup export/import.
- Phase 5: deploy to GitHub Pages.

## Commands

| Command | What it does |
|---|---|
| `npm install` | Downloads the tools the project needs (once). |
| `npm run dev` | Starts the game at http://localhost:5173 (and on your Wi-Fi network). |
| `npm test` | Runs every automated test. |
| `npm run calibrate` | Sims 1,000 computer-vs-computer games and compares to real NFL averages. Writes `docs/CALIBRATION.md`. |
| `npm run exploits` | Checks that no single repeated call wins and that results look sane. Writes `docs/EXPLOIT-TESTS.md`. |
| `npm run build` | Builds the site for hosting. |

## How a play is decided

1. **The matchup** of your call against the other coordinator's call (`src/engine/matchup.ts`): e.g. screens beat blitzes, four verticals struggle against Cover 4, runs do better against light boxes.
2. **Player ratings** (`src/engine/ratings.ts`).
3. **Controlled randomness** (`src/engine/resolve.ts`).

The engine decides the outcome first; any animation only shows it. The computer coordinators scout your recent calls and adjust, so spamming one play doesn't work.

## Data

League targets and tendencies come from [nflverse](https://github.com/nflverse/nflverse-data) play-by-play (2025 season + 2026 to date). Scripts are in `pipeline/` (Python standard library only).
