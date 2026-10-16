// Tools for automated exploit / sanity testing (used by tests and scripts/exploits.ts).
import { chooseDefense, chooseOffensePlay, type Situation } from './ai';
import { Game } from './game';
import type { Outcome, Scenario } from './scenario';
import { LEAGUE_COVERAGE_MIX } from './matchup';
import { placeholderTeam, TEAM_INFO } from './placeholder';
import { CONCEPTS, FORMATIONS } from './playbook';
import { buildLineup, unitRatings } from './ratings';
import { resolveScrimmage } from './resolve';
import { Rng } from './rng';
import type { Concept, DefCall, Formation, OffCall, PlayerRatings, Team } from './types';

/** A league-average team: every player rated 70, league-average tendencies. */
export function averageTeam(abbr: string): Team {
  const base = placeholderTeam(TEAM_INFO.find((t) => t.abbr === abbr) ?? TEAM_INFO[0]);
  const players = base.players.map((p) => {
    const r: PlayerRatings = {};
    for (const k of Object.keys(p.r) as (keyof PlayerRatings)[]) r[k] = 70;
    return { ...p, ovr: 70, r };
  });
  return {
    ...base,
    players,
    tendencies: {
      off: { proe: 0, shotgun: 0.65, playAction: 1, noHuddle: 0.09, motion: 0.45, deepShot: 1, screen: 1 },
      def: { baseFront: '43', blitz: 0.24, coverage: { ...LEAGUE_COVERAGE_MIX } },
    },
  };
}

export interface Policy {
  /** Home team always calls this on offense (4th downs / clock decisions stay automatic). */
  offense?: OffCall;
  /** Home team always calls this on defense. */
  defense?: DefCall;
}

export interface MatchResult {
  homeScore: number;
  awayScore: number;
  winner: 'home' | 'away' | 'tie';
}

/** Play one full game where the home team follows a fixed policy. */
export function playWithPolicy(home: Team, away: Team, policy: Policy, seed: number): MatchResult {
  const g = new Game(home, away, { home: 'cpu', away: 'cpu' }, { seed });
  for (let i = 0; i < 5000 && g.s.phase !== 'final'; i++) {
    const d = g.pending();
    if (d.kind !== 'snap') {
      g.cpuAct();
      continue;
    }
    g.cpuTimeouts();
    let choice = g.cpuOffenseChoice();
    if (d.offense === 'home' && policy.offense && choice.type === 'play' && choice.call.concept !== 'hail_mary') {
      choice = { ...choice, call: policy.offense };
    }
    const def = d.defense === 'home' && policy.defense ? policy.defense : undefined;
    g.snap(choice, def);
  }
  return { homeScore: g.sides.home.score, awayScore: g.sides.away.score, winner: g.s.winner ?? 'tie' };
}

export interface PolicySummary {
  games: number;
  winPct: number;
  pointsFor: number;
  pointsAgainst: number;
}

export function summarizePolicy(policy: Policy, games: number, seed = 1): PolicySummary {
  const home = averageTeam('KC');
  const away = averageTeam('BUF');
  const rng = new Rng(seed);
  let w = 0;
  let pf = 0;
  let pa = 0;
  for (let i = 0; i < games; i++) {
    const r = playWithPolicy(home, away, policy, rng.int(1, 2 ** 31));
    w += r.winner === 'home' ? 1 : r.winner === 'tie' ? 0.5 : 0;
    pf += r.homeScore;
    pa += r.awayScore;
  }
  return { games, winPct: w / games, pointsFor: pf / games, pointsAgainst: pa / games };
}

const FORMATION_PREFERENCE: Formation[] = ['shotgun', 'singleback', 'trips', 'iform', 'pistol', 'bunch', 'empty', 'heavy', 'goalline'];
export function formationFor(c: Concept): Formation {
  return FORMATION_PREFERENCE.find((f) => FORMATIONS[f].concepts.includes(c))!;
}

export const SPAM_CONCEPTS = (Object.keys(CONCEPTS) as Concept[]).filter((c) => c !== 'hail_mary');

export const SPAM_DEFENSES: DefCall[] = [
  { front: 'nickel', coverage: 'c0', pressure: 'all_out' },
  { front: 'nickel', coverage: 'c1', pressure: 'base' },
  { front: 'nickel', coverage: 'c1', pressure: 'lb_blitz' },
  { front: 'nickel', coverage: 'c2', pressure: 'base' },
  { front: 'nickel', coverage: 'c2m', pressure: 'base' },
  { front: 'nickel', coverage: 'c3', pressure: 'base' },
  { front: 'nickel', coverage: 'c3', pressure: 'zone_blitz' },
  { front: 'nickel', coverage: 'c4', pressure: 'base' },
  { front: 'nickel', coverage: 'c6', pressure: 'base' },
  { front: '43', coverage: 'c3', pressure: 'base' },
  { front: 'dime', coverage: 'c4', pressure: 'base' },
  { front: 'goalline', coverage: 'c1', pressure: 'lb_blitz' },
];

// ---------- Per-concept outcome ranges ----------

export interface ConceptProfile {
  concept: Concept;
  plays: number;
  avgYards: number;
  negativePct: number;
  tenPlusPct: number;
  twentyPlusPct: number;
  maxYards: number;
  compPct: number | null;
  intPct: number | null;
  sackPct: number | null;
  /** For QB sneak (3rd & 1) and Hail Mary (TD), the share of successes. */
  successPct: number;
}

