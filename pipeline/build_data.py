#!/usr/bin/env python3
"""Build the game's data from nflverse (https://github.com/nflverse/nflverse-data).

Downloads rosters, depth charts, injuries, player stats, snap counts, play-by-play,
FTN charting and coverage (participation) data, then writes:

  public/data/manifest.json     team list, data freshness, headline players
  public/data/teams/ABBR.json   one small file per team: players, depth chart, ratings, tendencies
  src/engine/data/*.json        league averages the engine is tuned against

Only the Python standard library is used.

Usage:
    python3 pipeline/build_data.py [--cache DIR] [--out public/data] [--engine-data src/engine/data]
"""

import argparse
import datetime
import hashlib
import json
import math
import os
import shutil
import subprocess
import sys
import tempfile
from collections import Counter, defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from common import BASE, clamp, fetch, flag, is_true, log, mean_sd, num, rows  # noqa: E402

CUR_W = 1.0   # weight of the current season
PREV_W = 0.55  # weight of the prior season (blended in while samples are small)


# ------------------------------------------------------------------ downloads

def season_has_games(path):
    n = 0
    for r in rows(path):
        if r["season_type"] == "REG":
            return True
        n += 1
        if n > 5000:
            break
    return False


def pick_seasons(cache, today):
    for cur in (today.year, today.year - 1, today.year - 2):
        p = fetch(f"{BASE}/pbp/play_by_play_{cur}.csv.gz", cache, 12, required=False)
        if p and season_has_games(p):
            return cur
    raise RuntimeError("no play-by-play data found")


# ------------------------------------------------------------------ math helpers

def sigmoid(z):
    return 1 / (1 + math.exp(-z))


def shrink(value, n, prior, k):
    """Pull a measured rate toward a prior; small samples move most."""
    if value is None or n <= 0:
        return prior
    return (value * n + prior * k) / (n + k)


def to_rating(z, scale=12.0, center=70.0):
    return int(round(clamp(center + scale * z, 40, 99)))


def dist_bucket(d):
    d = int(d)
    return "1" if d <= 1 else "2-3" if d <= 3 else "4-6" if d <= 6 else "7-9" if d <= 9 else "10" if d == 10 else "11+"


def field_bucket(y):
    return "backed_up" if y >= 90 else "open" if y > 20 else "red_zone" if y > 10 else "goal_line"


def score_bucket(d):
    return ("down17+" if d <= -17 else "down9-16" if d <= -9 else "down1-8" if d <= -1 else "tied" if d == 0
            else "up1-8" if d <= 8 else "up9-16" if d <= 16 else "up17+")


def time_bucket(qtr, game_left, half_left):
    return "two_min" if half_left <= 120 else "q4_late" if qtr >= 4 and game_left <= 600 else "normal"


# ------------------------------------------------------------------ play-by-play aggregation

class Team:
    """Weighted sums for one team, offense and defense."""

    def __init__(self):
        self.o = defaultdict(float)
        self.d = defaultdict(float)
        self.cells = defaultdict(lambda: [0.0, 0.0])  # offense pass-rate cells
        self.cov = defaultdict(float)  # coverage counts when on defense


def load_ftn(cache, season):
    p = fetch(f"{BASE}/ftn_charting/ftn_charting_{season}.csv", cache, 12, required=False)
    out = {}
    if not p:
        return out
    for r in rows(p):
        out[(r["nflverse_game_id"], r["nflverse_play_id"])] = (
            is_true(r["is_play_action"]), is_true(r["is_screen_pass"]), is_true(r["is_motion"]),
            num(r["n_pass_rushers"]), is_true(r["is_no_huddle"]),
        )
    return out


