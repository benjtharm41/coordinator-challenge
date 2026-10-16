"""Compute league-wide NFL averages from nflverse play-by-play files.

These numbers are the calibration targets for the simulation engine.

Usage:
    python3 pipeline/league_averages.py OUT.json pbp_2025.csv.gz [pbp_2026.csv.gz ...]

Only the Python standard library is used, so it runs anywhere (including
the weekly GitHub Action) without installing anything.
"""

import csv
import gzip
import json
import sys
from collections import defaultdict

csv.field_size_limit(10_000_000)


def num(v, default=0.0):
    if v in ("", "NA", None):
        return default
    try:
        return float(v)
    except ValueError:
        return default


def flag(row, col):
    return num(row.get(col)) == 1.0


class Acc:
    """Accumulates raw counts for one group of seasons."""

    def __init__(self):
        self.c = defaultdict(float)
        self.games = {}
        self.fg = defaultdict(lambda: [0, 0])  # bucket -> [made, att]
        self.penalty_types = defaultdict(int)
        self.drives = {}
        self.runoff = defaultdict(lambda: [0.0, 0])
        self.last_play = {}

    def add(self, r):
        c = self.c
        gid = r["game_id"]
        if gid not in self.games:
            self.games[gid] = (num(r["home_score"]), num(r["away_score"]))
        if num(r["qtr"]) >= 5:
            c["ot_games_" + gid] = 1

        play_type = r["play_type"]
        two_pt = flag(r, "two_point_attempt")
        kneel = flag(r, "qb_kneel")
        spike = flag(r, "qb_spike")
        scramble = flag(r, "qb_scramble")
        sack = flag(r, "sack")
        yards = num(r["yards_gained"])

        scrimmage = play_type in ("pass", "run") and not two_pt
        if scrimmage:
            c["plays"] += 1
            c["yards"] += yards
            if not kneel and not spike:
                c["plays_nk"] += 1
                c["yards_nk"] += yards
            if flag(r, "shotgun"):
                c["shotgun"] += 1
            if flag(r, "no_huddle"):
                c["no_huddle"] += 1
            if flag(r, "fumble_lost"):
                c["fumbles_lost"] += 1
            if flag(r, "interception"):
                c["ints"] += 1
            if flag(r, "first_down"):
                c["first_downs"] += 1
            if flag(r, "success"):
                c["success"] += 1

            if play_type == "pass" or scramble:
                c["dropbacks"] += 1
            if play_type == "run" and not scramble and not kneel:
                c["designed_runs"] += 1
                c["designed_run_yards"] += yards
                if yards >= 10:
                    c["runs_10plus"] += 1
                if yards <= 0:
                    c["runs_stuffed"] += 1
            if scramble:
                c["scrambles"] += 1
                c["scramble_yards"] += yards
            if play_type == "pass":
                if sack:
                    c["sacks"] += 1
                    c["sack_yards"] += yards
                elif not spike:
                    c["att"] += 1
                    if flag(r, "complete_pass"):
                        c["comp"] += 1
                        c["comp_yards"] += yards
                        c["yac"] += num(r["yards_after_catch"])
                        if yards >= 20:
                            c["pass_20plus"] += 1
                    if r["air_yards"] not in ("", "NA"):
                        c["air_att"] += 1
                        c["air_yards"] += num(r["air_yards"])
                    if flag(r, "pass_touchdown"):
                        c["pass_td"] += 1
            if flag(r, "rush_touchdown"):
                c["rush_td"] += 1

            down = num(r["down"])
            if down == 3:
                if flag(r, "third_down_converted"):
                    c["3rd_conv"] += 1
                if flag(r, "third_down_failed"):
                    c["3rd_fail"] += 1
            if down == 4:
                c["4th_go"] += 1
                if flag(r, "fourth_down_converted"):
                    c["4th_conv"] += 1

        if flag(r, "penalty"):
            c["penalties"] += 1
            c["penalty_yards"] += num(r["penalty_yards"])
            self.penalty_types[r["penalty_type"] or "Unknown"] += 1

        if flag(r, "field_goal_attempt"):
            d = num(r["kick_distance"])
            b = "<30" if d < 30 else "30-39" if d < 40 else "40-49" if d < 50 else "50-59" if d < 60 else "60+"
            self.fg[b][1] += 1
            if r["field_goal_result"] == "made":
                self.fg[b][0] += 1
        if flag(r, "extra_point_attempt"):
            c["xp_att"] += 1
            if r["extra_point_result"] == "good":
                c["xp_good"] += 1
        if two_pt:
            c["2pt_att"] += 1
            if r["two_point_conv_result"] == "success":
                c["2pt_good"] += 1
        if flag(r, "punt_attempt"):
            c["punts"] += 1
            c["punt_gross"] += num(r["kick_distance"])
            c["punt_return"] += num(r["return_yards"])
            if flag(r, "touchback"):
                c["punt_tb"] += 1
        if flag(r, "kickoff_attempt"):
            c["kickoffs"] += 1
            if flag(r, "touchback"):
                c["ko_tb"] += 1
            if flag(r, "return_touchdown"):
                c["ko_return_td"] += 1
        if flag(r, "safety"):
            c["safeties"] += 1

        # Drives (offensive possessions)
        drive = r["fixed_drive"]
        if drive and r["posteam"] and scrimmage:
            key = (gid, drive)
            if key not in self.drives:
                self.drives[key] = {
                    "start": num(r["yardline_100"]),
                    "transition": r["drive_start_transition"],
                    "result": r["fixed_drive_result"],
                    "plays": 0,
                    "inside20": flag(r, "drive_inside20"),
                }
            self.drives[key]["plays"] += 1

        # Clock runoff between consecutive scrimmage snaps, grouped by how the
        # previous play ended.  Excludes the last 2 minutes of each half and
        # snaps that cross a quarter break.
        if scrimmage and r["game_seconds_remaining"] not in ("", "NA"):
            t = num(r["game_seconds_remaining"])
            half_left = num(r["half_seconds_remaining"])
            prev = self.last_play.get(gid)
            if prev and prev["qtr"] == r["qtr"] and prev["half_left"] > 120:
                gap = prev["t"] - t
                if 0 <= gap <= 60:
                    acc = self.runoff[prev["kind"]]
                    acc[0] += gap
                    acc[1] += 1
            if play_type == "pass" and not sack and not flag(r, "complete_pass"):
                kind = "incomplete"
            elif flag(r, "out_of_bounds"):
                kind = "out_of_bounds"
            else:
                kind = "in_bounds"
            if flag(r, "penalty") or flag(r, "timeout"):
                kind = "other"
            self.last_play[gid] = {"t": t, "qtr": r["qtr"], "half_left": half_left, "kind": kind}

    def summary(self):
        c = self.c
        games = len(self.games)
        team_games = games * 2
        pts = sum(h + a for h, a in self.games.values())
        ties = sum(1 for h, a in self.games.values() if h == a)
        ot = sum(1 for k in c if k.startswith("ot_games_"))
        drives = list(self.drives.values())
        n_dr = len(drives)
        results = defaultdict(int)
        for d in drives:
            results[d["result"]] += 1
        ko_starts = [d["start"] for d in drives if d["transition"] == "KICKOFF"]
        rz = [d for d in drives if d["inside20"]]
        rz_td = sum(1 for d in rz if d["result"] == "Touchdown")
        top_pen = sorted(self.penalty_types.items(), key=lambda kv: -kv[1])[:10]

        def r(x, n=3):
            return round(x, n)

        return {
            "games": games,
            "points_per_team_game": r(pts / team_games, 2),
            "tie_rate": r(ties / games, 4),
            "ot_rate": r(ot / games, 4),
            "plays_per_team_game": r(c["plays"] / team_games, 1),
            "yards_per_play": r(c["yards"] / c["plays"]),
            "yards_per_play_excl_kneel_spike": r(c["yards_nk"] / c["plays_nk"]),
            "pass_rate_dropback": r(c["dropbacks"] / (c["dropbacks"] + c["designed_runs"])),
            "completion_pct": r(c["comp"] / c["att"]),
            "sack_rate": r(c["sacks"] / (c["att"] + c["sacks"])),
            "int_rate": r(c["ints"] / c["att"], 4),
            "pass_td_rate": r(c["pass_td"] / c["att"], 4),
            "yards_per_att_gross": r(c["comp_yards"] / c["att"]),
            "yards_per_completion": r(c["comp_yards"] / c["comp"]),
            "net_yards_per_dropback": r((c["comp_yards"] + c["sack_yards"] + c["scramble_yards"]) / c["dropbacks"]),
            "avg_air_yards_per_att": r(c["air_yards"] / c["air_att"]),
            "avg_yac_per_completion": r(c["yac"] / c["comp"]),
            "pass_20plus_rate_per_att": r(c["pass_20plus"] / c["att"], 4),
            "yards_per_designed_run": r(c["designed_run_yards"] / c["designed_runs"]),
            "run_10plus_rate": r(c["runs_10plus"] / c["designed_runs"], 4),
            "run_stuff_rate": r(c["runs_stuffed"] / c["designed_runs"], 4),
            "scramble_rate_of_dropbacks": r(c["scrambles"] / c["dropbacks"], 4),
            "fumbles_lost_per_play": r(c["fumbles_lost"] / c["plays"], 4),
            "turnovers_per_team_game": r((c["fumbles_lost"] + c["ints"]) / team_games, 2),
            "success_rate": r(c["success"] / c["plays"]),
            "third_down_conv_rate": r(c["3rd_conv"] / (c["3rd_conv"] + c["3rd_fail"])),
            "fourth_down_attempts_per_team_game": r(c["4th_go"] / team_games, 2),
            "fourth_down_conv_rate": r(c["4th_conv"] / c["4th_go"]) if c["4th_go"] else None,
            "shotgun_rate": r(c["shotgun"] / c["plays"]),
            "no_huddle_rate": r(c["no_huddle"] / c["plays"]),
            "penalties_per_team_game": r(c["penalties"] / team_games, 2),
            "penalty_yards_per_team_game": r(c["penalty_yards"] / team_games, 1),
            "top_penalties_share": {k: r(v / c["penalties"]) for k, v in top_pen},
            "fg_pct_by_distance": {b: {"pct": r(m / a) if a else None, "att": a} for b, (m, a) in sorted(self.fg.items())},
            "fg_att_per_team_game": r(sum(a for _, a in self.fg.values()) / team_games, 2),
            "xp_pct": r(c["xp_good"] / c["xp_att"]),
            "two_pt_att_per_team_game": r(c["2pt_att"] / team_games, 3),
            "two_pt_pct": r(c["2pt_good"] / c["2pt_att"]) if c["2pt_att"] else None,
            "punts_per_team_game": r(c["punts"] / team_games, 2),
            "punt_gross_avg": r(c["punt_gross"] / c["punts"], 1),
            "punt_return_avg_per_punt": r(c["punt_return"] / c["punts"], 1),
            "kickoff_touchback_rate": r(c["ko_tb"] / c["kickoffs"]),
            "avg_start_yardline_after_kickoff_own": r(100 - sum(ko_starts) / len(ko_starts), 1) if ko_starts else None,
            "safeties_per_game": r(c["safeties"] / games, 3),
            "drives_per_team_game": r(n_dr / team_games, 2),
            "plays_per_drive": r(sum(d["plays"] for d in drives) / n_dr, 2),
            "points_per_drive_approx": r(pts / n_dr, 3),
            "drive_results_share": {k: r(v / n_dr) for k, v in sorted(results.items(), key=lambda kv: -kv[1])},
            "red_zone_td_rate_per_trip": r(rz_td / len(rz)) if rz else None,
            "clock_runoff_seconds_after": {k: r(s / n, 1) for k, (s, n) in self.runoff.items() if n},
        }


def main():
    out_path, files = sys.argv[1], sys.argv[2:]
    combined = Acc()
    per_file = {}
    for path in files:
        acc = Acc()
        with gzip.open(path, "rt", newline="", encoding="utf-8") as f:
            for row in csv.DictReader(f):
                if row["season_type"] != "REG":
                    continue
                acc.add(row)
                combined.add(row)
        season = path.rsplit("_", 1)[-1].split(".")[0]
        per_file[season] = acc.summary()
        print(f"{season}: {per_file[season]['games']} regular-season games", file=sys.stderr)
    result = {"combined": combined.summary(), "by_season": per_file}
    with open(out_path, "w") as f:
        json.dump(result, f, indent=2)
    print(json.dumps(result["combined"], indent=2))


if __name__ == "__main__":
    main()
