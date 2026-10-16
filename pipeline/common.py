"""Download and read helpers for the nflverse data pipeline (standard library only)."""

import csv
import gzip
import io
import os
import sys
import time
import urllib.error
import urllib.request

BASE = "https://github.com/nflverse/nflverse-data/releases/download"
csv.field_size_limit(50_000_000)


def log(msg):
    print(msg, file=sys.stderr, flush=True)


def fetch(url, cache_dir, max_age_hours=0, required=True):
    """Download url into cache_dir and return the local path (None if missing and not required).

    A cached copy younger than max_age_hours is reused (handy when developing).
    """
    os.makedirs(cache_dir, exist_ok=True)
    path = os.path.join(cache_dir, os.path.basename(url))
    if max_age_hours and os.path.exists(path) and time.time() - os.path.getmtime(path) < max_age_hours * 3600:
        return path
    last = None
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "coordinator-challenge-data/1.0"})
            with urllib.request.urlopen(req, timeout=120) as r, open(path + ".part", "wb") as f:
                while True:
                    chunk = r.read(1 << 20)
                    if not chunk:
                        break
                    f.write(chunk)
            os.replace(path + ".part", path)
            log(f"downloaded {os.path.basename(url)} ({os.path.getsize(path) / 1e6:.1f} MB)")
            return path
        except urllib.error.HTTPError as e:
            if e.code == 404:
                if required:
                    raise RuntimeError(f"required file not found: {url}")
                log(f"not available: {os.path.basename(url)}")
                return None
            last = e
        except Exception as e:  # network hiccup
            last = e
        time.sleep(2 + attempt * 3)
    if required:
        raise RuntimeError(f"could not download {url}: {last}")
    return None


def rows(path):
    """Iterate rows of a .csv or .csv.gz file as dicts."""
    opener = gzip.open if path.endswith(".gz") else open
    with opener(path, "rt", newline="", encoding="utf-8") as f:
        yield from csv.DictReader(f)


def num(v, default=0.0):
    if v is None or v == "" or v == "NA":
        return default
    try:
        return float(v)
    except ValueError:
        return default


def flag(row, col):
    return num(row.get(col)) == 1.0


def is_true(v):
    return str(v).strip().upper() in ("TRUE", "1", "1.0", "T")


def mean_sd(values):
    values = list(values)
    if not values:
        return 0.0, 1.0
    m = sum(values) / len(values)
    var = sum((x - m) ** 2 for x in values) / max(1, len(values) - 1)
    return m, max(var ** 0.5, 1e-9)


def clamp(x, lo, hi):
    return max(lo, min(hi, x))


__all__ = ["BASE", "fetch", "rows", "num", "flag", "is_true", "mean_sd", "clamp", "log", "io"]