def aggregate_pbp(cache, season, weight, teams, model, play_def):
    path = fetch(f"{BASE}/pbp/play_by_play_{season}.csv.gz", cache, 12)
    ftn = load_ftn(cache, season)
    coaches = {}
    last_week = 0
    dd_m, fb_m, st_m = model["downDistance"], model["field"], model["scoreTime"]
    for r in rows(path):
        if r["season_type"] != "REG":
            continue
        week = int(num(r["week"]))
        last_week = max(last_week, week)
        for side in ("home", "away"):
            c = r[f"{side}_coach"]
            if c:
                coaches[r[f"{side}_team"]] = (r["game_date"], c) if r[f"{side}_team"] not in coaches or r["game_date"] > coaches[r[f"{side}_team"]][0] else coaches[r[f"{side}_team"]]
        pt = r["play_type"]
        if pt not in ("pass", "run") or flag(r, "two_point_attempt") or not r["posteam"] or r["down"] in ("", "NA"):
            continue
        if flag(r, "qb_kneel") or flag(r, "qb_spike"):
            continue
        off, de = r["posteam"], r["defteam"]
        t_off, t_def = teams[off], teams[de]
        w = weight
        scramble = flag(r, "qb_scramble")
        dropback = pt == "pass" or scramble
        key = (r["game_id"], r["play_id"])
        f = ftn.get(key)
        if pt == "pass":
            play_def[key] = de
        epa = num(r["epa"])
        t_off.o["plays"] += w
        t_off.o["shotgun"] += w * flag(r, "shotgun")
        t_off.o["no_huddle"] += w * flag(r, "no_huddle")
        # Pass-rate cell for the league model.
        dd = f"{int(num(r['down']))}:{dist_bucket(num(r['ydstogo']))}"
        st = score_bucket(int(num(r["score_differential"]))) + "|" + time_bucket(int(num(r["qtr"])), num(r["game_seconds_remaining"]), num(r["half_seconds_remaining"]))
        z = dd_m.get(dd, 0) + fb_m.get(field_bucket(num(r["yardline_100"])), 0) + st_m.get(st, 0)
        cell = t_off.cells[(z)]
        cell[0] += w * (1 if dropback else 0)
        cell[1] += w
        if f:
            t_off.o["ftn_plays"] += w
            t_off.o["motion"] += w * f[2]
        if dropback:
            sack = flag(r, "sack")
            t_off.o["db"] += w
            t_def.d["db"] += w
            t_def.d["pass_epa"] += w * epa
            t_off.o["sack"] += w * sack
            t_def.d["sack"] += w * sack
            hit = flag(r, "qb_hit")
            t_off.o["hit"] += w * hit
            t_def.d["hit"] += w * hit
            if pt == "pass" and not sack:
                t_off.o["att"] += w
                ay = r["air_yards"]
                if ay not in ("", "NA") and num(ay) >= 15:
                    t_off.o["deep"] += w
                if ay not in ("", "NA"):
                    t_off.o["air_att"] += w
            if f:
                t_off.o["ftn_db"] += w
                t_off.o["pa"] += w * f[0]
                t_off.o["screen"] += w * f[1]
                t_def.d["ftn_db"] += w
                t_def.d["blitz"] += w * (f[3] >= 5)
        else:
            t_off.o["run"] += w
            t_off.o["run_epa"] += w * epa
            t_off.o["run_succ"] += w * flag(r, "success")
            t_def.d["run"] += w
            t_def.d["run_epa"] += w * epa
    return coaches, last_week


def aggregate_participation(cache, season, weight, teams, play_def):
    p = fetch(f"{BASE}/pbp_participation/pbp_participation_{season}.csv", cache, 12, required=False)
    if not p:
        return 0
    mapping = {"COVER_0": "c0", "COVER_1": "c1", "COVER_2": "c2", "2_MAN": "c2m", "COVER_3": "c3", "COVER_4": "c4", "COVER_6": "c6"}
    n = 0
    for r in rows(p):
        c = mapping.get(r["defense_coverage_type"])
        if not c:
            continue
        de = play_def.get((r["nflverse_game_id"], r["play_id"]))
        if de:
            teams[de].cov[c] += weight
            n += 1
    return n


# ------------------------------------------------------------------ player stats

STAT_COLS = [
    "attempts", "completions", "passing_yards", "passing_interceptions", "sacks_suffered", "passing_air_yards", "passing_epa",
    "carries", "rushing_yards", "rushing_epa", "targets", "receptions", "receiving_yards", "receiving_yards_after_catch", "receiving_epa",
    "def_sacks", "def_qb_hits", "def_tackles_for_loss", "def_tackles_solo", "def_interceptions", "def_pass_defended",
    "fg_att", "fg_made", "fg_long", "pt_att", "pt_yards", "pt_net_yards",
    "fg_made_0_19", "fg_made_20_29", "fg_made_30_39", "fg_made_40_49", "fg_made_50_59", "fg_made_60_",
    "fg_missed_0_19", "fg_missed_20_29", "fg_missed_30_39", "fg_missed_40_49", "fg_missed_50_59", "fg_missed_60_",
]
FG_LEAGUE = {"0_19": 0.99, "20_29": 0.98, "30_39": 0.94, "40_49": 0.84, "50_59": 0.70, "60_": 0.50}


def load_player_stats(cache, seasons):
    """seasons: [(season, weight)]. Returns gsis_id -> weighted sums."""
    acc = defaultdict(lambda: defaultdict(float))
    for season, w in seasons:
        p = fetch(f"{BASE}/stats_player/stats_player_reg_{season}.csv.gz", cache, 12, required=False)
        if not p:
            continue
        for r in rows(p):
            a = acc[r["player_id"]]
            for c in STAT_COLS:
                v = num(r.get(c))
                if c == "fg_long":
                    a[c] = max(a[c], v)
                else:
                    a[c] += w * v
            a["cpoe_sum"] += w * num(r["passing_cpoe"]) * num(r["attempts"])
    return acc


def load_snaps(cache, seasons):
    acc = defaultdict(lambda: [0.0, 0.0])
    for season, w in seasons:
        p = fetch(f"{BASE}/snap_counts/snap_counts_{season}.csv.gz", cache, 12, required=False)
        if not p:
            continue
        for r in rows(p):
            if r["game_type"] != "REG":
                continue
            a = acc[r["pfr_player_id"]]
            a[0] += w * num(r["offense_snaps"])
            a[1] += w * num(r["defense_snaps"])
    return acc


# ------------------------------------------------------------------ depth charts, rosters, injuries

