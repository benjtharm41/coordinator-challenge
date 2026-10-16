// Computer play-caller. Samples calls from the league model plus each team's
// own tendencies, with situational logic and some variety.
import leagueModel from './data/league-tendencies.json';
import { recommendFourthDown, recommendTry } from './analytics';
import { COVERAGE_MATRIX, PRESSURE_VS_DROP } from './matchup';
import { CONCEPTS, FORMATIONS, pressuresFor } from './playbook';
import { clamp, logistic, Rng } from './rng';
import type { Concept, Coverage, DefCall, Formation, Front, OffCall, OffChoice, Pressure, Team, Tempo } from './types';

/** Everything a play-caller can see before the snap, from the offense's point of view. */
export interface Situation {
  down: number;
  distance: number;
  yardline: number;
  /** Offense score minus defense score. */
  scoreDiff: number;
  quarter: number;
  clock: number;
  secondsLeftHalf: number;
  secondsLeftGame: number;
  offTimeouts: number;
  defTimeouts: number;
  clockRunning: boolean;
  ot: boolean;
  fgProb: number;
  netPunt: number;
}

const distBucket = (d: number) => (d <= 1 ? '1' : d <= 3 ? '2-3' : d <= 6 ? '4-6' : d <= 9 ? '7-9' : d === 10 ? '10' : '11+');
const fieldBucket = (y: number) => (y >= 90 ? 'backed_up' : y > 20 ? 'open' : y > 10 ? 'red_zone' : 'goal_line');
const scoreBucket = (s: number) =>
  s <= -17 ? 'down17+' : s <= -9 ? 'down9-16' : s <= -1 ? 'down1-8' : s === 0 ? 'tied' : s <= 8 ? 'up1-8' : s <= 16 ? 'up9-16' : 'up17+';
const timeBucket = (s: Situation) =>
  s.secondsLeftHalf <= 120 ? 'two_min' : s.quarter >= 4 && s.secondsLeftGame <= 600 ? 'q4_late' : 'normal';

/** League-average probability that the offense drops back to pass here. */
export function leagueXPass(s: Situation): number {
  const m = leagueModel as unknown as { downDistance: Record<string, number>; field: Record<string, number>; scoreTime: Record<string, number> };
  const z =
    (m.downDistance[`${s.down}:${distBucket(s.distance)}`] ?? 0) +
    (m.field[fieldBucket(s.yardline)] ?? 0) +
    (m.scoreTime[`${scoreBucket(s.scoreDiff)}|${timeBucket(s)}`] ?? 0);
  return logistic(z);
}

export const isTwoMinute = (s: Situation) =>
  (s.quarter === 2 && s.secondsLeftHalf <= 120) || ((s.quarter >= 4 || s.ot) && s.secondsLeftGame <= 120 && s.scoreDiff <= 0);

export function chooseTempo(s: Situation, team: Team, rng: Rng): Tempo {
  const late = s.quarter >= 4 && !s.ot;
  if (late && s.scoreDiff > 0 && s.secondsLeftGame <= 360) return 'milk';
  if (late && s.scoreDiff < 0 && s.secondsLeftGame <= 180) return 'hurry';
  if (late && s.scoreDiff <= -9 && s.secondsLeftGame <= 420) return 'hurry';
  if (s.quarter === 2 && s.secondsLeftHalf <= 100 && s.yardline <= 75) return 'hurry';
  return rng.chance(team.tendencies.off.noHuddle * 0.3) ? 'hurry' : 'normal';
}

const PASS_CONCEPTS: Concept[] = ['slant_flat', 'stick', 'mesh', 'smash', 'flood', 'four_verts', 'curl_flat', 'dagger', 'y_cross', 'rb_screen', 'wr_screen', 'pa_shot'];
const RUN_CONCEPTS: Concept[] = ['inside_zone', 'outside_zone', 'power', 'counter', 'duo', 'draw', 'toss', 'rpo', 'qb_sneak'];
const DEEP = new Set<Concept>(['four_verts', 'dagger', 'y_cross', 'flood', 'smash', 'pa_shot']);
const QUICK = new Set<Concept>(['slant_flat', 'stick', 'mesh', 'wr_screen', 'rb_screen']);
const SIDELINE = new Set<Concept>(['smash', 'flood', 'curl_flat', 'slant_flat']);

