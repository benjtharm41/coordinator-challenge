// Resolves one scrimmage play. Order of influence:
//   1. the matchup of the two calls (advantage matrix)
//   2. player ratings
//   3. controlled randomness
// The outcome is decided here, before any animation.
import { CONCEPTS, FORMATIONS, type RouteTarget, type Slot } from './playbook';
import { matchup, type Matchup, type SituationInfo } from './matchup';
import type { Lineup, UnitRatings } from './ratings';
import { clamp, logistic, logit, Rng } from './rng';
import type { DefCall, OffCall, Player } from './types';

/** Tunable constants. The calibration script tunes these against real NFL averages. */
export const K = {
  // Passing
  sackBase: 0.066,
  sackDrop: { screen: 0.2, quick: 0.55, medium: 1.0, long: 1.5 } as Record<string, number>,
  sackPressure: { base: 0.85, lb_blitz: 1.35, db_blitz: 1.4, zone_blitz: 1.2, all_out: 2.0 } as Record<string, number>,
  scrambleBase: 0.06,
  compShift: -0.01, // logit shift on top of the depth curve
  intScale: 0.78,
  yacScale: 1.0,
  yacBreak: 0.055,
  // Running
  runMeanShift: 0.25,
  runStuffScale: 0.86,
  runBreakScale: 1.3,
  // Turnovers
  runFumbleLost: 0.0072,
  catchFumbleLost: 0.005,
  sackFumbleLost: 0.05,
  // Advantage -> effect strength
  advRunMean: 0.45,
  advRunStuff: 0.22,
  advRunBreak: 0.2,
  advComp: 0.13,
  advSack: 0.12,
  advInt: 0.18,
  advYac: 0.35,
  // Penalties (per play)
  pen: {
    falseStart: 0.022,
    delay: 0.006,
    offside: 0.0105,
    holdingOff: 0.024,
    holdingDef: 0.017,
    dpi: 0.115,
    roughPasser: 0.0055,
    personalFoul: 0.012,
  },
};

export type PenaltyName =
  | 'False Start'
  | 'Delay of Game'
  | 'Defensive Offside'
  | 'Offensive Holding'
  | 'Defensive Holding'
  | 'Pass Interference'
  | 'Roughing the Passer'
  | 'Unnecessary Roughness'
  | 'Face Mask';

export interface Penalty {
  name: PenaltyName;
  on: 'off' | 'def';
  yards: number;
  autoFirst: boolean;
  presnap: boolean;
  /** Spot fouls (pass interference): yards past the line of scrimmage. */
  spot?: number;
  /** Personal fouls are added to the end of the play rather than replacing it. */
  addOn?: boolean;
  player?: Player;
}

export interface ScrimmageOutcome {
  type: 'run' | 'pass' | 'sack' | 'scramble' | 'none';
  yards: number;
  complete?: boolean;
  intercepted?: boolean;
  fumbleLost?: boolean;
  /** Yards the defense returns a turnover (toward the offense's end zone). */
  returnYards?: number;
  airYards?: number;
  yac?: number;
  route?: string;
  slot?: Slot;
  passer?: Player;
  carrier?: Player;
  target?: Player;
  defender?: Player;
  outOfBounds: boolean;
  duration: number;
  penalty?: Penalty;
  rpo?: 'run' | 'pass';
  bigPlay?: boolean;
  touchback?: boolean;
  matchup: Matchup;
}

export interface Unit {
  lineup: Lineup;
  ratings: UnitRatings;
}