def load_depth(cache, season):
    path = fetch(f"{BASE}/depth_charts/depth_charts_{season}.csv.gz", cache, 6, required=False)
    if not path:
        return None
    latest = {}
    for r in rows(path):
        if r["team"] not in latest or r["dt"] > latest[r["team"]]:
            latest[r["team"]] = r["dt"]
    return [r for r in rows(path) if r["dt"] == latest[r["team"]]]


def load_roster(cache, season):
    out = {}
    path = fetch(f"{BASE}/rosters/roster_{season}.csv.gz", cache, 12, required=False)
    if path:
        for r in rows(path):
            if r["gsis_id"]:
                out[r["gsis_id"]] = r
    return out


def load_injuries(cache, season):
    """Latest week's report per team that actually has designations."""
    path = fetch(f"{BASE}/injuries/injuries_{season}.csv.gz", cache, 6, required=False)
    if not path:
        return {}
    by_team_week = defaultdict(lambda: defaultdict(list))
    for r in rows(path):
        if r["game_type"] not in ("REG", "") and r["season_type"] != "REG":
            continue
        by_team_week[r["team"]][int(num(r["week"]))].append(r)
    out = {}
    for team, weeks in by_team_week.items():
        for wk in sorted(weeks, reverse=True):
            rep = [x for x in weeks[wk] if x["report_status"]]
            if rep:
                for x in rep:
                    out[x["gsis_id"]] = x["report_status"]
                break
    return out


OFF_MAP = {"QB": "QB", "RB": "RB", "FB": "FB", "WR": "WR", "TE": "TE", "LT": "OL", "LG": "OL", "C": "OL", "RG": "OL", "RT": "OL"}
DEF_43 = {"LDE": "EDGE", "RDE": "EDGE", "LDT": "DL", "RDT": "DL", "NT": "DL", "WLB": "LB", "MLB": "LB", "SLB": "LB", "LILB": "LB", "RILB": "LB",
          "LCB": "CB", "RCB": "CB", "NB": "CB", "FS": "S", "SS": "S"}
DEF_34 = {"LDE": "DL", "RDE": "DL", "LDT": "DL", "RDT": "DL", "NT": "DL", "WLB": "EDGE", "SLB": "EDGE", "LOLB": "EDGE", "ROLB": "EDGE",
          "MLB": "LB", "LILB": "LB", "RILB": "LB", "LCB": "CB", "RCB": "CB", "NB": "CB", "FS": "S", "SS": "S"}
CAPS = {"QB": 2, "RB": 3, "FB": 1, "WR": 5, "TE": 3, "OL": 7, "DL": 4, "EDGE": 4, "LB": 4, "CB": 5, "S": 4, "K": 1, "P": 1}


def build_depth(depth_rows, roster):
    """team -> {pos: [(gsis_id, name, rank, slot)]}, team -> baseFront"""
    out = defaultdict(lambda: defaultdict(list))
    front = {}
    for r in depth_rows:
        team, abb, grp = r["team"], r["pos_abb"], r["pos_grp"]
        if "3-4" in grp:
            front[team] = "34"
        elif "4-3" in grp:
            front.setdefault(team, "43")
        mapping = DEF_34 if "3-4" in grp else DEF_43
        pos = OFF_MAP.get(abb) or (mapping.get(abb) if "D" in grp.split()[-1:] or "Base" in grp else None)
        if abb in ("PK", "K"):
            pos = "K"
        elif abb == "P":
            pos = "P"
        if not pos or not r["gsis_id"]:
            continue
        ros = roster.get(r["gsis_id"])
        if ros and ros["status"] not in ("ACT", "DEV", "INA", ""):
            continue
        out[team][pos].append((r["gsis_id"], r["player_name"], int(num(r["pos_rank"])), int(num(r["pos_slot"]))))
    clean = {}
    for team, d in out.items():
        clean[team] = {}
        taken = set()  # a player appears at one position only
        for pos in CAPS:
            ordered = []
            for item in sorted(d.get(pos, []), key=lambda x: (x[2], x[3])):
                if item[0] not in taken:
                    taken.add(item[0])
                    ordered.append(item)
            clean[team][pos] = ordered[:CAPS[pos]]
    return clean, front


# ------------------------------------------------------------------ ratings

class Z:
    """z-scores of a metric relative to league starters, with shrinkage for small samples."""

    def __init__(self, values, starters, k, min_n):
        # values: pid -> (rate, n)
        qual = [(v, n) for pid, (v, n) in values.items() if pid in starters and n >= min_n and v is not None]
        if len(qual) < 5:
            qual = [(v, n) for pid, (v, n) in values.items() if pid in starters and v is not None]
        tot = sum(n for _, n in qual) or 1
        self.mu = sum(v * n for v, n in qual) / tot if qual else 0.0
        _, self.sd = mean_sd([v for v, _ in qual])
        self.sd = max(self.sd, 1e-6)
        self.k = k
        self.values = values

    def z(self, pid):
        v = self.values.get(pid)
        if not v or v[0] is None:
            return 0.0
        return (shrink(v[0], v[1], self.mu, self.k) - self.mu) / self.sd