function conceptWeights(s: Situation, team: Team, isPass: boolean, formation: Formation): [Concept, number][] {
  const avail = new Set(FORMATIONS[formation].concepts);
  const t = team.tendencies.off;
  const xp = leagueXPass(s);
  const out: [Concept, number][] = [];
  if (isPass) {
    const base: Partial<Record<Concept, number>> = {
      slant_flat: 1, stick: 1, mesh: 0.8, smash: 0.8, flood: 0.8, four_verts: 0.45, curl_flat: 0.8, dagger: 0.7, y_cross: 0.7,
      rb_screen: 0.4 * t.screen, wr_screen: 0.4 * t.screen, pa_shot: 2.2 * t.playAction,
    };
    for (const c of PASS_CONCEPTS) {
      if (!avail.has(c)) continue;
      let w = base[c] ?? 0;
      if (DEEP.has(c)) w *= t.deepShot;
      if (s.distance >= 10 && s.down >= 2) w *= DEEP.has(c) ? 2 : QUICK.has(c) ? 0.6 : 1;
      if (s.distance <= 4) w *= QUICK.has(c) ? 1.8 : DEEP.has(c) ? 0.5 : 1;
      if (isTwoMinute(s)) w *= SIDELINE.has(c) ? 1.6 : c === 'rb_screen' ? 0.4 : 1;
      if (s.yardline <= 20) w *= c === 'four_verts' ? 0.3 : c === 'pa_shot' ? 0.6 : QUICK.has(c) ? 1.3 : 1;
      if (c === 'pa_shot') w *= xp < 0.55 ? 1.4 : xp > 0.8 ? 0.15 : 0.7;
      out.push([c, w]);
    }
  } else {
    const base: Partial<Record<Concept, number>> = {
      inside_zone: 1.2, outside_zone: 1, power: 0.8, counter: 0.6, duo: 0.7, draw: 0.45, toss: 0.4, rpo: 0.7, qb_sneak: 0,
    };
    for (const c of RUN_CONCEPTS) {
      if (!avail.has(c)) continue;
      let w = base[c] ?? 0;
      if (c === 'qb_sneak' && s.distance <= 1) w = s.down >= 3 ? 2.2 : 0.6;
      if (c === 'draw' && s.distance >= 8) w *= 2.5;
      if (s.distance <= 2 && (c === 'power' || c === 'duo')) w *= 1.6;
      if (s.yardline <= 5 && (c === 'toss' || c === 'outside_zone')) w *= 0.6;
      out.push([c, w]);
    }
  }
  return out;
}

function formationWeights(s: Situation, team: Team, isPass: boolean): [Formation, number][] {
  const gun = team.tendencies.off.shotgun;
  const shortYard = s.distance <= 1 && (s.down >= 3 || s.yardline <= 2);
  if (!isPass && shortYard) {
    return s.yardline <= 3
      ? [['goalline', 0.45], ['heavy', 0.3], ['iform', 0.15], ['singleback', 0.1]]
      : [['heavy', 0.35], ['iform', 0.3], ['singleback', 0.2], ['shotgun', 0.1], ['goalline', 0.05]];
  }
  if (isPass) {
    const g = clamp(gun + 0.2, 0.4, 0.97);
    const longYd = s.distance >= 8 && s.down >= 3;
    return [
      ['shotgun', 0.38 * g], ['trips', 0.25 * g], ['bunch', 0.1 * g], ['empty', (longYd ? 0.2 : 0.07) * g], ['pistol', 0.06 * g],
      ['singleback', 0.6 * (1 - g)], ['iform', 0.25 * (1 - g)], ['heavy', 0.15 * (1 - g)],
    ];
  }
  const g = clamp(gun - 0.25, 0.1, 0.9);
  return [
    ['shotgun', 0.5 * g], ['pistol', 0.25 * g], ['trips', 0.25 * g],
    ['singleback', 0.5 * (1 - g)], ['iform', 0.3 * (1 - g)], ['heavy', 0.2 * (1 - g)],
  ];
}

