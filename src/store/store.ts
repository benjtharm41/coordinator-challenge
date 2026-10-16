// Saved progress: games, play-call results and Situations results, kept in the
// browser's storage, with export/import so a backup can be kept as a file.
import type { Game, PlayLog } from '../engine/game';
import type { Outcome, Scenario } from '../engine/scenario';
import { boxScore } from '../engine/stats';
import type { Side } from '../engine/types';

export const SAVE_KEY = 'cc.save.v1';
export const MAX_GAMES = 400;
const KEEP_LOGS = 60;

export interface CallRec {
  /** 'o' = my offensive call, 'd' = my defensive call. */
  s: 'o' | 'd';
  /** Concept id (offense) or coverage id (defense). */
  k: string;
  /** Did it work for me? */
  ok: 0 | 1;
  /** Yards gained by the offense. */
  y: number;
  /** Down-and-distance bucket and field zone. */
  dd: string;
  z: string;
}

export interface BoxSide {
  yards: number;
  pass: number;
  rush: number;
  firstDowns: number;
  turnovers: number;
  penalties: number;
  top: number;
  third: [number, number];
}

export interface GameRecord {
  id: string;
  ts: number;
  mode: 'full' | 'short';
  user: string;
  opp: string;
  home: boolean;
  us: number;
  them: number;
  result: 'W' | 'L' | 'T';
  box: { us: BoxSide; them: BoxSide };
  calls: CallRec[];
  log?: string[];
}

export interface ScenarioRec {
  id: string;
  sid: string;
  ts: number;
  result: 'win' | 'lose' | 'tie';
  metric?: number;
  user: string;
  opp: string;
}

export interface Save {
  version: 1;
  games: GameRecord[];
  scenarios: ScenarioRec[];
}

export const emptySave = (): Save => ({ version: 1, games: [], scenarios: [] });

// ---------------------------------------------------------------- storage

export function loadSave(): Save {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (raw) {
      const parsed = validate(JSON.parse(raw));
      if (parsed) return parsed;
    }
  } catch {
    /* storage unavailable or corrupted */
  }
  return emptySave();
}

