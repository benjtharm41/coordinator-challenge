// Special teams: kickoffs, punts, field goals, extra points.
import type { Unit } from './resolve';
import { clamp, logistic, Rng } from './rng';
import type { Player } from './types';

export const KS = {
  touchbackSpot: 35, // 2025+ kickoff rule: touchbacks come out to the 35
  kickoffTouchbackRate: 0.2,
  kickoffReturnMean: 29.2,
  kickoffReturnTD: 0.0025,
  kickoffFumbleLost: 0.004,
  onsideRecovery: 0.12,
  puntGross: 49.6,
  puntBlocked: 0.004,
  puntMuffLost: 0.006,
  puntReturnTD: 0.003,
  puntFairCatch: 0.42,
  fgIntercept: 6.515,
  fgSlope: 0.105,
  fgBlocked: 0.012,
};

export interface KickResult {
  /** New offense's yardline_100 (distance to the end zone they attack). */
  newYardline: number;
  /** Did the kicking team keep or regain the ball? */
  kickingTeamBall: boolean;
  touchdown: boolean;
  touchback: boolean;
  returnYards: number;
  kickDistance: number;
  returner?: Player;
  blocked?: boolean;
  muffed?: boolean;
  fairCatch?: boolean;
  duration: number;
  text: string;
}

export function kickoff(rng: Rng, kicking: Unit, receiving: Unit, onside: boolean, fromOwn = 35): KickResult {
  const returner = receiving.lineup.WR[3] ?? receiving.lineup.RB2;
  if (onside) {
    const recovered = rng.chance(KS.onsideRecovery);
    // Ball recovered around the kicking team's 46.
    return {
      newYardline: recovered ? 54 : 46,
      kickingTeamBall: recovered,
      touchdown: false, touchback: false, returnYards: 0, kickDistance: 11, duration: 3,
      text: recovered ? 'Onside kick RECOVERED by the kicking team!' : 'Onside kick recovered by the return team.',
    };
  }
  // Free kick after a safety (from the 20) goes farther upfield.
  const safetyKick = fromOwn < 30;
  if (!safetyKick && rng.chance(KS.kickoffTouchbackRate * clamp(1 + (kicking.ratings.kLeg - 70) * 0.03, 0.5, 1.6))) {
    return {
      newYardline: 100 - KS.touchbackSpot, kickingTeamBall: false, touchdown: false, touchback: true,
      returnYards: 0, kickDistance: 65, returner, duration: 0, text: `Kickoff for a touchback. Ball at the ${KS.touchbackSpot}.`,
    };
  }
  if (rng.chance(KS.kickoffReturnTD)) {
    return { newYardline: 0, kickingTeamBall: false, touchdown: true, touchback: false, returnYards: 100, kickDistance: 62, returner, duration: 12, text: `${returner.name} takes the kickoff ALL THE WAY BACK for a touchdown!` };
  }
  const mean = safetyKick ? 38 : KS.kickoffReturnMean;
  let start = Math.round(rng.normal(mean, 5.5));
  if (rng.chance(0.03)) start += Math.round(rng.exp(18));
  start = clamp(start, 5, 95);
  if (rng.chance(KS.kickoffFumbleLost)) {
    return { newYardline: start, kickingTeamBall: true, touchdown: false, touchback: false, returnYards: start - 5, kickDistance: 62, returner, muffed: true, duration: 6, text: `${returner.name} FUMBLES the kickoff! Kicking team recovers.` };
  }
  return {
    newYardline: 100 - start, kickingTeamBall: false, touchdown: false, touchback: false,
    returnYards: start - 3, kickDistance: 62, returner, duration: clamp(4 + start * 0.08, 4, 12),
    text: `${returner.name} returns the kickoff to the {spot}.`,
  };
}