def ratio(a, b):
    return a / b if b else None


def hash_jitter(pid, spread):
    h = int(hashlib.md5(pid.encode()).hexdigest()[:6], 16) / 0xFFFFFF
    return (h - 0.5) * 2 * spread


def build_ratings(depth, stats, snaps, roster, team_z):
    """Returns pid -> {pos: ..., r: {...}, ovr: n}."""
    starters = defaultdict(set)
    for team, d in depth.items():
        for pos, lst in d.items():
            n = {"OL": 5, "WR": 3, "TE": 1, "DL": 2, "EDGE": 2, "LB": 3, "CB": 3, "S": 2, "RB": 1, "QB": 1, "K": 1, "P": 1, "FB": 1}[pos]
            for pid, *_ in lst[:n]:
                starters[pos].add(pid)

    def get(pid):
        return stats.get(pid, {})

    def snap(pid, which):
        ros = roster.get(pid)
        s = snaps.get(ros["pfr_id"]) if ros and ros.get("pfr_id") else None
        return s[which] if s else 0.0

    pids = {pid for d in depth.values() for lst in d.values() for pid, *_ in lst}
    # --- QB
    qb = {}
    for pid in pids:
        s = get(pid)
        db = s.get("attempts", 0) + s.get("sacks_suffered", 0)
        if db <= 0:
            continue
        att = max(s["attempts"], 1)
        qb[pid] = {
            "epa": (s["passing_epa"] / db, db), "cpoe": (s["cpoe_sum"] / att, att), "int": (-s["passing_interceptions"] / att, att),
            "sack": (-s["sacks_suffered"] / db, db), "adot": (s["passing_air_yards"] / att, att), "ypa": (s["passing_yards"] / att, att),
            "mob": (s["rushing_yards"] / db, db),
        }
    zq = {m: Z({p: v[m] for p, v in qb.items()}, starters["QB"], k, 60) for m, k in
          (("epa", 140), ("cpoe", 160), ("int", 260), ("sack", 160), ("adot", 200), ("ypa", 160), ("mob", 120))}
    # --- RB / receivers
    rb, rec = {}, {}
    for pid in pids:
        s = get(pid)
        if s.get("carries", 0) > 0:
            rb[pid] = {"epa": (s["rushing_epa"] / s["carries"], s["carries"]), "ypc": (s["rushing_yards"] / s["carries"], s["carries"])}
        if s.get("targets", 0) > 0:
            sn = snap(pid, 0)
            rec[pid] = {
                "tps": (s["targets"] / sn, sn) if sn > 20 else (None, 0), "ypt": (s["receiving_yards"] / s["targets"], s["targets"]),
                "ept": (s["receiving_epa"] / s["targets"], s["targets"]), "catch": (s["receptions"] / s["targets"], s["targets"]),
                "yac": (s["receiving_yards_after_catch"] / max(s["receptions"], 1), s["receptions"]),
            }
    zrb = {m: Z({p: v[m] for p, v in rb.items()}, starters["RB"], k, 40) for m, k in (("epa", 110), ("ypc", 110))}
    zrec = {}
    for grp in ("WR", "TE", "RB"):
        zrec[grp] = {m: Z({p: v[m] for p, v in rec.items() if v[m][0] is not None}, starters[grp], k, 25)
                     for m, k in (("tps", 120), ("ypt", 40), ("ept", 40), ("catch", 40), ("yac", 30))}
    # --- Defense
    de = {}
    for pid in pids:
        sn = snap(pid, 1)
        s = get(pid)
        if sn < 1:
            continue
        de[pid] = {
            "rush": ((s.get("def_sacks", 0) + 0.5 * s.get("def_qb_hits", 0)) / sn, sn),
            "run": ((s.get("def_tackles_for_loss", 0) + 0.2 * s.get("def_tackles_solo", 0)) / sn, sn),
            "cover": ((s.get("def_pass_defended", 0) + 2 * s.get("def_interceptions", 0)) / sn, sn),
            "ball": ((s.get("def_interceptions", 0) + 0.3 * s.get("def_pass_defended", 0)) / sn, sn),
        }
    zde = {}
    for pos in ("DL", "EDGE", "LB", "CB", "S"):
        zde[pos] = {m: Z({p: v[m] for p, v in de.items()}, starters[pos], k, 120)
                    for m, k in (("rush", 260), ("run", 260), ("cover", 300), ("ball", 400))}
    # --- Kickers
    kk, pp = {}, {}
    for pid in pids:
        s = get(pid)
        if s.get("fg_att", 0) > 0:
            exp = made = 0.0
            for b, p in FG_LEAGUE.items():
                m, x = s.get(f"fg_made_{b}", 0), s.get(f"fg_missed_{b}", 0)
                made += m
                exp += (m + x) * p
            kk[pid] = {"acc": ((made - exp) / s["fg_att"], s["fg_att"]), "leg": (s.get("fg_long", 0), 12)}
        if s.get("pt_att", 0) > 0:
            pp[pid] = {"leg": (s["pt_yards"] / s["pt_att"], s["pt_att"])}
    zk = {m: Z({p: v[m] for p, v in kk.items()}, starters["K"], k, 8) for m, k in (("acc", 25), ("leg", 8))}
    zp = Z({p: v["leg"] for p, v in pp.items()}, starters["P"], 25, 15)

    out = {}
    pos_of = {pid: pos for d in depth.values() for pos, lst in d.items() for pid, *_ in lst}
    rank_of = {}
    for d in depth.values():
        for pos, lst in d.items():
            for i, (pid, *_) in enumerate(lst):
                rank_of.setdefault(pid, i)
    for pid, pos in pos_of.items():
        R = {}
        if pos == "QB":
            acc = 0.6 * zq["cpoe"].z(pid) + 0.4 * zq["epa"].z(pid)
            R = {"acc": to_rating(acc), "deep": to_rating(0.35 * zq["adot"].z(pid) + 0.35 * zq["ypa"].z(pid) + 0.3 * zq["epa"].z(pid)),
                 "dec": to_rating(0.65 * zq["int"].z(pid) + 0.35 * zq["epa"].z(pid)),
                 "pocket": to_rating(0.7 * zq["sack"].z(pid) + 0.3 * zq["epa"].z(pid)), "mob": to_rating(zq["mob"].z(pid), 14)}
            ovr = 0.4 * R["acc"] + 0.2 * R["deep"] + 0.2 * R["dec"] + 0.1 * R["pocket"] + 0.1 * R["mob"]
        elif pos in ("RB", "FB"):
            zr = zrb
            zc = zrec["RB"]
            rush = 0.5 * zr["epa"].z(pid) + 0.5 * zr["ypc"].z(pid)
            R = {"rush": to_rating(rush), "catch": to_rating(0.7 * zc["catch"].z(pid) + 0.3 * zc["ept"].z(pid)),
                 "route": to_rating(0.5 * zc["tps"].z(pid) + 0.5 * zc["ypt"].z(pid)), "yac": to_rating(zc["yac"].z(pid)), "pblk": 62, "rblk": 62}
            ovr = 0.6 * R["rush"] + 0.15 * R["catch"] + 0.1 * R["route"] + 0.15 * R["yac"]
        elif pos in ("WR", "TE"):
            zc = zrec[pos]
            R = {"route": to_rating(0.45 * zc["tps"].z(pid) + 0.3 * zc["ypt"].z(pid) + 0.25 * zc["ept"].z(pid)),
                 "catch": to_rating(0.7 * zc["catch"].z(pid) + 0.3 * zc["ept"].z(pid)), "yac": to_rating(zc["yac"].z(pid)),
                 "rblk": 66 if pos == "TE" else 60, "pblk": 62 if pos == "TE" else 55}
            ovr = 0.5 * R["route"] + 0.25 * R["catch"] + 0.25 * R["yac"]
        elif pos == "OL":
            R = {}  # filled from team ratings below
            ovr = 0
        elif pos in ("DL", "EDGE", "LB", "CB", "S"):
            zd = zde[pos]
            if pos in ("DL", "EDGE"):
                R = {"rush": to_rating(zd["rush"].z(pid)), "run": to_rating(zd["run"].z(pid))}
                ovr = (0.6 * R["rush"] + 0.4 * R["run"]) if pos == "EDGE" else (0.45 * R["rush"] + 0.55 * R["run"])
            elif pos == "LB":
                R = {"run": to_rating(zd["run"].z(pid)), "cover": to_rating(zd["cover"].z(pid)), "rush": to_rating(zd["rush"].z(pid))}
                ovr = 0.5 * R["run"] + 0.3 * R["cover"] + 0.2 * R["rush"]
            else:
                R = {"cover": to_rating(zd["cover"].z(pid)), "ball": to_rating(zd["ball"].z(pid)), "run": to_rating(zd["run"].z(pid))}
                ovr = 0.6 * R["cover"] + 0.25 * R["ball"] + 0.15 * R["run"]
        elif pos == "K":
            R = {"kacc": to_rating(zk["acc"].z(pid), 11), "leg": to_rating(zk["leg"].z(pid), 10)}
            ovr = 0.7 * R["kacc"] + 0.3 * R["leg"]
        else:
            R = {"leg": to_rating(zp.z(pid), 11)}
            ovr = R["leg"]
        out[pid] = {"pos": pos, "r": R, "ovr": ovr, "rank": rank_of.get(pid, 0)}
    return out