/** NFL completion rate by air yards (2023-25 shape), before adjustments. */
const COMP_CURVE: [number, number][] = [
  [-5, 0.86], [0, 0.8], [5, 0.74], [10, 0.63], [15, 0.53], [20, 0.42], [30, 0.31], [45, 0.2], [60, 0.1],
];
/** Interception odds on a non-completion by air yards. */
const INT_CURVE: [number, number][] = [
  [-5, 0.012], [0, 0.03], [5, 0.05], [10, 0.065], [20, 0.085], [30, 0.1], [45, 0.12],
];
const interp = (curve: [number, number][], x: number) => {
  if (x <= curve[0][0]) return curve[0][1];
  for (let i = 1; i < curve.length; i++) {
    const [x1, y1] = curve[i];
    if (x <= x1) {
      const [x0, y0] = curve[i - 1];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return curve[curve.length - 1][1];
};

const r70 = (x: number) => x - 70;

/** 0 outside the 10, rising to ~1 at the 1-2 yard line. */
const goalLineSqueeze = (yardline: number) => (yardline <= 10 ? clamp((14 - yardline) / 10, 0.5, 1.1) : 0);

function slotPlayer(l: Lineup, slot: Slot, formationWr: number): Player {
  switch (slot) {
    case 'WR1':
      return l.WR[0];
    case 'WR2':
      return l.WR[1] ?? l.WR[0];
    case 'WR3':
      // In 2-WR sets the "slot" receiver is the TE2 or the RB.
      return formationWr >= 3 ? l.WR[2] ?? l.WR[0] : l.TE[1] ?? l.TE[0] ?? l.WR[1];
    case 'TE':
      return l.TE[0] ?? l.WR[2] ?? l.WR[0];
    case 'RB':
      return l.RB;
  }
}

function pickDefender(rng: Rng, l: Lineup, kind: 'sack' | 'sack_blitz' | 'int' | 'run' | 'stuff' | 'short' | 'deep'): Player {
  const pool: [Player[], number][] = {
    sack: [[l.EDGE, 0.6], [l.DL, 0.28], [l.LB, 0.12]],
    sack_blitz: [[l.EDGE, 0.4], [l.DL, 0.15], [l.LB, 0.3], [[...l.S, ...l.CB.slice(2)], 0.15]],
    int: [[l.CB, 0.55], [l.S, 0.35], [l.LB, 0.1]],
    run: [[l.LB, 0.45], [[...l.DL, ...l.EDGE], 0.25], [l.S, 0.2], [l.CB, 0.1]],
    stuff: [[[...l.DL, ...l.EDGE], 0.55], [l.LB, 0.4], [l.S, 0.05]],
    short: [[l.LB, 0.4], [l.CB, 0.4], [l.S, 0.2]],
    deep: [[l.CB, 0.5], [l.S, 0.5]],
  }[kind] as [Player[], number][];
  const group = rng.weighted(pool.filter(([g]) => g.length > 0));
  return rng.pick(group);
}

function rollPenalty(rng: Rng, kind: 'run' | 'pass', o: Unit, d: Unit, enabled: boolean): Penalty | undefined {
  if (!enabled) return undefined;
  const p = K.pen;
  const ol = () => rng.pick(o.lineup.OL);
  if (rng.chance(p.falseStart)) return { name: 'False Start', on: 'off', yards: 5, autoFirst: false, presnap: true, player: ol() };
  if (rng.chance(p.offside)) return { name: 'Defensive Offside', on: 'def', yards: 5, autoFirst: false, presnap: true, player: rng.pick([...d.lineup.EDGE, ...d.lineup.DL]) };
  if (rng.chance(p.holdingOff)) return { name: 'Offensive Holding', on: 'off', yards: 10, autoFirst: false, presnap: false, player: ol() };
  if (kind === 'pass' && rng.chance(p.holdingDef)) return { name: 'Defensive Holding', on: 'def', yards: 5, autoFirst: true, presnap: false, player: rng.pick(d.lineup.CB) };
  if (kind === 'pass' && rng.chance(p.roughPasser)) return { name: 'Roughing the Passer', on: 'def', yards: 15, autoFirst: true, presnap: false, addOn: true, player: rng.pick(d.lineup.EDGE) };
  if (rng.chance(p.personalFoul)) {
    const onDef = rng.chance(0.78);
    const name = rng.chance(0.6) ? 'Unnecessary Roughness' : 'Face Mask';
    const player = onDef ? pickDefender(rng, d.lineup, 'run') : rng.pick(o.lineup.OL);
    return { name, on: onDef ? 'def' : 'off', yards: 15, autoFirst: onDef, presnap: false, addOn: true, player };
  }
  return undefined;
}

export interface ResolveInput {
  off: OffCall;
  def: DefCall;
  o: Unit;
  d: Unit;
  sit: SituationInfo;
  penalties: boolean;
  rng: Rng;
  /** Hurry-up offenses don't commit delay of game. */
  hurry?: boolean;
}

export function resolveScrimmage(input: ResolveInput): ScrimmageOutcome {
  const { off, def, o, d, sit, rng } = input;
  const m = matchup(off, def, sit);
  const concept = CONCEPTS[off.concept];

  // Delay of game is checked before anything else (not in hurry-up).
  if (input.penalties && !input.hurry && rng.chance(K.pen.delay)) {
    return { type: 'none', yards: 0, outOfBounds: false, duration: 0, matchup: m, penalty: { name: 'Delay of Game', on: 'off', yards: 5, autoFirst: false, presnap: true, player: o.lineup.QB } };
  }

  let outcome: ScrimmageOutcome;
  if (off.concept === 'rpo') {
    // QB reads the box: pass if it's loaded, hand off if it's light. Good QBs read it right more often.
    const loaded = m.box >= m.blockers;
    const rightRead = rng.chance(0.65 + r70(o.ratings.qbDec) * 0.006);
    const throwIt = loaded === rightRead;
    outcome = throwIt ? resolvePass(input, m, true) : resolveRun(input, m, true);
    outcome.rpo = throwIt ? 'pass' : 'run';
  } else if (concept.kind === 'run') {
    outcome = resolveRun(input, m, false);
  } else {
    outcome = resolvePass(input, m, false);
  }

  if (!outcome.penalty) {
    const pen = rollPenalty(rng, outcome.type === 'run' ? 'run' : 'pass', o, d, input.penalties);
    if (pen) {
      if (pen.presnap) {
        return { type: 'none', yards: 0, outOfBounds: false, duration: 0, matchup: m, penalty: pen };
      }
      outcome.penalty = pen;
    }
  }
  return outcome;
}

function resolveRun(input: ResolveInput, m: Matchup, rpo: boolean): ScrimmageOutcome {
  const { off, def, o, d, sit, rng } = input;
  const conceptId = rpo ? 'inside_zone' : off.concept;
  const rd = CONCEPTS[conceptId].run!;
  const isSneak = conceptId === 'qb_sneak';
  const qbDraw = off.concept === 'draw' && FORMATIONS[off.formation].rb === 0;
  const carrier = isSneak || qbDraw ? o.lineup.QB : rng.chance(0.75) ? o.lineup.RB : o.lineup.RB2;

  const ratingAdv = r70(isSneak ? 70 : carrier.r.rush ?? carrier.ovr) * 0.035 + (o.ratings.runBlock - d.ratings.runDef) * 0.06;
  let adv = m.adv + ratingAdv + (rpo ? 0.5 : 0);
  if (sit.distance <= 2 && (conceptId === 'power' || conceptId === 'duo')) adv += 0.5;
  const blitz = def.pressure !== 'base';
  // Near the goal line there's no room: more stuffs, shorter gains.
  const tight = goalLineSqueeze(sit.yardline);
  const pStuff = clamp(rd.stuff * K.runStuffScale * Math.exp(-K.advRunStuff * adv) * (blitz ? 1.15 : 1) * (1 + 0.9 * tight), 0.02, 0.6);
  const pBreak = clamp(rd.breakaway * K.runBreakScale * Math.exp(K.advRunBreak * adv) * (blitz ? 1.15 : 1), 0.004, 0.35);

  let yards: number;
  let bigPlay = false;
  let defender: Player;
  if (rng.chance(pStuff)) {
    yards = rng.weighted([[0, 0.4], [-1, 0.27], [-2, 0.17], [-3, 0.1], [-4, 0.06]]);
    defender = pickDefender(rng, d.lineup, 'stuff');
  } else {
    yards = Math.max(1, Math.round(rng.normal(rd.mean + K.runMeanShift + K.advRunMean * adv - tight * 1.6, rd.sd)));
    if (isSneak) yards = Math.min(yards, 1 + Math.floor(rng.exp(1.2)));
    if (rng.chance(pBreak)) {
      yards += Math.round(4 + rng.exp(12));
      bigPlay = true;
    }
    defender = pickDefender(rng, d.lineup, yards > 12 ? 'deep' : 'run');
  }
  const td = yards >= sit.yardline;
  yards = Math.min(yards, sit.yardline);
  const fumbleLost = !td && rng.chance(K.runFumbleLost * Math.exp(-r70(carrier.r.rush ?? carrier.ovr) * 0.01));
  return {
    type: 'run',
    yards,
    carrier,
    defender,
    fumbleLost,
    returnYards: fumbleLost ? Math.max(0, Math.round(rng.chance(0.06) ? rng.exp(35) : rng.exp(3))) : undefined,
    outOfBounds: !td && rng.chance(rd.oob),
    duration: clamp(4 + Math.abs(yards) * 0.12 + rng.range(0, 1.5), 3, 12),
    bigPlay,
    matchup: m,
  };
}

function resolvePass(input: ResolveInput, m: Matchup, rpo: boolean): ScrimmageOutcome {
  const { off, def, o, d, sit, rng } = input;
  const concept = CONCEPTS[off.concept];
  const pd = rpo
    ? { drop: 'quick' as const, targets: [{ slot: 'WR1' as Slot, route: 'slant', depth: 5, weight: 0.5, oob: 0.03 }, { slot: 'WR3' as Slot, route: 'bubble', depth: -1, weight: 0.5, oob: 0.2 }] }
    : concept.pass!;
  const passer = o.lineup.QB;
  const form = FORMATIONS[off.formation];
  const isHail = off.concept === 'hail_mary';

  // 1) Protection: sack?
  let sackP = K.sackBase * K.sackDrop[pd.drop] * K.sackPressure[def.pressure];
  if (sit.xpass > 0.85) sackP *= 1.25;
  sackP *= Math.exp((d.ratings.passRush - o.ratings.passBlock) * 0.028 - r70(o.ratings.qbPocket) * 0.015 - K.advSack * m.parts.coverage);
  if (rpo) sackP *= 0.15;
  sackP = clamp(sackP, 0.003, 0.5);
  if (rng.chance(sackP)) {
    const yards = -clamp(Math.round(rng.normal(6.5, 2.5)), 1, 15);
    const lost = rng.chance(K.sackFumbleLost);
    return {
      type: 'sack',
      yards: Math.max(yards, sit.yardline - 100), // can't go past the back of the end zone
      passer,
      defender: pickDefender(rng, d.lineup, def.pressure === 'base' ? 'sack' : 'sack_blitz'),
      fumbleLost: lost,
      returnYards: lost ? Math.round(rng.chance(0.08) ? rng.exp(25) : rng.exp(2)) : undefined,
      outOfBounds: false,
      duration: rng.range(4.5, 7),
      matchup: m,
    };
  }

  // 2) Scramble: more likely vs man coverage and for mobile QBs.
  if (!rpo && !isHail && pd.drop !== 'screen') {
    let scrP = K.scrambleBase * Math.exp(r70(o.ratings.qbMob) * 0.04);
    if (def.coverage === 'c0' || def.coverage === 'c1' || def.coverage === 'c2m') scrP *= 1.35;
    if (pd.drop === 'quick') scrP *= 0.6;
    if (def.pressure !== 'base') scrP *= 1.15;
    if (rng.chance(scrP)) {
      let yards = Math.round(rng.normal(4.8 + r70(o.ratings.qbMob) * 0.05, 3.5));
      if (rng.chance(0.07)) yards += Math.round(5 + rng.exp(9));
      yards = clamp(yards, -2, sit.yardline);
      return { type: 'scramble', yards, passer, carrier: passer, defender: pickDefender(rng, d.lineup, 'short'), outOfBounds: rng.chance(0.35), duration: clamp(5 + yards * 0.12, 4, 12), matchup: m };
    }
  }

  // 3) The throw: pick a target. QBs lean toward their better receivers.
  const targets = pd.targets.map((tg: RouteTarget) => {
    const p = slotPlayer(o.lineup, tg.slot, form.wr);
    const q = (p.r.route ?? p.ovr) - 70;
    return { tg, p, w: tg.weight * Math.exp(q * 0.02) };
  });
  const pick = rng.weighted(targets.map((x) => [x, x.w] as const));
  const target = pick.p;
  const tg = pick.tg;

  if (isHail) return resolveHailMary(input, m, target, tg);

  let air = Math.round(tg.depth + rng.normal(0, 1.2 + Math.max(0, tg.depth) * 0.12));
  if (tg.depth < 0) air = Math.min(air, 0);
  // Red zone: the end zone is only 10 yards deep.
  let squeezed = false;
  const maxAir = sit.yardline + 9;
  if (air > maxAir) {
    air = maxAir - rng.int(0, 3);
    squeezed = true;
  }

  const qbSkill = air > 15 ? o.ratings.qbDeep * 0.6 + o.ratings.qbAcc * 0.4 : o.ratings.qbAcc;
  let z = logit(interp(COMP_CURVE, air)) + K.compShift;
  z += K.advComp * m.adv;
  z += r70(qbSkill) * 0.02 + r70(target.r.route ?? target.ovr) * 0.012 + r70(target.r.catch ?? target.ovr) * 0.008;
  z -= r70(d.ratings.coverage) * 0.018;
  if (sit.yardline <= 20 && pd.drop !== 'screen') z -= 0.3 + 0.6 * goalLineSqueeze(sit.yardline);
  // Money downs: defenders sit on the sticks.
  const moneyDown = sit.down >= 3 && sit.distance >= 3;
  if (moneyDown) z -= 0.2;
  if (squeezed) z -= 0.3;
  if (rpo) z += 0.3;
  const compP = clamp(logistic(z), 0.05, 0.96);

  const duration = clamp(4.5 + Math.max(0, air) * 0.08 + rng.range(0, 2), 3, 10);

  if (!rng.chance(compP)) {
    // Incomplete or intercepted.
    let intP = interp(INT_CURVE, air) * K.intScale;
    intP *= Math.exp(-r70(o.ratings.qbDec) * 0.03 + r70(d.ratings.ballSkills) * 0.02 - K.advInt * m.adv);
    if (def.pressure === 'zone_blitz') intP *= 1.2;
    if (rng.chance(clamp(intP, 0.002, 0.4))) {
      const catchSpot = sit.yardline - air;
      const inEndZone = catchSpot <= 0;
      const touchback = inEndZone && rng.chance(0.7);
      const ret = touchback ? 0 : Math.max(0, Math.round(rng.chance(0.09) ? rng.exp(40) : rng.normal(8, 9)));
      return {
        type: 'pass', yards: 0, complete: false, intercepted: true, returnYards: ret, touchback,
        airYards: air, route: tg.route, slot: tg.slot, passer, target,
        defender: pickDefender(rng, d.lineup, 'int'), outOfBounds: false, duration, matchup: m,
      };
    }
    // Pass interference on downfield incompletions.
    let penalty: Penalty | undefined;
    if (input.penalties && air >= 8 && rng.chance(K.pen.dpi)) {
      penalty = { name: 'Pass Interference', on: 'def', yards: Math.max(1, air), spot: Math.max(1, air), autoFirst: true, presnap: false, player: pickDefender(rng, d.lineup, 'deep') };
    }
    return { type: 'pass', yards: 0, complete: false, airYards: air, route: tg.route, slot: tg.slot, passer, target, defender: pickDefender(rng, d.lineup, air > 12 ? 'deep' : 'short'), outOfBounds: false, duration, penalty, matchup: m };
  }

  // Completion: yards after catch.
  const yacMean = (tg.depth < 1 ? 6.2 : air <= 5 ? 4.6 : air <= 15 ? 3.6 : 3.4) - (moneyDown && air < sit.distance ? 1.2 : 0);
  let yac = Math.max(0, Math.round(rng.normal((yacMean + K.advYac * m.adv) * K.yacScale + r70(target.r.yac ?? target.ovr) * 0.05 - r70(d.ratings.tackling) * 0.04, 2.5)));
  let breakP = K.yacBreak * Math.exp(0.15 * m.adv + r70(target.r.yac ?? target.ovr) * 0.02);
  if (def.pressure === 'all_out') breakP *= 1.8;
  if (def.coverage === 'c0') breakP *= 1.4;
  let bigPlay = false;
  if (rng.chance(clamp(breakP, 0.005, 0.4))) {
    yac += Math.round(5 + rng.exp(14));
    bigPlay = true;
  }
  let yards = air + yac;
  const td = yards >= sit.yardline;
  if (td) {
    yards = sit.yardline;
    yac = yards - air;
  }
  if (yards >= 20) bigPlay = true;
  const fumbleLost = !td && rng.chance(K.catchFumbleLost);
  return {
    type: 'pass', yards, complete: true, airYards: air, yac, route: tg.route, slot: tg.slot, passer, target,
    defender: pickDefender(rng, d.lineup, yards > 15 ? 'deep' : 'short'),
    fumbleLost, returnYards: fumbleLost ? Math.round(rng.exp(4)) : undefined,
    outOfBounds: !td && rng.chance(tg.oob), duration: duration + Math.min(6, yac * 0.12), bigPlay, matchup: m,
  };
}

function resolveHailMary(input: ResolveInput, m: Matchup, target: Player, tg: RouteTarget): ScrimmageOutcome {
  const { o, d, sit, rng } = input;
  const passer = o.lineup.QB;
  const maxThrow = 56 + r70(o.ratings.qbDeep) * 0.3;
  const aim = Math.round(Math.min(sit.yardline + 4, maxThrow));
  const pCatch = clamp(0.1 + m.adv * 0.02 + r70(target.r.catch ?? target.ovr) * 0.003 - r70(d.ratings.coverage) * 0.003, 0.03, 0.25);
  const base = { route: tg.route, slot: tg.slot, passer, target, airYards: aim, outOfBounds: false, duration: 8, matchup: m };
  const roll = rng.next();
  if (roll < pCatch) {
    const yards = Math.min(aim, sit.yardline);
    return { ...base, type: 'pass', yards, complete: true, yac: 0, bigPlay: true, defender: pickDefender(rng, d.lineup, 'deep') };
  }
  if (roll < pCatch + 0.1) {
    return { ...base, type: 'pass', yards: 0, complete: false, intercepted: true, returnYards: Math.round(rng.exp(6)), touchback: false, defender: pickDefender(rng, d.lineup, 'int') };
  }
  return { ...base, type: 'pass', yards: 0, complete: false, defender: pickDefender(rng, d.lineup, 'deep') };
}
