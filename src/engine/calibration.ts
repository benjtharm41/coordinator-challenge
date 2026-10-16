// Computer-vs-computer simulation harness used by the calibration test.
import targetsJson from './data/league-targets.json';
import { Game, type PlayLog } from './game';
import { allPlaceholderTeams } from './placeholder';
import { Rng } from './rng';
import type { Team } from './types';

export const TARGETS = targetsJson.combined;

export interface SimTotals {
  games: number;
  points: number;
  plays: number;
  yards: number;
  dropbacks: number;
  att: number;
  comp: number;
  compYards: number;
  airYards: number;
  yac: number;
  pass20: number;
  sacks: number;
  ints: number;
  scrambles: number;
  runs: number;
  runYards: number;
  run10: number;
  runStuff: number;
  fumblesLost: number;
  third: number;
  thirdConv: number;
  fourthGo: number;
  fourthConv: number;
  penalties: number;
  penaltyYards: number;
  fg: Record<string, [number, number]>;
  xpAtt: number;
  xpGood: number;
  twoAtt: number;
  twoGood: number;
  punts: number;
  puntGross: number;
  kickoffs: number;
  kickoffTB: number;
  koStartSum: number;
  koStartN: number;
  drives: number;
  driveResults: Record<string, number>;
  rzTrips: number;
  rzTD: number;
  ot: number;
  ties: number;
  scrimmageSeconds: number;
}

const empty = (): SimTotals => ({
  games: 0, points: 0, plays: 0, yards: 0, dropbacks: 0, att: 0, comp: 0, compYards: 0, airYards: 0, yac: 0, pass20: 0, sacks: 0, ints: 0,
  scrambles: 0, runs: 0, runYards: 0, run10: 0, runStuff: 0, fumblesLost: 0, third: 0, thirdConv: 0, fourthGo: 0, fourthConv: 0,
  penalties: 0, penaltyYards: 0, fg: {}, xpAtt: 0, xpGood: 0, twoAtt: 0, twoGood: 0, punts: 0, puntGross: 0, kickoffs: 0, kickoffTB: 0,
  koStartSum: 0, koStartN: 0, drives: 0, driveResults: {}, rzTrips: 0, rzTD: 0, ot: 0, ties: 0, scrimmageSeconds: 0,
});

const fgBucket = (d: number) => (d < 30 ? '<30' : d < 40 ? '30-39' : d < 50 ? '40-49' : d < 60 ? '50-59' : '60+');

export function accumulate(t: SimTotals, g: Game) {
  t.games++;
  t.points += g.sides.home.score + g.sides.away.score;
  if (g.s.quarter >= 5) t.ot++;
  if (g.s.winner === 'tie') t.ties++;
  let prevKickoff: PlayLog | undefined;
  for (const e of g.log) {
    if (e.kind === 'penalty' || (e.penalty && e.penalty.accepted)) {
      if (e.penalty?.accepted) {
        t.penalties++;
        t.penaltyYards += Math.abs(e.penalty.on === 'off' ? e.penalty.yards : e.penalty.spot ?? e.penalty.yards);
      }
    }
    if (prevKickoff && e.kind !== 'info' && e.kind !== 'timeout') {
      if (!prevKickoff.kick?.touchdown && !prevKickoff.kick?.kickingTeamBall && e.offense !== prevKickoff.offense && e.down === 1) {
        t.koStartSum += 100 - e.yardline;
        t.koStartN++;
      }
      prevKickoff = undefined;
    }
    switch (e.kind) {
      case 'kickoff':
        t.kickoffs++;
        if (e.kick?.touchback) t.kickoffTB++;
        prevKickoff = e;
        break;
      case 'punt':
        t.punts++;
        t.puntGross += e.kick?.kickDistance ?? 0;
        break;
      case 'fg': {
        const d = e.yardline + 17;
        const b = (t.fg[fgBucket(d)] ??= [0, 0]);
        b[1]++;
        if (e.points) b[0]++;
        break;
      }
      case 'xp':
        t.xpAtt++;
        if (e.points) t.xpGood++;
        break;
      case '2pt':
        t.twoAtt++;
        if (e.points) t.twoGood++;
        break;
    }
    const o = e.outcome;
    if (!o || e.kind === 'penalty' || e.kind === '2pt') continue;
    if (e.kind !== 'run' && e.kind !== 'pass' && e.kind !== 'sack' && e.kind !== 'scramble') continue;
    t.plays++;
    t.yards += o.yards;
    t.scrimmageSeconds += e.elapsed;
    if (e.down === 3) {
      t.third++;
      if (e.firstDown || e.touchdown) t.thirdConv++;
    }
    if (e.down === 4) {
      t.fourthGo++;
      if (e.firstDown || e.touchdown) t.fourthConv++;
    }
    if (o.fumbleLost) t.fumblesLost++;
    if (o.type === 'run') {
      t.runs++;
      t.runYards += o.yards;
      if (o.yards >= 10) t.run10++;
      if (o.yards <= 0) t.runStuff++;
    } else {
      t.dropbacks++;
      if (o.type === 'sack') t.sacks++;
      else if (o.type === 'scramble') t.scrambles++;
      else {
        t.att++;
        if (o.intercepted) t.ints++;
        if (o.complete) {
          t.comp++;
          t.compYards += o.yards;
          t.yac += o.yac ?? 0;
          if (o.yards >= 20) t.pass20++;
        }
        t.airYards += o.airYards ?? 0;
      }
    }
  }
  for (const d of g.drives) {
    t.drives++;
    const r = d.result ?? 'Unknown';
    t.driveResults[r] = (t.driveResults[r] ?? 0) + 1;
    if (d.reachedRedZone) {
      t.rzTrips++;
      if (r === 'Touchdown') t.rzTD++;
    }
  }
}