export function profileConcept(concept: Concept, plays = 3000, seed = 3): ConceptProfile {
  const rng = new Rng(seed);
  const off = averageTeam('KC');
  const def = averageTeam('BUF');
  const oLine = buildLineup(off);
  const dLine = buildLineup(def);
  const o = { lineup: oLine, ratings: unitRatings(oLine) };
  const d = { lineup: dLine, ratings: unitRatings(dLine) };
  const isSneak = concept === 'qb_sneak';
  const isHail = concept === 'hail_mary';
  const sit = isSneak ? { down: 3, distance: 1, yardline: 50, xpass: 0.21 } : isHail ? { down: 1, distance: 10, yardline: 45, xpass: 0.99 } : { down: 1, distance: 10, yardline: 65, xpass: 0.47 };
  const aiSit: Situation = {
    down: sit.down, distance: sit.distance, yardline: sit.yardline, scoreDiff: 0, quarter: isHail ? 2 : 1, clock: isHail ? 3 : 800,
    secondsLeftHalf: isHail ? 3 : 1700, secondsLeftGame: isHail ? 1803 : 3500, offTimeouts: 3, defTimeouts: 3, clockRunning: false, ot: false, fgProb: 0.5, netPunt: 42,
  };
  const call: OffCall = { formation: formationFor(concept), concept };
  let n = 0, yards = 0, neg = 0, ten = 0, twenty = 0, max = -99, att = 0, comp = 0, ints = 0, sacks = 0, success = 0, dropbacks = 0;
  for (let i = 0; i < plays; i++) {
    const dc = chooseDefense(aiSit, def, call.formation, rng);
    const out = resolveScrimmage({ off: call, def: dc, o, d, sit, penalties: false, rng });
    n++;
    yards += out.yards;
    if (out.yards < 0) neg++;
    if (out.yards >= 10) ten++;
    if (out.yards >= 20) twenty++;
    max = Math.max(max, out.yards);
    if (out.type !== 'run') dropbacks++;
    if (out.type === 'sack') sacks++;
    if (out.type === 'pass') {
      att++;
      if (out.complete) comp++;
      if (out.intercepted) ints++;
    }
    if (isSneak && out.yards >= 1 && !out.fumbleLost) success++;
    if (isHail && out.complete && out.yards >= sit.yardline) success++;
  }
  const isPass = CONCEPTS[concept].kind === 'pass';
  return {
    concept, plays: n, avgYards: yards / n, negativePct: neg / n, tenPlusPct: ten / n, twentyPlusPct: twenty / n, maxYards: max,
    compPct: isPass && att ? comp / att : null, intPct: isPass && att ? ints / att : null, sackPct: isPass && dropbacks ? sacks / dropbacks : null,
    successPct: success / n,
  };
}

// ---------- Final score sanity ----------

export interface ScoreSanity {
  games: number;
  avgTeamPoints: number;
  avgCombined: number;
  maxTeamPoints: number;
  pctTeamScoresOver45: number;
  shutoutPct: number;
  oneScoreGamePct: number;
  tiePct: number;
  /** Team scores that can't happen in football (1 point). */
  impossibleScores: number;
}

export function scoreSanity(games: number, teams: Team[], seed = 11): ScoreSanity {
  const rng = new Rng(seed);
  let sum = 0, max = 0, over45 = 0, shutouts = 0, oneScore = 0, ties = 0, impossible = 0;
  for (let i = 0; i < games; i++) {
    const h = rng.int(0, teams.length - 1);
    let a = rng.int(0, teams.length - 2);
    if (a >= h) a++;
    const g = new Game(teams[h], teams[a], { home: 'cpu', away: 'cpu' }, { seed: rng.int(1, 2 ** 31) });
    g.simToEnd();
    for (const s of [g.sides.home.score, g.sides.away.score]) {
      sum += s;
      max = Math.max(max, s);
      if (s > 45) over45++;
      if (s === 0) shutouts++;
      if (s === 1) impossible++;
    }
    if (Math.abs(g.sides.home.score - g.sides.away.score) <= 8) oneScore++;
    if (g.s.winner === 'tie') ties++;
  }
  return {
    games, avgTeamPoints: sum / (2 * games), avgCombined: sum / games, maxTeamPoints: max, pctTeamScoresOver45: over45 / (2 * games),
    shutoutPct: shutouts / (2 * games), oneScoreGamePct: oneScore / games, tiePct: ties / games, impossibleScores: impossible,
  };
}

/** Play a scenario with the computer making the user's calls too. Returns the judged outcome. */
export function simulateScenario(sc: Scenario, home: Team, away: Team, seed: number): Outcome | undefined {
  const g = new Game(home, away, { home: 'cpu', away: 'cpu' }, { seed });
  g.applySetup(sc.setup);
  for (let i = 0; i < 600; i++) {
    const pre = sc.judge(g, g.log);
    if (pre) return pre;
    if (g.s.phase === 'final') return undefined;
    const d = g.pending();
    if (d.kind === 'snap' && d.offense === 'home' && sc.playsOnly) {
      g.cpuTimeouts();
      g.snap({ type: 'play', call: chooseOffensePlay(g.situation(), g.sides.home.team, g.rng, g.sides.home.memory, g.sides.away.scout), tempo: 'normal' });
    } else g.cpuAct();
  }
  return sc.judge(g, g.log);
}
