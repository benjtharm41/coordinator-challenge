# Calibration report

1000 computer-vs-computer games (placeholder rosters), simulated in 6.2s.
Real numbers: nflverse play-by-play, 2025 season + 2026 to date (351 regular-season games).

| Stat | Sim | Real NFL | Within tolerance? |
|---|---|---|---|
| Points per team per game | 22.1 | 23.1 | yes |
| Yards per play | 5.54 | 5.43 | yes |
| Completion % | 64.5% | 64.6% | yes |
| Sack rate (per dropback) | 6.8% | 6.8% | yes |
| Interception rate (per attempt) | 2.2% | 2.2% | yes |
| Fumbles lost per play | 0.6% | 0.7% | yes |
| Turnovers per team per game | 1.05 | 1.12 | yes |
| Offensive plays per team per game | 58.6 | 60.5 | yes |
| Pass rate (dropbacks) | 61.2% | 60.3% | yes |
| Yards per pass attempt | 7.24 | 7.07 | yes |
| Yards per completion | 11.21 | 10.93 | yes |
| Air yards per attempt | 7.75 | 7.81 | yes |
| YAC per completion | 4.71 | 5.11 | yes |
| 20+ yd completions per attempt | 8.0% | 8.9% | yes |
| Yards per designed run | 4.36 | 4.23 | yes |
| 10+ yd runs | 9.4% | 9.9% | yes |
| Runs stuffed (0 or less) | 18.5% | 18.0% | yes |
| Scramble rate (of dropbacks) | 5.8% | 5.5% | yes |
| 3rd down conversion | 40.3% | 39.9% | yes |
| 4th down tries per team per game | 1.32 | 1.56 | yes |
| 4th down conversion | 53.1% | 55.2% | yes |
| Accepted penalties per team per game | 5.77 | 6.62 | yes |
| FG attempts per team per game | 1.82 | 2.01 | yes |
| FG % 30-39 yds | 94.9% | 94.1% | yes |
| FG % 40-49 yds | 85.0% | 83.6% | yes |
| FG % 50-59 yds | 70.2% | 70.3% | yes |
| Extra point % | 95.5% | 95.5% | yes |
| 2-point conversion % | 44.2% | 48.5% | yes |
| Punts per team per game | 3.42 | 3.61 | yes |
| Gross punt average | 46.6 | 47.3 | yes |
| Kickoff touchback rate | 20.1% | 19.5% | yes |
| Avg start after kickoff (own yd line) | 31.3 | 30.5 | yes |
| Drives per team per game | 10.35 | 10.23 | yes |
| Red zone TD rate (per trip) | 61.1% | 58.3% | yes |
| Drives ending in TD | 23.8% | 24.0% | yes |
| Overtime rate | 5.1% | 5.7% | yes |

36 of 36 stats within tolerance.

Drive results (share of drives): Punt 33.1%, Touchdown 23.8%, Field goal 14.8%, Interception 6.6%, Downs 5.8%, End of game 4.7%, End of half 4.2%, Fumble 3.6%, Missed field goal 2.5%, Safety 0.6%, Blocked field goal 0.3%, Unknown 0.0%
Average game clock per offensive play: 26.0s. Ties: 8.

## Short-quarters mode
Plays per team per game: 31.6 (full game: 58.6). Points per team: 11.6.

## Do better players matter?
- NYJ (rating 79.0) vs ATL (rating 65.1): wins 98%, average margin +21.4
- NYJ (rating 79.0) vs NYG (rating 71.4): wins 80%, average margin +8.7
- NYG (rating 71.4) vs ATL (rating 65.1): wins 87%, average margin +12.0

## Do better calls matter?
| Call quality (matchup advantage) | Share of plays | Yards per play | Success rate |
|---|---|---|---|
| bad call (advantage -2 or worse) | 9% | 4.09 | 35% |
| slightly bad | 35% | 4.79 | 44% |
| neutral | 27% | 5.97 | 52% |
| slightly good | 25% | 6.53 | 59% |
| great call (+2 or better) | 4% | 7.38 | 62% |