/** Returns false if the browser refused (storage full or blocked). */
export function writeSave(save: Save): boolean {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(save));
    return true;
  } catch {
    // Storage full: drop the oldest play-by-play logs and try once more.
    try {
      for (const g of save.games) delete g.log;
      localStorage.setItem(SAVE_KEY, JSON.stringify(save));
      return true;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------- recording

const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export function playSuccess(e: PlayLog): boolean {
  const o = e.outcome;
  if (!o) return false;
  if (o.intercepted || o.fumbleLost || o.type === 'sack') return false;
  if (e.touchdown && e.points?.side === e.offense) return true;
  if (e.firstDown) return true;
  const need = e.down === 1 ? 0.4 * e.distance : e.down === 2 ? 0.6 * e.distance : e.distance;
  return e.yards >= need;
}

export function ddBucket(down: number, distance: number): string {
  if (down === 1) return '1st down';
  if (down === 4) return '4th down';
  const d = distance <= 3 ? 'short' : distance <= 7 ? 'medium' : 'long';
  return `${down === 2 ? '2nd' : '3rd'} & ${d}`;
}

export function zoneBucket(e: PlayLog): string {
  if ((e.quarter === 2 || e.quarter === 4) && e.clock <= 120) return '2-minute drill';
  if (e.yardline <= 5) return 'Goal line';
  if (e.yardline <= 20) return 'Red zone';
  if (e.yardline >= 90) return 'Backed up';
  return 'Open field';
}

/** Turn the user's scrimmage plays in `entries` into call records. */
export function callRecords(entries: PlayLog[], user: Side): CallRec[] {
  const out: CallRec[] = [];
  for (const e of entries) {
    if (!e.outcome || !e.offCall || !e.defCall || !['run', 'pass', 'sack', 'scramble'].includes(e.kind)) continue;
    const ok = playSuccess(e);
    if (e.offense === user) out.push({ s: 'o', k: e.offCall.concept, ok: ok ? 1 : 0, y: Math.round(e.yards), dd: ddBucket(e.down, e.distance), z: zoneBucket(e) });
    else out.push({ s: 'd', k: e.defCall.coverage, ok: ok ? 0 : 1, y: Math.round(e.yards), dd: ddBucket(e.down, e.distance), z: zoneBucket(e) });
  }
  return out;
}

export function boxFor(game: Game, user: Side): { us: BoxSide; them: BoxSide } {
  const b = boxScore(game);
  const conv = (s: Side): BoxSide => {
    const t = b.team[s];
    return {
      yards: t.totalYards, pass: t.passYards, rush: t.rushYards, firstDowns: t.firstDowns, turnovers: t.ints + t.fumblesLost,
      penalties: t.penalties, top: Math.round(t.timeOfPossession), third: [t.thirdConv, t.thirdAtt],
    };
  };
  const other: Side = user === 'home' ? 'away' : 'home';
  return { us: conv(user), them: conv(other) };
}

export function gameRecord(game: Game, user: Side, mode: 'full' | 'short', calls: CallRec[]): GameRecord {
  const opp: Side = user === 'home' ? 'away' : 'home';
  const us = game.sides[user].score;
  const them = game.sides[opp].score;
  return {
    id: uid(), ts: Date.now(), mode, user: game.sides[user].team.info.abbr, opp: game.sides[opp].team.info.abbr, home: user === 'home',
    us, them, result: us > them ? 'W' : us < them ? 'L' : 'T', box: boxFor(game, user), calls,
    log: game.log.filter((e) => e.kind !== 'timeout').map((e) => `${e.quarter > 4 ? 'OT' : 'Q' + e.quarter} ${fmt(e.clock)} ${e.text}`),
  };
}

const fmt = (s: number) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.round(Math.max(0, s)) % 60).padStart(2, '0')}`;

export function addGame(save: Save, rec: GameRecord): Save {
  const games = [...save.games, rec];
  // Keep play-by-play only for the most recent games to save space.
  games.forEach((g, i) => {
    if (i < games.length - KEEP_LOGS) delete g.log;
  });
  return { ...save, games: games.slice(-MAX_GAMES) };
}

export function scenarioRecord(sc: Scenario, outcome: Outcome, user: string, opp: string): ScenarioRec {
  return { id: uid(), sid: sc.id, ts: Date.now(), result: outcome.result, metric: outcome.metric, user, opp };
}

export function addScenario(save: Save, rec: ScenarioRec): Save {
  return { ...save, scenarios: [...save.scenarios, rec].slice(-2000) };
}

// ---------------------------------------------------------------- summaries

export interface Tally {
  n: number;
  ok: number;
  yards: number;
}

export interface Summary {
  games: number;
  w: number;
  l: number;
  t: number;
  pf: number;
  pa: number;
  byTeam: { team: string; w: number; l: number; t: number; pf: number; pa: number }[];
  offConcepts: Record<string, Tally>;
  defCoverages: Record<string, Tally>;
  offSituations: Record<string, Tally>;
  defSituations: Record<string, Tally>;
  scenarios: Record<string, { attempts: number; wins: number; ties: number; best?: number }>;
}

const bump = (m: Record<string, Tally>, k: string, c: CallRec) => {
  const t = (m[k] ??= { n: 0, ok: 0, yards: 0 });
  t.n++;
  t.ok += c.ok;
  t.yards += c.y;
};

export function summarize(save: Save, better: (sid: string) => 'high' | 'low' | undefined): Summary {
  const s: Summary = { games: save.games.length, w: 0, l: 0, t: 0, pf: 0, pa: 0, byTeam: [], offConcepts: {}, defCoverages: {}, offSituations: {}, defSituations: {}, scenarios: {} };
  const teams = new Map<string, { team: string; w: number; l: number; t: number; pf: number; pa: number }>();
  for (const g of save.games) {
    if (g.result === 'W') s.w++;
    else if (g.result === 'L') s.l++;
    else s.t++;
    s.pf += g.us;
    s.pa += g.them;
    const t = teams.get(g.user) ?? { team: g.user, w: 0, l: 0, t: 0, pf: 0, pa: 0 };
    if (g.result === 'W') t.w++;
    else if (g.result === 'L') t.l++;
    else t.t++;
    t.pf += g.us;
    t.pa += g.them;
    teams.set(g.user, t);
    for (const c of g.calls) {
      if (c.s === 'o') {
        bump(s.offConcepts, c.k, c);
        bump(s.offSituations, c.dd, c);
        bump(s.offSituations, c.z, c);
      } else {
        bump(s.defCoverages, c.k, c);
        bump(s.defSituations, c.dd, c);
        bump(s.defSituations, c.z, c);
      }
    }
  }
  s.byTeam = [...teams.values()].sort((a, b) => b.w + b.l + b.t - (a.w + a.l + a.t) || b.w - a.w);
  for (const r of save.scenarios) {
    const e = (s.scenarios[r.sid] ??= { attempts: 0, wins: 0, ties: 0 });
    e.attempts++;
    if (r.result === 'win') e.wins++;
    if (r.result === 'tie') e.ties++;
    if (r.metric !== undefined && r.result !== 'lose') {
      const dir = better(r.sid);
      if (dir && (e.best === undefined || (dir === 'high' ? r.metric > e.best : r.metric < e.best))) e.best = r.metric;
    }
  }
  return s;
}

// ---------------------------------------------------------------- export / import

export function exportJson(save: Save): string {
  return JSON.stringify({ ...save, exportedAt: new Date().toISOString(), app: 'coordinator-challenge' }, null, 1);
}

export function exportFileName(): string {
  return `coordinator-challenge-backup-${new Date().toISOString().slice(0, 10)}.json`;
}

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const isStr = (x: unknown): x is string => typeof x === 'string' && x.length < 400;

/** Checks the shape of untrusted data (a file the user picked). Returns a clean Save or null. */
export function validate(raw: unknown): Save | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r.version !== 1 || !Array.isArray(r.games) || !Array.isArray(r.scenarios)) return null;
  if (r.games.length > 5000 || r.scenarios.length > 20000) return null;
  const games: GameRecord[] = [];
  for (const g of r.games as Record<string, unknown>[]) {
    if (!g || !isStr(g.id) || !isNum(g.ts) || !isStr(g.user) || !isStr(g.opp) || !isNum(g.us) || !isNum(g.them)) return null;
    if (!['W', 'L', 'T'].includes(g.result as string) || !['full', 'short'].includes(g.mode as string)) return null;
    const box = g.box as { us?: BoxSide; them?: BoxSide } | undefined;
    if (!box || !box.us || !box.them || !isNum(box.us.yards) || !isNum(box.them.yards)) return null;
    const calls = Array.isArray(g.calls) ? g.calls : [];
    const cleanCalls: CallRec[] = [];
    for (const c of calls as Record<string, unknown>[]) {
      if (!c || (c.s !== 'o' && c.s !== 'd') || !isStr(c.k) || !isNum(c.y) || !isStr(c.dd) || !isStr(c.z)) return null;
      cleanCalls.push({ s: c.s, k: c.k, ok: c.ok === 1 ? 1 : 0, y: c.y, dd: c.dd, z: c.z });
    }
    const log = Array.isArray(g.log) ? (g.log as unknown[]).filter(isStr).slice(0, 600) : undefined;
    games.push({
      id: g.id, ts: g.ts, mode: g.mode as 'full' | 'short', user: g.user, opp: g.opp, home: !!g.home, us: g.us, them: g.them,
      result: g.result as 'W' | 'L' | 'T', box: { us: box.us, them: box.them }, calls: cleanCalls, log,
    });
  }
  const scenarios: ScenarioRec[] = [];
  for (const s of r.scenarios as Record<string, unknown>[]) {
    if (!s || !isStr(s.id) || !isStr(s.sid) || !isNum(s.ts) || !['win', 'lose', 'tie'].includes(s.result as string) || !isStr(s.user) || !isStr(s.opp)) return null;
    scenarios.push({ id: s.id, sid: s.sid, ts: s.ts, result: s.result as 'win' | 'lose' | 'tie', metric: isNum(s.metric) ? s.metric : undefined, user: s.user, opp: s.opp });
  }
  return { version: 1, games, scenarios };
}

/** Combine a backup with what is already saved (no duplicates), or replace it. */
export function importJson(text: string, current: Save, mode: 'merge' | 'replace'): { save: Save; added: number } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { error: 'That file is not a backup from this game (it could not be read).' };
  }
  const incoming = validate(parsed);
  if (!incoming) return { error: 'That file does not look like a Coordinator Challenge backup, so nothing was changed.' };
  if (mode === 'replace') return { save: incoming, added: incoming.games.length + incoming.scenarios.length };
  const gameIds = new Set(current.games.map((g) => g.id));
  const scIds = new Set(current.scenarios.map((s) => s.id));
  const newGames = incoming.games.filter((g) => !gameIds.has(g.id));
  const newSc = incoming.scenarios.filter((s) => !scIds.has(s.id));
  const games = [...current.games, ...newGames].sort((a, b) => a.ts - b.ts).slice(-MAX_GAMES);
  const scenarios = [...current.scenarios, ...newSc].sort((a, b) => a.ts - b.ts).slice(-2000);
  return { save: { version: 1, games, scenarios }, added: newGames.length + newSc.length };
}