def apply_team_context(players, depth, team_rates):
    """Blend team-level evidence into players and apply depth penalties. Mutates `players`."""
    for team, d in depth.items():
        t = team_rates[team]
        for pos, lst in d.items():
            for i, (pid, *_ ) in enumerate(lst):
                p = players[pid]
                R = p["r"]
                if pos == "OL":
                    j = hash_jitter(pid, 2.5)
                    R["pblk"] = int(clamp(round(t["pblk"] + j), 40, 99))
                    R["rblk"] = int(clamp(round(t["rblk"] + hash_jitter(pid + "r", 2.5)), 40, 99))
                    p["ovr"] = 0.5 * R["pblk"] + 0.5 * R["rblk"]
                elif pos in ("DL", "EDGE"):
                    R["rush"] = int(clamp(round(0.7 * R["rush"] + 0.3 * t["rush"]), 40, 99))
                    R["run"] = int(clamp(round(0.5 * R["run"] + 0.5 * t["rundef"]), 40, 99))
                elif pos == "LB":
                    R["cover"] = int(clamp(round(0.55 * R["cover"] + 0.45 * t["cover"]), 40, 99))
                    R["run"] = int(clamp(round(0.5 * R["run"] + 0.5 * t["rundef"]), 40, 99))
                    R["rush"] = int(clamp(round(0.7 * R["rush"] + 0.3 * t["rush"]), 40, 99))
                elif pos in ("CB", "S"):
                    R["cover"] = int(clamp(round(0.5 * R["cover"] + 0.5 * t["cover"]), 40, 99))
                    R["run"] = int(clamp(round(0.6 * R["run"] + 0.4 * t["rundef"]), 40, 99))
                # Backups are worse than starters.
                nstart = {"OL": 5, "WR": 3, "TE": 1, "DL": 2, "EDGE": 2, "LB": 3, "CB": 3, "S": 2, "RB": 1, "QB": 1, "K": 1, "P": 1, "FB": 1}[pos]
                if i >= nstart:
                    drop = 4 + 2 * (i - nstart)
                    for k in R:
                        R[k] = int(clamp(R[k] - drop, 40, 99))
                    p["ovr"] -= drop