/** yardline = punting team's distance from the opponent's end zone. */
export function punt(rng: Rng, kicking: Unit, receiving: Unit, yardline: number): KickResult {
  const returner = receiving.lineup.WR[3] ?? receiving.lineup.CB[2] ?? receiving.lineup.RB2;
  const punter = kicking.lineup.P;
  if (rng.chance(KS.puntBlocked)) {
    const spot = clamp(yardline + rng.int(-5, 8), 1, 99);
    return { newYardline: 100 - spot, kickingTeamBall: false, touchdown: false, touchback: false, returnYards: 0, kickDistance: 0, blocked: true, duration: 4, text: `Punt BLOCKED! Recovered at the ${spot}.` };
  }
  const leg = (kicking.ratings.pLeg - 70) * 0.15;
  let landing: number; // distance from receiving team's goal line
  let gross: number;
  if (yardline - KS.puntGross < 8) {
    // Short field: punter aims to pin them deep.
    landing = Math.round(rng.normal(9, 5.5));
    gross = yardline - landing;
  } else {
    gross = Math.round(rng.normal(KS.puntGross + leg, 5.5));
    landing = yardline - gross;
  }
  if (landing <= 0) {
    // In the end zone: touchback unless it's downed at the goal line.
    if (rng.chance(0.75)) {
      return { newYardline: 80, kickingTeamBall: false, touchdown: false, touchback: true, returnYards: 0, kickDistance: yardline, duration: 6, text: `${punter.name} punt into the end zone for a touchback.` };
    }
    landing = rng.int(1, 4);
    return { newYardline: 100 - landing, kickingTeamBall: false, touchdown: false, touchback: false, returnYards: 0, kickDistance: yardline - landing, duration: 7, text: `${punter.name} punt downed at the ${landing}.` };
  }
  gross = yardline - landing;
  if (rng.chance(KS.puntMuffLost)) {
    return { newYardline: landing, kickingTeamBall: true, touchdown: false, touchback: false, returnYards: 0, kickDistance: gross, returner, muffed: true, duration: 7, text: `MUFFED PUNT! ${returner.name} drops it and the kicking team recovers at the ${landing}.` };
  }
  if (landing < 10 || rng.chance(KS.puntFairCatch)) {
    return { newYardline: 100 - landing, kickingTeamBall: false, touchdown: false, touchback: false, returnYards: 0, kickDistance: gross, returner, fairCatch: true, duration: 7, text: `${punter.name} punts ${gross} yards. Fair catch by ${returner.name} at the ${landing}.` };
  }
  if (rng.chance(KS.puntReturnTD)) {
    return { newYardline: 0, kickingTeamBall: false, touchdown: true, touchback: false, returnYards: 100 - landing, kickDistance: gross, returner, duration: 13, text: `${returner.name} returns the punt for a TOUCHDOWN!` };
  }
  let ret = Math.round(rng.normal(7, 5));
  if (rng.chance(0.04)) ret += Math.round(rng.exp(18));
  ret = clamp(ret, -2, 99 - landing);
  const spot = landing + ret;
  return { newYardline: 100 - spot, kickingTeamBall: false, touchdown: false, touchback: false, returnYards: ret, kickDistance: gross, returner, duration: clamp(7 + ret * 0.1, 7, 14), text: `${punter.name} punts ${gross} yards, returned ${ret} by ${returner.name}.` };
}

export function fieldGoalProb(kicker: Unit, distance: number): number {
  const r = kicker.ratings;
  const maxRange = 58 + (r.kLeg - 70) * 0.35;
  let z = KS.fgIntercept - KS.fgSlope * distance + (r.kAcc - 70) * 0.045;
  if (distance > maxRange) z -= 0.4 * (distance - maxRange);
  return logistic(z);
}

export interface FgResult {
  good: boolean;
  blocked: boolean;
  distance: number;
  text: string;
}

export function fieldGoal(rng: Rng, kicking: Unit, yardline: number): FgResult {
  const distance = yardline + 17;
  const kicker = kicking.lineup.K;
  if (rng.chance(KS.fgBlocked * (distance > 50 ? 1.6 : 1))) return { good: false, blocked: true, distance, text: `${distance}-yard field goal BLOCKED!` };
  const good = rng.chance(fieldGoalProb(kicking, distance));
  return { good, blocked: false, distance, text: `${kicker.name} ${distance}-yard field goal is ${good ? 'GOOD' : rng.pick(['NO GOOD, wide left', 'NO GOOD, wide right', 'NO GOOD, short'])}.` };
}

export function extraPoint(rng: Rng, kicking: Unit): FgResult {
  if (rng.chance(0.004)) return { good: false, blocked: true, distance: 33, text: 'Extra point BLOCKED!' };
  const good = rng.chance(fieldGoalProb(kicking, 33) + 0.006);
  const r = { good, blocked: false, distance: 33, text: '' };
  return { ...r, text: `${kicking.lineup.K.name} extra point is ${r.good ? 'good' : 'NO GOOD'}${r.blocked ? ' (blocked)' : ''}.` };
}