export interface CallMemory {
  recent: Concept[];
}

/** What a side has called recently: the opponent's coordinator scouts this and adjusts. */
export interface ScoutReport {
  concepts: Concept[];
  coverages: Coverage[];
  pressures: Pressure[];
}

export const newScout = (): ScoutReport => ({ concepts: [], coverages: [], pressures: [] });
export const SCOUT_WINDOW = 12;

export function recordScout(r: ScoutReport, off?: Concept, def?: { coverage: Coverage; pressure: Pressure }) {
  const push = <T>(list: T[], x: T) => {
    list.unshift(x);
    if (list.length > SCOUT_WINDOW) list.pop();
  };
  if (off) push(r.concepts, off);
  if (def) {
    push(r.coverages, def.coverage);
    push(r.pressures, def.pressure);
  }
}

const freq = <T extends string>(list: T[]): [T, number][] => {
  const m = new Map<T, number>();
  for (const x of list) m.set(x, (m.get(x) ?? 0) + 1);
  return [...m.entries()].map(([k, v]) => [k, v / list.length]);
};
/** Adjustments ramp up as the scouting sample grows. */
const SCOUT_STRENGTH = 1.6;
const ramp = (n: number) => SCOUT_STRENGTH * Math.min(1, n / SCOUT_WINDOW);
const dropOf = (c: Concept) => {
  const d = CONCEPTS[c];
  return d.kind === 'run' ? (c === 'draw' ? 'draw' : 'run') : d.pass!.drop;
};

export function chooseOffensePlay(s: Situation, team: Team, rng: Rng, memory?: CallMemory, scout?: ScoutReport): OffCall {
  const pPass = clamp(logistic(Math.log(leagueXPass(s) / (1 - leagueXPass(s))) + team.tendencies.off.proe), 0.03, 0.98);
  for (let attempt = 0; attempt < 5; attempt++) {
    const isPass = rng.chance(pPass);
    const formation = rng.weighted(formationWeights(s, team, isPass));
    let weights = conceptWeights(s, team, isPass, formation);
    if (memory) weights = weights.map(([c, w]) => [c, memory.recent.includes(c) ? w * 0.45 : w]);
    if (scout && scout.coverages.length) {
      // Lean toward plays that beat what this defense keeps calling.
      const k = ramp(scout.coverages.length);
      const covs = freq(scout.coverages);
      const prs = freq(scout.pressures);
      weights = weights.map(([c, w]) => {
        const edge = covs.reduce((a, [cv, f]) => a + f * COVERAGE_MATRIX[c][cv], 0) + prs.reduce((a, [p, f]) => a + f * PRESSURE_VS_DROP[p][dropOf(c)], 0);
        return [c, w * Math.exp(k * edge)];
      });
    }
    if (weights.some(([, w]) => w > 0)) {
      const concept = rng.weighted(weights);
      memory?.recent.unshift(concept);
      if (memory && memory.recent.length > 3) memory.recent.pop();
      return { formation, concept };
    }
  }
  return { formation: 'shotgun', concept: 'slant_flat' };
}