def team_metrics(teams):
    """Team-level z-scores for blocking, rush, coverage and run defense."""
    vals = {}
    for ab, t in teams.items():
        o, d = t.o, t.d
        vals[ab] = {
            "sack_a": ratio(o["sack"], o["db"]), "hit_a": ratio(o["hit"], o["db"]),
            "run_epa": ratio(o["run_epa"], o["run"]), "run_succ": ratio(o["run_succ"], o["run"]),
            "sack_d": ratio(d["sack"], d["db"]), "hit_d": ratio(d["hit"], d["db"]),
            "pass_epa_d": ratio(d["pass_epa"], d["db"]), "run_epa_d": ratio(d["run_epa"], d["run"]),
            "n_off_db": o["db"], "n_off_run": o["run"], "n_def_db": d["db"], "n_def_run": d["run"],
        }

    def zs(key, nkey, k):
        xs = [v[key] for v in vals.values() if v[key] is not None]
        mu, sd = mean_sd(xs)
        return {ab: (shrink(v[key], v[nkey], mu, k) - mu) / sd for ab, v in vals.items()}

    sack_a, hit_a = zs("sack_a", "n_off_db", 200), zs("hit_a", "n_off_db", 200)
    run_e, run_s = zs("run_epa", "n_off_run", 200), zs("run_succ", "n_off_run", 200)
    sack_d, hit_d = zs("sack_d", "n_def_db", 200), zs("hit_d", "n_def_db", 200)
    pass_d, run_d = zs("pass_epa_d", "n_def_db", 200), zs("run_epa_d", "n_def_run", 200)
    out = {}
    for ab in teams:
        out[ab] = {
            "pblk": to_rating(-(0.6 * sack_a[ab] + 0.4 * hit_a[ab]), 6.5),
            "rblk": to_rating(0.5 * run_e[ab] + 0.5 * run_s[ab], 6.0),
            "rush": to_rating(0.6 * sack_d[ab] + 0.4 * hit_d[ab], 9.0),
            "cover": to_rating(-pass_d[ab], 8.0),
            "rundef": to_rating(-run_d[ab], 8.0),
        }
    return out


# ------------------------------------------------------------------ tendencies

def solve_offset(cells, k=300):
    n = sum(c[1] for c in cells.values())
    if n <= 0:
        return 0.0
    b = 0.0
    for _ in range(12):
        f = sum(c[1] * sigmoid(z + b) for z, c in cells.items()) - sum(c[0] for c in cells.values())
        fp = sum(c[1] * sigmoid(z + b) * (1 - sigmoid(z + b)) for z, c in cells.items())
        if fp < 1e-9:
            break
        b -= f / fp
        b = clamp(b, -1.5, 1.5)
    return b * n / (n + k)


