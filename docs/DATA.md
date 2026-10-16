# Where the data comes from

Everything comes from [nflverse](https://github.com/nflverse/nflverse-data) (free, public). `pipeline/build_data.py` downloads it and writes small files the game loads:

| nflverse file | What we use it for |
|---|---|
| Play-by-play (current + prior season) | Team tendencies (pass rate by situation, shotgun, no-huddle), offensive line and defense efficiency |
| FTN charting | Play-action, screen, motion and blitz rates |
| Participation | Coverage mix (Cover 3, Cover 4, man, ...) from the most recent season it exists for |
| Depth charts | Current starters and backups (latest snapshot) |
| Injuries | Out / Doubtful players are skipped; Questionable are shown |
| Player stats, snap counts | Player ratings (QB accuracy and decisions, receivers, pass rush, coverage, kickers) |
| Rosters | Jersey numbers |

Ratings are on a 40-99 scale where the average starter is 70. When a player has few snaps this season, last season counts too (weighted 55%), and the rating is pulled toward average. Offensive line ratings are team-level (sack and pressure rates, rushing efficiency) because no free individual line data exists.

Run it yourself: `python3 pipeline/build_data.py`. GitHub does it every Tuesday morning automatically (see `.github/workflows/deploy.yml`).
