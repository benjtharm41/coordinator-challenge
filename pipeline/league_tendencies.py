"""League-wide play-calling model + team list with head coaches.

Fits a small logistic model of "does the offense drop back to pass?" from
nflverse play-by-play.  The game uses it as the league baseline that each
team's own tendencies are layered on top of.

Usage:
    python3 pipeline/league_tendencies.py OUT_DIR teams_colors_logos.csv pbp_A.csv.gz [pbp_B.csv.gz ...]

Writes OUT_DIR/league-tendencies.json and OUT_DIR/teams.json.
"""

import csv
import gzip
import json
import math
import os
import sys
from collections import defaultdict

csv.field_size_limit(10_000_000)

# Known spelling errors in the source data.
COACH_NAME_FIXES = {"Klint Kubliak": "Klint Kubiak"}


def num(v, d=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return d


def dist_bucket(d):
    d = int(d)
    if d <= 1:
        return "1"
    if d <= 3:
        return "2-3"
    if d <= 6:
        return "4-6"
    if d <= 9:
        return "7-9"
    if d == 10:
        return "10"
    return "11+"


def field_bucket(y):
    if y >= 90:
        return "backed_up"
    if y > 20:
        return "open"
    if y > 10:
        return "red_zone"
    return "goal_line"


def score_bucket(diff):
    if diff <= -17:
        return "down17+"
    if diff <= -9:
        return "down9-16"
    if diff <= -1:
        return "down1-8"
    if diff == 0:
        return "tied"
    if diff <= 8:
        return "up1-8"
    if diff <= 16:
        return "up9-16"
    return "up17+"


def time_bucket(qtr, game_left, half_left):
    if half_left <= 120:
        return "two_min"
    if qtr >= 4 and game_left <= 600:
        return "q4_late"
    return "normal"


def logit(p):
    p = min(max(p, 1e-4), 1 - 1e-4)
    return math.log(p / (1 - p))


def main():
    out_dir, teams_csv, files = sys.argv[1], sys.argv[2], sys.argv[3:]
    # cells[(dd, field, st)] = [passes, plays]
    cells = defaultdict(lambda: [0, 0])
    coach_by_team = {}  # team -> (game_date, coach)
    current_teams = set()

    for path in files:
        with gzip.open(path, "rt", newline="", encoding="utf-8") as f:
            for r in csv.DictReader(f):
                if r["season_type"] != "REG":
                    continue
                for side in ("home", "away"):
                    t, coach, date = r[f"{side}_team"], r[f"{side}_coach"], r["game_date"]
                    current_teams.add(t)
                    if coach and (t not in coach_by_team or date > coach_by_team[t][0]):
                        coach_by_team[t] = (date, coach)
                pt = r["play_type"]
                if pt not in ("pass", "run") or num(r["two_point_attempt"]) == 1:
                    continue
                if r["down"] in ("", "NA"):
                    continue
                is_pass = pt == "pass" or num(r["qb_scramble"]) == 1
                dd = f'{int(num(r["down"]))}:{dist_bucket(num(r["ydstogo"]))}'
                fb = field_bucket(num(r["yardline_100"]))
                diff = int(num(r["score_differential"]))
                st = score_bucket(diff) + "|" + time_bucket(
                    int(num(r["qtr"])), num(r["game_seconds_remaining"]), num(r["half_seconds_remaining"])
                )
                cell = cells[(dd, fb, st)]
                cell[0] += 1 if is_pass else 0
                cell[1] += 1

    # Fit additive logistic model on aggregated cells with gradient descent.
    dds = sorted({k[0] for k in cells})
    fbs = sorted({k[1] for k in cells})
    sts = sorted({k[2] for k in cells})
    w_dd = {k: 0.0 for k in dds}
    w_fb = {k: 0.0 for k in fbs}
    w_st = {k: 0.0 for k in sts}
    total = sum(n for _, n in cells.values())
    groups = [(w_dd, 0), (w_fb, 1), (w_st, 2)]
    # Backfitting with one Newton step per coefficient; converges in a few dozen rounds.
    for _ in range(60):
        for weights, idx in groups:
            grad = defaultdict(float)
            hess = defaultdict(float)
            for key, (passes, n) in cells.items():
                p = 1 / (1 + math.exp(-(w_dd[key[0]] + w_fb[key[1]] + w_st[key[2]])))
                grad[key[idx]] += passes - n * p
                hess[key[idx]] += n * p * (1 - p)
            for k in weights:
                if hess[k] > 0:
                    weights[k] += max(-2.0, min(2.0, grad[k] / hess[k]))
    # Anchor: field "open" and score "tied|normal" are 0, fold into down/distance.
    shift = w_fb["open"] + w_st["tied|normal"]
    model = {
        "description": "logit(P(dropback)) = downDistance + field + scoreTime",
        "downDistance": {k: round(v + shift, 3) for k, v in w_dd.items()},
        "field": {k: round(v - w_fb["open"], 3) for k, v in w_fb.items()},
        "scoreTime": {k: round(v - w_st["tied|normal"], 3) for k, v in w_st.items()},
        "samples": {f"{dd}": sum(n for (d, _, _), (_, n) in cells.items() if d == dd) for dd in dds},
    }
    # Fit check
    pred = sum(n / (1 + math.exp(-(w_dd[a] + w_fb[b] + w_st[c]))) for (a, b, c), (_, n) in cells.items())
    actual = sum(p for p, _ in cells.values())
    print(f"overall pass rate actual {actual / total:.3f} predicted {pred / total:.3f}", file=sys.stderr)

    with open(os.path.join(out_dir, "league-tendencies.json"), "w") as f:
        json.dump(model, f, indent=2)

    teams = []
    with open(teams_csv, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            abbr = r["team_abbr"]
            if abbr not in current_teams or any(t["abbr"] == abbr for t in teams):
                continue
            teams.append(
                {
                    "abbr": abbr,
                    "name": r["team_name"],
                    "nick": r["team_nick"],
                    "conf": r["team_conf"],
                    "division": r["team_division"],
                    "color": r["team_color"],
                    "color2": r["team_color2"],
                    "headCoach": COACH_NAME_FIXES.get(coach_by_team.get(abbr, (None, ""))[1], coach_by_team.get(abbr, (None, "Head Coach"))[1]),
                }
            )
    teams.sort(key=lambda t: t["abbr"])
    print(f"{len(teams)} teams", file=sys.stderr)
    with open(os.path.join(out_dir, "teams.json"), "w") as f:
        json.dump(teams, f, indent=1)


if __name__ == "__main__":
    main()