/** Full offensive decision including clock management and 4th downs. */
export function chooseOffense(s: Situation, team: Team, rng: Rng, memory?: CallMemory, scout?: ScoutReport): OffChoice {
  const endOfHalf = s.secondsLeftHalf;
  const late = s.quarter >= 4 || s.ot;

  // Victory formation.
  const downsLeft = 4 - s.down + 1;
  if (late && !s.ot && s.scoreDiff > 0 && s.secondsLeftGame <= Math.max(0, downsLeft - s.defTimeouts) * 40 + 2) return { type: 'kneel' };
  if (s.quarter === 2 && endOfHalf <= 30 && s.yardline >= 70 && s.yardline <= 97 && s.down < 4) return { type: 'kneel' };

  // Last-second field goal.
  const needFg = s.quarter === 2 || (late && s.scoreDiff >= -3 && s.scoreDiff <= 0);
  if (needFg && endOfHalf <= 6 && s.fgProb > 0.25) return { type: 'fg' };

  // Spike to stop the clock with no timeouts left.
  if (isTwoMinute(s) && s.clockRunning && s.offTimeouts === 0 && s.down < 4 && endOfHalf <= 35 && endOfHalf > 8) {
    if (rng.chance(0.7)) return { type: 'spike' };
  }

  // Hail Mary.
  if (endOfHalf <= 6 && s.yardline >= 36 && s.yardline <= 62 && (s.quarter === 2 || (late && s.scoreDiff < 0 && s.scoreDiff >= -8))) {
    return { type: 'play', call: { formation: 'shotgun', concept: 'hail_mary' }, tempo: 'normal' };
  }

  if (s.down === 4) {
    const rec = recommendFourthDown({
      yardline: s.yardline, distance: s.distance, scoreDiff: s.scoreDiff, quarter: s.quarter,
      secondsLeftInGame: s.secondsLeftGame, secondsLeftInHalf: s.secondsLeftHalf, fgProb: s.fgProb, netPunt: s.netPunt, ot: s.ot,
    });
    let choice = rec.choice;
    // Real coaches are a bit more conservative than the model in the first half.
    if (choice === 'go' && s.distance >= 2 && s.quarter <= 3 && rng.chance(0.45)) choice = s.fgProb > 0.55 ? 'fg' : s.yardline > 38 ? 'punt' : 'go';
    // ...and much more conservative in their own territory.
    const desperate = s.quarter >= 4 && s.scoreDiff < 0 && s.secondsLeftGame <= 420;
    if (choice === 'go' && s.yardline > 50 && !desperate && rng.chance(0.45)) choice = 'punt';
    if (choice === 'punt') return { type: 'punt' };
    if (choice === 'fg') return { type: 'fg' };
  }

  return { type: 'play', call: chooseOffensePlay(s, team, rng, memory, scout), tempo: chooseTempo(s, team, rng) };
}

// ---------------- Defense ----------------

function frontWeights(s: Situation, team: Team, offFormation: Formation): [Front, number][] {
  const f = FORMATIONS[offFormation];
  const base = team.tendencies.def.baseFront;
  const passDown = s.down >= 3 && s.distance >= 7;
  if (offFormation === 'goalline' || (s.yardline <= 3 && f.wr <= 1)) return [['goalline', 0.8], [base, 0.2]];
  if (s.distance <= 1 && f.wr <= 1) return [['goalline', 0.35], [base, 0.65]];
  if (f.wr >= 4) return [['dime', 0.65], ['nickel', 0.35]];
  if (f.wr === 3) return passDown ? [['dime', 0.55], ['nickel', 0.45]] : [['nickel', 0.82], ['dime', 0.06], [base, 0.12]];
  if (f.wr === 2) return passDown ? [['nickel', 0.7], ['dime', 0.3]] : [[base, 0.7], ['nickel', 0.3]];
  return [[base, 0.85], ['nickel', 0.15]];
}

