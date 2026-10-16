// The play-vs-defense advantage matrix.
//
// Every call matchup produces an "advantage" score in points (roughly -4..+4).
// Positive favours the offense. The resolver turns points into shifts in
// yards, completion odds, sack odds, turnovers and big plays.
import { CONCEPTS, COVERAGES, FORMATIONS, FRONTS } from './playbook';
import type { Concept, Coverage, DefCall, OffCall, Pressure } from './types';

type Row = Record<Coverage, number>;
const row = (c0: number, c1: number, c2: number, c2m: number, c3: number, c4: number, c6: number): Row => ({ c0, c1, c2, c2m, c3, c4, c6 });

/** Concept vs coverage. Hand-tuned from standard football logic. */
export const COVERAGE_MATRIX: Record<Concept, Row> = {
  //                     c0  c1  c2  c2m  c3  c4  c6
  inside_zone: row(-1, -1, 1, 1, -1, 0, 1),
  outside_zone: row(-1, 0, 1, 1, -1, 0, 1),
  power: row(-1, -1, 1, 1, -1, -1, 0),
  counter: row(0, 0, 1, 1, 0, -1, 0),
  duo: row(-1, -1, 1, 1, -1, 0, 1),
  draw: row(0, 0, 1, 2, 0, 1, 1),
  toss: row(-1, 0, 0, 1, 0, 0, 0),
  qb_sneak: row(0, 0, 0, 0, 0, 0, 0),
  rpo: row(-1, 0, 1, 0, 1, 1, 1),

  slant_flat: row(2, 2, -1, -1, 1, 1, 0),
  stick: row(1, 0, 1, -1, 2, 1, 1),
  mesh: row(2, 2, 0, 1, 1, 0, 0),
  smash: row(0, 0, 2, -1, -1, 1, 1),
  flood: row(0, -1, 1, -1, 2, 1, 1),
  four_verts: row(1, 1, 1, 0, 2, -2, -1),
  curl_flat: row(0, -1, -1, -2, 2, 1, 0),
  dagger: row(0, 1, 0, -1, 2, 1, 1),
  y_cross: row(1, 2, 1, 0, 1, 0, 1),
  rb_screen: row(2, 1, 0, -1, 0, 0, 0),
  wr_screen: row(2, 1, -1, -1, 1, 1, 0),
  pa_shot: row(0, 1, -1, -1, 1, -1, -1),
  hail_mary: row(0, 0, 0, 0, 0, -1, 0),
};

/** How often each coverage is called league-wide (used to center the matrix). */
export const LEAGUE_COVERAGE_MIX: Record<Coverage, number> = { c0: 0.04, c1: 0.22, c2: 0.13, c2m: 0.05, c3: 0.31, c4: 0.16, c6: 0.09 };
const LEAGUE_PRESSURE_MIX: Record<Pressure, number> = { base: 0.76, lb_blitz: 0.1, db_blitz: 0.07, zone_blitz: 0.05, all_out: 0.02 };

// Center each concept's row so an average call against an average defense is
// neutral (0). The concept's own base numbers set its average outcome; the
// matrix only says how much better or worse it does against each look.
for (const c of Object.keys(COVERAGE_MATRIX) as Concept[]) {
  const r = COVERAGE_MATRIX[c];
  const mean = (Object.keys(r) as Coverage[]).reduce((a, k) => a + r[k] * LEAGUE_COVERAGE_MIX[k], 0);
  for (const k of Object.keys(r) as Coverage[]) r[k] = Math.round((r[k] - mean) * 100) / 100;
}

/** Extra effect of the pass rush call by how long the play takes to develop. */
export const PRESSURE_VS_DROP: Record<Pressure, Record<'screen' | 'quick' | 'medium' | 'long' | 'run' | 'draw', number>> = {
  base: { screen: -0.5, quick: 0, medium: 0, long: 0, run: 0, draw: 0 },
  lb_blitz: { screen: 2, quick: 1, medium: -0.3, long: -1, run: 0, draw: 1 },
  db_blitz: { screen: 2, quick: 1, medium: -0.3, long: -1, run: 0, draw: 1 },
  zone_blitz: { screen: 1, quick: -0.5, medium: 0, long: -0.5, run: 0, draw: 0.5 },
  all_out: { screen: 3, quick: 1.5, medium: -0.8, long: -2, run: -0.5, draw: 1 },
};

