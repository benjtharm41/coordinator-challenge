// Standard analytics logic for 4th downs and 2-point tries, with a short reason.
import { logistic } from './rng';

/** Expected points for 1st & 10 at a given yardline_100 (league-average model). */
const EP_TABLE: [number, number][] = [
  [1, 6.0], [5, 5.2], [10, 4.6], [20, 3.9], [30, 3.2], [40, 2.6], [50, 2.0], [60, 1.5], [70, 0.9], [80, 0.4], [90, -0.3], [99, -0.8],
];
export function expectedPoints(yardline: number): number {
  const y = Math.max(1, Math.min(99, yardline));
  for (let i = 1; i < EP_TABLE.length; i++) {
    const [x1, v1] = EP_TABLE[i];
    if (y <= x1) {
      const [x0, v0] = EP_TABLE[i - 1];
      return v0 + ((v1 - v0) * (y - x0)) / (x1 - x0);
    }
  }
  return -0.8;
}

/** League conversion rate on 4th down by yards to go. */
export function fourthDownConversion(distance: number): number {
  const table: Record<number, number> = { 1: 0.68, 2: 0.6, 3: 0.55, 4: 0.5, 5: 0.46, 6: 0.43, 7: 0.4, 8: 0.37, 9: 0.35, 10: 0.33 };
  if (distance <= 10) return table[Math.max(1, Math.round(distance))];
  return Math.max(0.12, 0.33 - (distance - 10) * 0.02);
}

const KICKOFF_EP = 0.6; // value to the opponent of receiving a kickoff after we score

export interface FourthDownContext {
  yardline: number;
  distance: number;
  /** Positive when we're ahead. */
  scoreDiff: number;
  quarter: number;
  secondsLeftInGame: number;
  secondsLeftInHalf: number;
  fgProb: number;
  netPunt: number;
  ot: boolean;
}

export interface Recommendation<T extends string> {
  choice: T;
  reason: string;
  values?: Record<string, number>;
}

export function recommendFourthDown(c: FourthDownContext): Recommendation<'go' | 'punt' | 'fg'> {
  const conv = fourthDownConversion(c.distance);
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const late = c.quarter >= 4 && c.secondsLeftInGame <= 300;
  const veryLate = c.quarter >= 4 && c.secondsLeftInGame <= 120;
  const fgDistance = c.yardline + 17;

  // Hard game-state overrides first.
  if (late && c.scoreDiff < -8) {
    return { choice: 'go', reason: `You need multiple scores with ${Math.ceil(c.secondsLeftInGame / 60)} min left. Punting is giving up.` };
  }
  if (veryLate && c.scoreDiff < -3) {
    return { choice: 'go', reason: `Down ${-c.scoreDiff} with under 2:00. A field goal doesn't save you, so go for it (${pct(conv)} to convert).` };
  }
  if (veryLate && c.scoreDiff <= 0 && c.scoreDiff >= -3 && c.fgProb > 0.5) {
    return { choice: 'fg', reason: `A ${fgDistance}-yard kick (${pct(c.fgProb)}) ${c.scoreDiff === 0 ? 'takes the lead' : 'ties it'} late.` };
  }
  if (c.secondsLeftInHalf <= 5 && c.fgProb > 0.25) {
    return { choice: 'fg', reason: `Last play of the half. Take the ${pct(c.fgProb)} shot at 3 points.` };
  }

  // Expected points comparison.
  const firstDownSpot = Math.max(1, c.yardline - c.distance - 1.5);
  const tdIfConvert = c.yardline <= c.distance ? 1 : 0;
  const evGo =
    conv * (tdIfConvert ? 7 - KICKOFF_EP : expectedPoints(firstDownSpot)) +
    (1 - conv) * -expectedPoints(100 - c.yardline);
  const puntLanding = Math.min(c.yardline - 10, c.netPunt);
  const evPunt = c.yardline <= 35 ? -99 : -expectedPoints(100 - (c.yardline - puntLanding));
  const evFg = fgDistance > 66 ? -99 : c.fgProb * (3 - KICKOFF_EP) + (1 - c.fgProb) * -expectedPoints(Math.min(80, 100 - (c.yardline + 7)));

  // Protecting a late lead: value field position and points a bit more.
  const protect = late && c.scoreDiff > 0 ? 0.6 : 0;
  const values = { go: evGo - protect, punt: evPunt, fg: evFg };
  const best = (Object.entries(values) as ['go' | 'punt' | 'fg', number][]).sort((a, b) => b[1] - a[1])[0][0];

  let reason: string;
  if (best === 'go') {
    reason = `4th & ${c.distance} converts about ${pct(conv)} of the time. Going for it is worth more than ${evFg > evPunt ? 'the kick' : 'punting'}.`;
  } else if (best === 'fg') {
    reason = `A ${fgDistance}-yard field goal is ${pct(c.fgProb)}. Points beat a ${pct(conv)} gamble here.`;
  } else {
    reason = `4th & ${c.distance} at your ${100 - c.yardline > 50 ? 'side' : 'own ' + (100 - c.yardline)}: only ${pct(conv)} to convert. Flip the field.`;
  }
  return { choice: best, reason, values };
}

export interface TryContext {
  /** Score difference AFTER the touchdown, before the try (positive = we lead). */
  diffAfterTD: number;
  quarter: number;
  secondsLeftInGame: number;
}

export function recommendTry(c: TryContext): Recommendation<'xp' | '2pt'> {
  const d = c.diffAfterTD;
  const secondHalf = c.quarter >= 3;
  if (secondHalf || c.secondsLeftInGame < 1800) {
    // Classic chart, kept to the clearest cases.
    const goFor2: Record<number, string> = {
      [-2]: 'A 2-point try ties the game.',
      [-5]: 'Making it puts you within a field goal (down 3).',
      [-10]: 'Making it gets you to down 8: one touchdown plus 2 ties it.',
      [1]: 'Making it puts you up 3, so a field goal can only tie.',
      [5]: 'Making it puts you up 7: they need a TD just to tie.',
      [-16]: 'Making it gets you to two one-score possessions (down 14).',
      [12]: 'Making it puts you up 14: two scores.',
    };
    if (goFor2[d] && (d < 0 || c.quarter >= 4)) return { choice: '2pt', reason: goFor2[d] };
  }
  return { choice: 'xp', reason: 'Take the near-automatic point (about 95% vs 48% for two).' };
}

/** Rough win probability for display only. */
export function winProbability(scoreDiff: number, secondsLeft: number, yardline: number, hasBall: boolean): number {
  const t = Math.max(1, secondsLeft) / 3600;
  const ep = hasBall ? expectedPoints(yardline) : -expectedPoints(100 - yardline) * 0.5;
  return logistic((scoreDiff + ep * 0.6) / (13.5 * Math.sqrt(t) + 0.5));
}