export interface SimOptions {
  games: number;
  seed?: number;
  short?: boolean;
  teams?: Team[];
}

export function simulate(opts: SimOptions): SimTotals {
  const teams = opts.teams ?? allPlaceholderTeams();
  const rng = new Rng(opts.seed ?? 12345);
  const t = empty();
  for (let i = 0; i < opts.games; i++) {
    const h = rng.int(0, teams.length - 1);
    let a = rng.int(0, teams.length - 2);
    if (a >= h) a++;
    const g = new Game(teams[h], teams[a], { home: 'cpu', away: 'cpu' }, { seed: rng.int(1, 2 ** 31), short: opts.short });
    g.simToEnd();
    accumulate(t, g);
  }
  return t;
}

export interface Metric {
  key: string;
  label: string;
  sim: number;
  real: number | null;
  /** Allowed absolute difference. */
  tol: number;
  fmt: 'pct' | 'num' | 'num2';
}

export function metrics(t: SimTotals): Metric[] {
  const tg = t.games * 2;
  const R = TARGETS as unknown as Record<string, number> & { fg_pct_by_distance: Record<string, { pct: number }> };
  const m = (key: string, label: string, sim: number, real: number | null, tol: number, fmt: Metric['fmt'] = 'num2'): Metric => ({ key, label, sim, real, tol, fmt });
  const fgPct = (b: string) => (t.fg[b] ? t.fg[b][0] / t.fg[b][1] : 0);
  return [
    m('points', 'Points per team per game', t.points / tg, R.points_per_team_game, 1.5, 'num'),
    m('ypp', 'Yards per play', t.yards / t.plays, R.yards_per_play, 0.2),
    m('comp', 'Completion %', t.comp / t.att, R.completion_pct, 0.02, 'pct'),
    m('sack', 'Sack rate (per dropback)', t.sacks / (t.att + t.sacks), R.sack_rate, 0.008, 'pct'),
    m('int', 'Interception rate (per attempt)', t.ints / t.att, R.int_rate, 0.004, 'pct'),
    m('fum', 'Fumbles lost per play', t.fumblesLost / t.plays, R.fumbles_lost_per_play, 0.002, 'pct'),
    m('to', 'Turnovers per team per game', (t.ints + t.fumblesLost) / tg, R.turnovers_per_team_game, 0.2),
    m('plays', 'Offensive plays per team per game', t.plays / tg, R.plays_per_team_game, 3, 'num'),
    m('passrate', 'Pass rate (dropbacks)', t.dropbacks / t.plays, R.pass_rate_dropback, 0.03, 'pct'),
    m('ypa', 'Yards per pass attempt', t.compYards / t.att, R.yards_per_att_gross, 0.35),
    m('ypc_comp', 'Yards per completion', t.compYards / t.comp, R.yards_per_completion, 0.6),
    m('adot', 'Air yards per attempt', t.airYards / t.att, R.avg_air_yards_per_att, 0.8),
    m('yac', 'YAC per completion', t.yac / t.comp, R.avg_yac_per_completion, 0.6),
    m('pass20', '20+ yd completions per attempt', t.pass20 / t.att, R.pass_20plus_rate_per_att, 0.015, 'pct'),
    m('ypc', 'Yards per designed run', t.runYards / t.runs, R.yards_per_designed_run, 0.25),
    m('run10', '10+ yd runs', t.run10 / t.runs, R.run_10plus_rate, 0.015, 'pct'),
    m('stuff', 'Runs stuffed (0 or less)', t.runStuff / t.runs, R.run_stuff_rate, 0.025, 'pct'),
    m('scramble', 'Scramble rate (of dropbacks)', t.scrambles / t.dropbacks, R.scramble_rate_of_dropbacks, 0.015, 'pct'),
    m('third', '3rd down conversion', t.thirdConv / t.third, R.third_down_conv_rate, 0.03, 'pct'),
    m('fourth_att', '4th down tries per team per game', t.fourthGo / tg, R.fourth_down_attempts_per_team_game, 0.5),
    m('fourth', '4th down conversion', t.fourthConv / Math.max(1, t.fourthGo), R.fourth_down_conv_rate, 0.06, 'pct'),
    m('pen', 'Accepted penalties per team per game', t.penalties / tg, R.penalties_per_team_game, 1.2),
    m('fg_att', 'FG attempts per team per game', Object.values(t.fg).reduce((a, b) => a + b[1], 0) / tg, R.fg_att_per_team_game, 0.35),
    m('fg30', 'FG % 30-39 yds', fgPct('30-39'), R.fg_pct_by_distance['30-39'].pct, 0.04, 'pct'),
    m('fg40', 'FG % 40-49 yds', fgPct('40-49'), R.fg_pct_by_distance['40-49'].pct, 0.05, 'pct'),
    m('fg50', 'FG % 50-59 yds', fgPct('50-59'), R.fg_pct_by_distance['50-59'].pct, 0.07, 'pct'),
    m('xp', 'Extra point %', t.xpGood / t.xpAtt, R.xp_pct, 0.02, 'pct'),
    m('two', '2-point conversion %', t.twoGood / Math.max(1, t.twoAtt), R.two_pt_pct, 0.08, 'pct'),
    m('punts', 'Punts per team per game', t.punts / tg, R.punts_per_team_game, 0.5),
    m('punt_gross', 'Gross punt average', t.puntGross / t.punts, R.punt_gross_avg, 2, 'num'),
    m('ko_tb', 'Kickoff touchback rate', t.kickoffTB / t.kickoffs, R.kickoff_touchback_rate, 0.04, 'pct'),
    m('ko_start', 'Avg start after kickoff (own yd line)', t.koStartSum / Math.max(1, t.koStartN), R.avg_start_yardline_after_kickoff_own, 2, 'num'),
    m('drives', 'Drives per team per game', t.drives / tg, R.drives_per_team_game, 0.8),
    m('rz', 'Red zone TD rate (per trip)', t.rzTD / Math.max(1, t.rzTrips), R.red_zone_td_rate_per_trip, 0.06, 'pct'),
    m('td_drive', 'Drives ending in TD', (t.driveResults['Touchdown'] ?? 0) / t.drives, (R as unknown as { drive_results_share: Record<string, number> }).drive_results_share['Touchdown'], 0.03, 'pct'),
    m('ot', 'Overtime rate', t.ot / t.games, R.ot_rate, 0.03, 'pct'),
  ];
}

export function formatMetric(x: number, f: Metric['fmt']): string {
  return f === 'pct' ? `${(x * 100).toFixed(1)}%` : f === 'num' ? x.toFixed(1) : x.toFixed(2);
}