def build_tendencies(teams, fronts):
    league = defaultdict(float)
    for t in teams.values():
        for k, v in t.o.items():
            league["o_" + k] += v
        for k, v in t.d.items():
            league["d_" + k] += v
        for k, v in t.cov.items():
            league["c_" + k] += v
    L = lambda a, b: (league[a] / league[b]) if league[b] else 0.0  # noqa: E731
    lg = {
        "shotgun": L("o_shotgun", "o_plays"), "no_huddle": L("o_no_huddle", "o_plays"), "motion": L("o_motion", "o_ftn_plays"),
        "deep": L("o_deep", "o_air_att"), "pa": L("o_pa", "o_ftn_db"), "screen": L("o_screen", "o_ftn_db"), "blitz": L("d_blitz", "d_ftn_db"),
    }
    cov_tot = sum(league[f"c_{c}"] for c in ("c0", "c1", "c2", "c2m", "c3", "c4", "c6")) or 1
    lg_cov = {c: league[f"c_{c}"] / cov_tot for c in ("c0", "c1", "c2", "c2m", "c3", "c4", "c6")}
    if cov_tot < 100:
        lg_cov = {"c0": 0.04, "c1": 0.22, "c2": 0.13, "c2m": 0.05, "c3": 0.31, "c4": 0.16, "c6": 0.09}
    out = {}
    for ab, t in teams.items():
        o, d = t.o, t.d
        rate = lambda a, n, prior, k: shrink(ratio(a, n), n, prior, k)  # noqa: E731
        deep = rate(o["deep"], o["air_att"], lg["deep"], 150) / lg["deep"] if lg["deep"] else 1
        pa = rate(o["pa"], o["ftn_db"], lg["pa"], 150) / lg["pa"] if lg["pa"] else 1
        sc = rate(o["screen"], o["ftn_db"], lg["screen"], 150) / lg["screen"] if lg["screen"] else 1
        cov_n = sum(t.cov[c] for c in lg_cov)
        mix = {c: round((t.cov[c] + 120 * lg_cov[c]) / (cov_n + 120), 4) for c in lg_cov}
        out[ab] = {
            "off": {
                "proe": round(solve_offset(t.cells), 3), "shotgun": round(rate(o["shotgun"], o["plays"], lg["shotgun"], 200), 3),
                "playAction": round(clamp(pa, 0.5, 1.6), 2), "noHuddle": round(clamp(rate(o["no_huddle"], o["plays"], lg["no_huddle"], 250), 0.01, 0.35), 3),
                "motion": round(rate(o["motion"], o["ftn_plays"], lg["motion"], 200), 3), "deepShot": round(clamp(deep, 0.6, 1.4), 2),
                "screen": round(clamp(sc, 0.5, 1.6), 2),
            },
            "def": {"baseFront": fronts.get(ab, "43"), "blitz": round(clamp(rate(d["blitz"], d["ftn_db"], lg["blitz"], 150), 0.08, 0.45), 3), "coverage": mix},
        }
    return out, lg, lg_cov


# ------------------------------------------------------------------ main