function coverageWeights(s: Situation, team: Team): [Coverage, number][] {
  const mix = team.tendencies.def.coverage;
  const passDown = s.down >= 3 && s.distance >= 7;
  const twoMin = isTwoMinute(s);
  return (Object.keys(mix) as Coverage[]).map((c) => {
    let w = mix[c];
    if (passDown) w *= c === 'c2' || c === 'c4' || c === 'c6' ? 1.4 : c === 'c0' ? 0.6 : 1;
    if (s.yardline <= 10) w *= c === 'c0' || c === 'c1' || c === 'c2m' ? 1.6 : c === 'c4' ? 0.5 : 1;
    if (twoMin) w *= c === 'c4' || c === 'c2' || c === 'c6' ? 1.6 : c === 'c0' ? 0.3 : 1;
    if (s.secondsLeftHalf <= 8 && s.yardline >= 30) w *= c === 'c4' ? 8 : c === 'c0' ? 0 : 1;
    return [c, w];
  });
}

function pressureWeights(s: Situation, team: Team, coverage: Coverage): [Pressure, number][] {
  let blitz = team.tendencies.def.blitz;
  if (s.down === 3 && s.distance >= 4 && s.distance <= 9) blitz *= 1.35;
  if (isTwoMinute(s)) blitz *= 0.7;
  if (s.secondsLeftHalf <= 8 && s.yardline >= 30) blitz *= 0.3;
  const allowed = pressuresFor(coverage);
  const w: Record<Pressure, number> = {
    base: 1 - blitz,
    lb_blitz: blitz * 0.42,
    db_blitz: blitz * 0.3,
    zone_blitz: blitz * 0.2,
    all_out: blitz * (coverage === 'c0' ? 0.6 : 0.08),
  };
  return allowed.map((p) => [p, w[p]]);
}

export function chooseDefense(s: Situation, team: Team, offFormation: Formation, rng: Rng, scout?: ScoutReport): DefCall {
  const front = rng.weighted(frontWeights(s, team, offFormation));
  let covW = coverageWeights(s, team);
  const concepts = scout && scout.concepts.length ? freq(scout.concepts) : [];
  const k = scout ? ramp(scout.concepts.length) : 0;
  if (concepts.length) {
    // Lean toward coverages that stop what this offense keeps calling.
    covW = covW.map(([cv, w]) => [cv, w * Math.exp(-k * concepts.reduce((a, [c, f]) => a + f * COVERAGE_MATRIX[c][cv], 0))]);
  }
  const coverage = rng.weighted(covW);
  let prW = pressureWeights(s, team, coverage);
  if (concepts.length) {
    prW = prW.map(([p, w]) => [p, w * Math.exp(-k * concepts.reduce((a, [c, f]) => a + f * PRESSURE_VS_DROP[p][dropOf(c)], 0))]);
  }
  const pressure = rng.weighted(prW);
  return { front, coverage, pressure };
}

// ---------------- Other decisions ----------------

export function chooseTry(diffAfterTD: number, quarter: number, secondsLeftInGame: number): 'xp' | '2pt' {
  return recommendTry({ diffAfterTD, quarter, secondsLeftInGame }).choice;
}

export function chooseTwoPointPlay(team: Team, rng: Rng): OffCall {
  const s: Situation = {
    down: 4, distance: 2, yardline: 2, scoreDiff: 0, quarter: 1, clock: 900, secondsLeftHalf: 1800, secondsLeftGame: 3600,
    offTimeouts: 3, defTimeouts: 3, clockRunning: false, ot: false, fgProb: 1, netPunt: 40,
  };
  // Teams throw on about 60% of 2-point tries.
  const isPass = rng.chance(0.6);
  const formation = rng.weighted(isPass ? [['shotgun', 0.5], ['trips', 0.25], ['bunch', 0.25]] as [Formation, number][] : [['shotgun', 0.4], ['singleback', 0.3], ['heavy', 0.3]] as [Formation, number][]);
  const concept = rng.weighted(conceptWeights(s, team, isPass, formation).filter(([c]) => c !== 'qb_sneak'));
  return { formation, concept };
}

export function wantsOnside(scoreDiff: number, quarter: number, secondsLeftGame: number): boolean {
  if (quarter < 4) return false;
  return (scoreDiff < 0 && secondsLeftGame <= 120) || (scoreDiff <= -9 && secondsLeftGame <= 300);
}