for (const key of ['screen', 'quick', 'medium', 'long', 'run', 'draw'] as const) {
  const mean = (Object.keys(PRESSURE_VS_DROP) as Pressure[]).reduce((a, p) => a + PRESSURE_VS_DROP[p][key] * LEAGUE_PRESSURE_MIX[p], 0);
  for (const p of Object.keys(PRESSURE_VS_DROP) as Pressure[]) PRESSURE_VS_DROP[p][key] = Math.round((PRESSURE_VS_DROP[p][key] - mean) * 100) / 100;
}

export interface Matchup {
  /** Total advantage points for the offense. */
  adv: number;
  /** Breakdown, shown in debugging and used for narration hints. */
  parts: { coverage: number; pressure: number; box: number; personnel: number; situation: number };
  /** Defenders in the box vs blockers, for run plays and RPO reads. */
  box: number;
  blockers: number;
}

export interface SituationInfo {
  down: number;
  distance: number;
  yardline: number;
  /** League-model pass probability in this spot (how obvious a pass is). */
  xpass: number;
}

export function boxCount(def: DefCall): number {
  const cov = COVERAGES[def.coverage];
  const front = FRONTS[def.front];
  const rolled = cov.deep === 0 ? 2 : cov.deep === 1 ? 1 : 0;
  return front.box + rolled;
}

export function matchup(off: OffCall, def: DefCall, sit: SituationInfo): Matchup {
  const concept = CONCEPTS[off.concept];
  const form = FORMATIONS[off.formation];
  const front = FRONTS[def.front];
  const isRun = concept.kind === 'run';

  const coverage = COVERAGE_MATRIX[off.concept][def.coverage];

  const dropKey = isRun ? (off.concept === 'draw' ? 'draw' : 'run') : concept.pass!.drop;
  const pressure = PRESSURE_VS_DROP[def.pressure][dropKey];

  const box = boxCount(def);
  const blockers = form.blockers + (form.shotgun && isRun ? 0.5 : 0);
  let boxAdv = 0;
  let personnel = 0;
  if (isRun) {
    // Each extra blocker over the box count is worth most of a point.
    boxAdv = (blockers - box) * 0.8;
    if (off.concept === 'qb_sneak') boxAdv *= 0.4;
    if (off.concept === 'rpo') boxAdv = Math.abs(blockers - box) * 0.3; // the read punishes either choice
  } else {
    // Receiving threat vs coverage capacity, centered on 11 personnel vs nickel.
    const threat = form.wr + 0.6 * form.te + 0.3 * form.rb;
    const capacity = front.db + 0.4 * front.lb;
    personnel = (threat - 3.9) - (capacity - 5.8);
  }

  // Situation: play-action works when a run is believable; draws and screens
  // work when the defense is sitting on the pass.
  let situation = 0;
  if (concept.pass?.playAction) situation += sit.xpass < 0.55 ? 1 : sit.xpass > 0.8 ? -1.5 : 0;
  if (off.concept === 'draw' || off.concept === 'rb_screen') situation += sit.xpass > 0.8 ? 1 : 0;
  if (off.concept === 'qb_sneak') situation += sit.distance <= 1 ? 1 : -2;
  if (isRun && sit.distance <= 2 && def.front === 'goalline') situation -= 0.5;
  // Defenses play faster when they know what's coming.
  const quickGame = off.concept === 'draw' || off.concept === 'rb_screen' || off.concept === 'wr_screen';
  if (!isRun && !quickGame) situation -= sit.xpass > 0.85 ? 1 : sit.xpass > 0.7 ? 0.4 : 0;
  if (isRun && off.concept !== 'qb_sneak' && sit.xpass < 0.3) situation -= 0.5;

  const adv = coverage + pressure + boxAdv + personnel + situation;
  return { adv, parts: { coverage, pressure, box: boxAdv, personnel, situation }, box, blockers };
}