def run_script(script, args):
    subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), script)] + args, check=True, stdout=subprocess.DEVNULL)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cache", default=os.path.join(tempfile.gettempdir(), "cc-nflverse"))
    ap.add_argument("--out", default="public/data")
    ap.add_argument("--engine-data", default="src/engine/data")
    args = ap.parse_args()
    today = datetime.date.today()
    cur = pick_seasons(args.cache, today)
    prev = cur - 1
    log(f"current season {cur}, prior season {prev}")

    # League-wide numbers the engine is tuned against (and the team list with head coaches).
    paths = [fetch(f"{BASE}/pbp/play_by_play_{s}.csv.gz", args.cache, 12, required=(s == cur)) for s in (prev, cur)]
    paths = [p for p in paths if p]
    colors = fetch("https://raw.githubusercontent.com/nflverse/nflfastR-data/master/teams_colors_logos.csv", args.cache, 24)
    eng = args.engine_data
    os.makedirs(eng, exist_ok=True)
    tmp = tempfile.mkdtemp()
    run_script("league_averages.py", [os.path.join(tmp, "targets.json")] + paths)
    run_script("league_tendencies.py", [tmp, colors] + paths)
    model = json.load(open(os.path.join(tmp, "league-tendencies.json")))
    team_info = json.load(open(os.path.join(tmp, "teams.json")))
    if len(team_info) != 32:
        raise RuntimeError(f"expected 32 teams, found {len(team_info)}")
    # Targets file keeps the shape the engine expects.
    shutil.copy(os.path.join(tmp, "targets.json"), os.path.join(tmp, "league-targets.json"))

    # Aggregate play-by-play.
    teams = defaultdict(Team)
    play_def = {}
    coaches = {}
    week = 0
    for s, w in ((cur, CUR_W), (prev, PREV_W)):
        c, wk = aggregate_pbp(args.cache, s, w, teams, model, play_def)
        for ab, (dt, name) in c.items():
            if ab not in coaches or dt > coaches[ab][0]:
                coaches[ab] = (dt, name)
        week = max(week, wk) if s == cur else week
    cov_plays = 0
    for s, w in ((cur, CUR_W), (prev, PREV_W)):
        cov_plays += aggregate_participation(args.cache, s, w, teams, play_def)
    log(f"coverage-labelled plays: {cov_plays}; latest completed week: {week}")

    tendencies, lg, lg_cov = build_tendencies(teams, {})
    team_rates = team_metrics(teams)

    # Rosters, depth charts, injuries.
    depth_rows = load_depth(args.cache, cur) or load_depth(args.cache, prev)
    if not depth_rows:
        raise RuntimeError("no depth chart data")
    roster = load_roster(args.cache, cur)
    roster_prev = load_roster(args.cache, prev)
    for pid, r in roster_prev.items():
        roster.setdefault(pid, r)
    depth, fronts = build_depth(depth_rows, roster)
    for ab in tendencies:
        tendencies[ab]["def"]["baseFront"] = fronts.get(ab, "43")
    injuries = load_injuries(args.cache, cur)

    seasons = [(cur, CUR_W), (prev, PREV_W)]
    stats = load_player_stats(args.cache, seasons)
    snaps = load_snaps(args.cache, seasons)
    players = build_ratings(depth, stats, snaps, roster, team_rates)
    apply_team_context(players, depth, team_rates)

    # Write team files.
    out_dir = args.out
    stage = tempfile.mkdtemp()
    os.makedirs(os.path.join(stage, "teams"))
    manifest_teams = []
    info_by = {t["abbr"]: t for t in team_info}
    problems = []
    for ab in sorted(info_by):
        if ab not in depth:
            problems.append(f"{ab}: no depth chart")
            continue
        d = depth[ab]
        need = {"QB": 1, "RB": 1, "WR": 3, "TE": 1, "OL": 5, "DL": 2, "EDGE": 2, "LB": 2, "CB": 2, "S": 2, "K": 1, "P": 1}
        for pos, n in need.items():
            if len(d.get(pos, [])) < n:
                problems.append(f"{ab}: only {len(d.get(pos, []))} {pos}")
        plist, dchart = [], {}
        for pos in CAPS:
            dchart[pos] = []
            for pid, name, rank, slot in d.get(pos, []):
                p = players[pid]
                ros = roster.get(pid)
                num_ = int(num(ros["jersey_number"])) if ros and ros["jersey_number"] else 0
                entry = {"id": pid, "name": name, "pos": pos, "num": num_, "ovr": int(round(clamp(p["ovr"], 40, 99))), "r": p["r"]}
                if pid in injuries:
                    entry["injury"] = injuries[pid]
                plist.append(entry)
                dchart[pos].append(pid)
        info = dict(info_by[ab])
        team_file = {"info": info, "players": plist, "depth": dchart, "tendencies": tendencies[ab], "source": "nflverse"}
        with open(os.path.join(stage, "teams", f"{ab}.json"), "w") as f:
            json.dump(team_file, f, separators=(",", ":"))
        by = {p["id"]: p for p in plist}
        top = lambda pos, i=0: (by[dchart[pos][i]] if len(dchart.get(pos, [])) > i else None)  # noqa: E731
        head = []
        for label, pos, i in (("QB", "QB", 0), ("RB", "RB", 0), ("WR", "WR", 0), ("WR", "WR", 1), ("TE", "TE", 0), ("EDGE", "EDGE", 0), ("CB", "CB", 0)):
            p = top(pos, i)
            if p:
                head.append({"label": label, "name": p["name"], "ovr": p["ovr"], "injury": p.get("injury")})
        grades = {
            "qb": top("QB")["ovr"] if top("QB") else 70,
            "ol": int(round(sum(by[x]["ovr"] for x in dchart["OL"][:5]) / max(1, len(dchart["OL"][:5])))),
            "pass": int(round(sum(by[x]["ovr"] for x in dchart["WR"][:3] + dchart["TE"][:1]) / max(1, len(dchart["WR"][:3] + dchart["TE"][:1])))),
            "rush": int(round(sum(by[x]["ovr"] for x in dchart["EDGE"][:2] + dchart["DL"][:2]) / max(1, len(dchart["EDGE"][:2] + dchart["DL"][:2])))),
            "cover": int(round(sum(by[x]["ovr"] for x in dchart["CB"][:3] + dchart["S"][:2]) / max(1, len(dchart["CB"][:3] + dchart["S"][:2])))),
        }
        inj = [{"name": p["name"], "pos": p["pos"], "status": p["injury"]} for p in plist if p.get("injury") and p["id"] in dchart.get(p["pos"], [])]
        manifest_teams.append({**info, "headline": head, "grades": grades, "injuries": inj, "baseFront": tendencies[ab]["def"]["baseFront"]})
    if problems:
        raise RuntimeError("data validation failed: " + "; ".join(problems[:12]))
    manifest = {
        "generatedAt": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%MZ"), "season": cur, "week": week,
        "sources": {"pbp": [prev, cur], "coverageSeasons": [s for s in (prev, cur)], "coveragePlays": int(cov_plays)}, "teams": manifest_teams,
    }
    with open(os.path.join(stage, "manifest.json"), "w") as f:
        json.dump(manifest, f, separators=(",", ":"))

    # Everything validated: replace the old data.
    if os.path.exists(out_dir):
        shutil.rmtree(out_dir)
    os.makedirs(os.path.dirname(out_dir) or ".", exist_ok=True)
    shutil.move(stage, out_dir)
    for name in ("league-targets.json", "league-tendencies.json", "teams.json"):
        shutil.copy(os.path.join(tmp, name), os.path.join(eng, name))
    size = sum(os.path.getsize(os.path.join(out_dir, "teams", f)) for f in os.listdir(os.path.join(out_dir, "teams")))
    log(f"wrote {len(manifest_teams)} teams ({size / 1024:.0f} KB total) to {out_dir}")


if __name__ == "__main__":
    main()