/** Should the CPU burn a timeout before this snap? side = 'off' or 'def' from the CPU's view. */
export function wantsTimeout(s: Situation, cpuIs: 'off' | 'def'): boolean {
  if (!s.clockRunning) return false;
  if (cpuIs === 'def') {
    // Opponent has the ball and is running clock while we need it back.
    if (s.defTimeouts <= 0) return false;
    const cpuDiff = -s.scoreDiff;
    if ((s.quarter >= 4 || s.ot) && cpuDiff <= 0 && s.secondsLeftGame <= 140) return true;
    if (s.quarter >= 4 && cpuDiff < 0 && cpuDiff >= -16 && s.secondsLeftGame <= 240 && s.secondsLeftGame > 140 && s.defTimeouts >= 3) return false;
    if (s.quarter === 2 && s.secondsLeftHalf <= 60 && s.yardline >= 55 && s.down >= 3) return true;
    return false;
  }
  if (s.offTimeouts <= 0) return false;
  if (isTwoMinute(s) && s.secondsLeftHalf <= 100) return s.offTimeouts > 1 || s.secondsLeftHalf <= 40;
  return false;
}

// ---------------- Quick picks for the human ----------------

export function quickPicksOffense(s: Situation, team: Team): OffCall[] {
  const rng = new Rng(s.down * 1000 + s.distance * 37 + s.yardline);
  const picks: OffCall[] = [];
  const seen = new Set<string>();
  const add = (c: OffCall) => {
    const key = c.concept;
    if (!seen.has(key) && FORMATIONS[c.formation].concepts.includes(c.concept)) {
      seen.add(key);
      picks.push(c);
    }
  };
  const xp = leagueXPass(s);
  const order = xp > 0.75 ? [true, true, true, false] : xp < 0.4 ? [false, false, true, true] : [false, true, true, false];
  for (const isPass of order) {
    for (let i = 0; i < 6; i++) {
      const formation = rng.weighted(formationWeights(s, team, isPass));
      const w = conceptWeights(s, team, isPass, formation).filter(([c]) => !seen.has(c));
      if (!w.length) continue;
      const best = w.sort((a, b) => b[1] - a[1])[rng.int(0, Math.min(1, w.length - 1))][0];
      add({ formation, concept: best });
      break;
    }
  }
  return picks.slice(0, 4);
}

export function quickPicksDefense(s: Situation, team: Team, offFormation: Formation): DefCall[] {
  const f = FORMATIONS[offFormation];
  const fronts = frontWeights(s, team, offFormation).sort((a, b) => b[1] - a[1]);
  const front = fronts[0][0];
  const passDown = s.down >= 3 && s.distance >= 7;
  const runLikely = leagueXPass(s) < 0.4 || f.wr <= 1;
  const list: DefCall[] = [];
  if (runLikely) {
    list.push({ front, coverage: 'c3', pressure: 'base' });
    list.push({ front, coverage: 'c1', pressure: 'lb_blitz' });
    list.push({ front: f.wr <= 1 && s.yardline <= 5 ? 'goalline' : front, coverage: 'c0', pressure: 'all_out' });
    list.push({ front, coverage: 'c4', pressure: 'base' });
  } else if (passDown) {
    list.push({ front, coverage: 'c4', pressure: 'base' });
    list.push({ front, coverage: 'c2m', pressure: 'base' });
    list.push({ front, coverage: 'c1', pressure: 'db_blitz' });
    list.push({ front, coverage: 'c3', pressure: 'zone_blitz' });
  } else {
    list.push({ front, coverage: 'c3', pressure: 'base' });
    list.push({ front, coverage: 'c6', pressure: 'base' });
    list.push({ front, coverage: 'c1', pressure: 'lb_blitz' });
    list.push({ front, coverage: 'c2', pressure: 'base' });
  }
  return list;
}

export const conceptName = (c: Concept) => CONCEPTS[c].name;
