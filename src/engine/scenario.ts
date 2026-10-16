// Situations mode: preset game situations, each with a clear win/lose condition.
// The user is always the home team in a scenario.
import type { Game, PlayLog, ScenarioSetup } from './game';
import type { Side } from './types';

export type ScenarioId =
  | 'two_minute' | 'red_zone' | 'goal_line' | 'four_minute' | 'backed_up' | 'third_long'
  | 'fourth_short' | 'hail_mary' | 'comeback' | 'defend_two_minute' | 'overtime';

export interface Outcome {
  result: 'win' | 'lose' | 'tie';
  /** Number behind the "best result" (time left, plays used, margin). */
  metric?: number;
  message: string;
}

export interface Scenario {
  id: ScenarioId;
  title: string;
  /** Plain-English situation. */
  situation: string;
  win: string;
  lose: string;
  side: 'offense' | 'defense' | 'both';
  setup: ScenarioSetup;
  /** Hide punt / field goal / spike / kneel (the point is to run a play). */
  playsOnly?: boolean;
  /** Realistically a long shot (like a Hail Mary or a goal-line stand: NFL offenses score about 8 times in 10 here); the user is told so. */
  longShot?: boolean;
  metric?: { label: string; better: 'high' | 'low'; unit: 'seconds' | 'plays' | 'points' };
  /** Judge the situation after each step. Returns undefined while it is still going. */
  judge: (g: Game, entries: PlayLog[]) => Outcome | undefined;
}

const USER: Side = 'home';
const CPU: Side = 'away';

const isPlay = (e: PlayLog) => ['run', 'pass', 'sack', 'scramble'].includes(e.kind) && !!e.outcome;
const tdBy = (entries: PlayLog[], side: Side) => entries.some((e) => e.points?.type === 'TD' && e.points.side === side);
const fgBy = (entries: PlayLog[], side: Side) => entries.some((e) => e.points?.type === 'FG' && e.points.side === side);
const safetyAgainstUser = (entries: PlayLog[]) => entries.some((e) => e.points?.type === 'SAFETY' && e.points.side === CPU);
const userTurnover = (entries: PlayLog[]) => entries.some((e) => e.turnover && e.offense === USER);
const userPunt = (entries: PlayLog[]) => entries.some((e) => e.kind === 'punt' && e.offense === USER);
const cpuTurnover = (entries: PlayLog[]) => entries.some((e) => e.turnover && e.offense === CPU);
const usersPlays = (entries: PlayLog[]) => entries.filter((e) => isPlay(e) && e.offense === USER).length;
const lead = (g: Game) => g.sides.home.score - g.sides.away.score;
const regulationOver = (g: Game) => g.s.phase === 'final' || g.s.quarter > 4;

const win = (message: string, metric?: number): Outcome => ({ result: 'win', message, metric });
const lose = (message: string): Outcome => ({ result: 'lose', message });

/** The end of a hold-the-lead situation. */
function holdLead(g: Game, entries: PlayLog[], what: string): Outcome | undefined {
  if (!regulationOver(g)) {
    if (lead(g) <= 0 && entries.length) return lose(`${what} slipped away: you no longer lead.`);
    return undefined;
  }
  const l = lead(g);
  if (l > 0) return win(`You held on and won by ${l}.`, l);
  return lose(l === 0 ? 'The game is tied: it goes to overtime, so the lead was lost.' : 'You lost the lead.');
}

export const SCENARIOS: Scenario[] = [
  {
    id: 'two_minute', title: '2-minute drill', side: 'offense',
    situation: 'You trail by 4 with 1:58 left and 1 timeout. 1st & 10 at your own 25.',
    win: 'Score a touchdown before time runs out.', lose: 'Time runs out, you turn it over, or you only kick a field goal.',
    setup: { quarter: 4, clock: 118, possession: USER, yardline: 75, down: 1, distance: 10, score: { home: 17, away: 21 }, timeouts: { home: 1, away: 3 } },
    metric: { label: 'Time left when you scored', better: 'high', unit: 'seconds' },
    judge: (g, e) => {
      if (tdBy(e, USER)) return win('Touchdown! You took the lead.', Math.max(0, Math.round(g.s.clock)));
      if (fgBy(e, USER)) return lose('A field goal only cuts it to 1. You needed a touchdown.');
      if (userTurnover(e) || userPunt(e)) return lose('You gave the ball away.');
      if (regulationOver(g) || g.s.clock <= 0) return lose('Time ran out.');
      return undefined;
    },
  },
  {
    id: 'red_zone', title: 'Red zone offense', side: 'offense',
    situation: '1st & 10 at the opponent\'s 18-yard line. Tied 10-10 in the 3rd quarter.',
    win: 'Score a touchdown on this drive.', lose: 'You settle for a field goal, turn it over, or fail on 4th down.',
    setup: { quarter: 3, clock: 480, possession: USER, yardline: 18, down: 1, distance: 10, score: { home: 10, away: 10 }, timeouts: { home: 3, away: 3 } },
    metric: { label: 'Plays used to score', better: 'low', unit: 'plays' },
    judge: (g, e) => {
      if (tdBy(e, USER)) return win('Touchdown!', usersPlays(e));
      if (fgBy(e, USER)) return lose('You had to settle for a field goal.');
      if (userTurnover(e) || userPunt(e)) return lose('The drive ended without a touchdown.');
      if (g.s.possession !== USER) return lose('The drive ended without a touchdown.');
      return undefined;
    },
  },
  {
    id: 'goal_line', title: 'Goal-line stand', side: 'defense', longShot: true,
    situation: 'The opponent has 1st & goal at your 3-yard line. You lead 14-10 in the 4th quarter.',
    win: 'Keep them out of the end zone.', lose: 'They score a touchdown.',
    setup: { quarter: 4, clock: 600, possession: CPU, yardline: 3, down: 1, distance: 3, score: { home: 14, away: 10 }, timeouts: { home: 3, away: 3 } },
    judge: (g, e) => {
      if (tdBy(e, CPU)) return lose('They scored a touchdown.');
      if (cpuTurnover(e)) return win('Turnover! You kept them out.');
      if (fgBy(e, CPU)) return win('They only got a field goal. You held them out of the end zone.');
      if (g.s.possession === USER && e.length) return win('You held them out of the end zone.');
      return undefined;
    },
  },
  {
    id: 'four_minute', title: '4-minute offense', side: 'offense',
    situation: 'You lead by 3 with 4:00 left. 1st & 10 at your own 30. You have 1 timeout; they have 3.',
    win: 'Still lead when time expires.', lose: 'They tie or take the lead.',
    setup: { quarter: 4, clock: 240, possession: USER, yardline: 70, down: 1, distance: 10, score: { home: 24, away: 21 }, timeouts: { home: 1, away: 3 } },
    metric: { label: 'Final margin', better: 'high', unit: 'points' },
    judge: (g, e) => holdLead(g, e, 'The lead'),
  },
  {
    id: 'backed_up', title: 'Backed up', side: 'offense',
    situation: '1st & 10 at your own 2-yard line. Tied 7-7 in the 2nd quarter.',
    win: 'Get the ball out to your own 25 or beyond.', lose: 'Safety, turnover, or you punt before getting there.',
    setup: { quarter: 2, clock: 700, possession: USER, yardline: 98, down: 1, distance: 10, score: { home: 7, away: 7 }, timeouts: { home: 3, away: 3 } },
    metric: { label: 'Plays used to escape', better: 'low', unit: 'plays' },
    judge: (g, e) => {
      if (safetyAgainstUser(e)) return lose('Safety: they get 2 points.');
      if (userTurnover(e)) return lose('Turnover deep in your own end.');
      if (userPunt(e)) return lose('You punted before escaping.');
      if (g.s.possession === USER && g.s.phase === 'scrimmage' && g.s.yardline <= 75) return win('You got out of the shadow of your goal posts.', usersPlays(e));
      if (g.s.possession !== USER) return lose('You lost the ball.');
      return undefined;
    },
  },
  {
    id: 'third_long', title: '3rd & long', side: 'offense',
    situation: '3rd & 12 at your own 35. Tied 7-7 in the 2nd quarter.',
    win: 'Get a first down on this play.', lose: 'You fall short.',
    setup: { quarter: 2, clock: 500, possession: USER, yardline: 65, down: 3, distance: 12, score: { home: 7, away: 7 }, timeouts: { home: 3, away: 3 } },
    playsOnly: true,
    judge: (_g, e) => {
      const p = e.find((x) => isPlay(x) && x.offense === USER);
      if (!p) return undefined;
      if (p.firstDown || (p.touchdown && p.points?.side === USER)) return win('Converted! First down.');
      return lose(`Only ${Math.max(0, p.yards)} of the 12 yards you needed.`);
    },
  },
  {
    id: 'fourth_short', title: '4th & 1', side: 'offense',
    situation: '4th & 1 at the opponent\'s 45. Tied 17-17 in the 4th quarter.',
    win: 'Get the first down.', lose: 'You are stopped.',
    setup: { quarter: 4, clock: 400, possession: USER, yardline: 45, down: 4, distance: 1, score: { home: 17, away: 17 }, timeouts: { home: 3, away: 3 } },
    playsOnly: true,
    judge: (_g, e) => {
      const p = e.find((x) => isPlay(x) && x.offense === USER);
      if (!p) return undefined;
      if (p.firstDown || (p.touchdown && p.points?.side === USER)) return win('Converted!');
      return lose('Stopped short. Turnover on downs.');
    },
  },
  {
    id: 'hail_mary', title: 'End-of-half Hail Mary', side: 'offense', longShot: true,
    situation: 'Last play of the first half: 5 seconds left, you trail 13-17 at the opponent\'s 45. No timeouts.',
    win: 'Score a touchdown.', lose: 'Anything else.',
    setup: { quarter: 2, clock: 5, possession: USER, yardline: 45, down: 1, distance: 10, score: { home: 13, away: 17 }, timeouts: { home: 0, away: 0 } },
    judge: (g, e) => {
      if (tdBy(e, USER)) return win('HAIL MARY! Touchdown!');
      if (userTurnover(e)) return lose('Intercepted.');
      if (g.s.quarter !== 2 || g.s.clock <= 0) return lose('Time expired.');
      return undefined;
    },
  },
  {
    id: 'comeback', title: 'Comeback', side: 'offense', longShot: true,
    situation: 'You trail by 10 with 5:00 left. 1st & 10 at your own 25. 2 timeouts.',
    win: 'Have the lead when time expires.', lose: 'You are still behind. A tie goes to overtime and counts as half a win.',
    setup: { quarter: 4, clock: 300, possession: USER, yardline: 75, down: 1, distance: 10, score: { home: 14, away: 24 }, timeouts: { home: 2, away: 3 } },
    metric: { label: 'Final margin', better: 'high', unit: 'points' },
    judge: (g) => {
      if (!regulationOver(g)) return undefined;
      const l = lead(g);
      if (l > 0) return win(`Comeback complete: you won by ${l}.`, l);
      if (l === 0) return { result: 'tie', message: 'You tied it and forced overtime.', metric: 0 };
      return lose(`You fell short by ${-l}.`);
    },
  },
  {
    id: 'defend_two_minute', title: 'Defend a 2-minute drill', side: 'defense',
    situation: 'You lead by 4 with 1:58 left. They have 1st & 10 at their own 25 and 1 timeout.',
    win: 'Still lead when time expires.', lose: 'They score a touchdown.',
    setup: { quarter: 4, clock: 118, possession: CPU, yardline: 75, down: 1, distance: 10, score: { home: 21, away: 17 }, timeouts: { home: 3, away: 1 } },
    metric: { label: 'Final margin', better: 'high', unit: 'points' },
    judge: (g, e) => {
      if (tdBy(e, CPU)) return lose('They scored the winning touchdown.');
      return holdLead(g, e, 'The lead');
    },
  },
  {
    id: 'overtime', title: 'Overtime possession', side: 'offense',
    situation: 'Overtime, tied 20-20. You get the ball first at your own 35. A touchdown wins it; after a field goal, the other team gets a possession.',
    win: 'Win the game.', lose: 'Lose the game. A tie counts as half a win.',
    setup: { quarter: 5, clock: 600, possession: USER, yardline: 65, down: 1, distance: 10, score: { home: 20, away: 20 }, timeouts: { home: 2, away: 2 }, ot: true },
    metric: { label: 'Final margin', better: 'high', unit: 'points' },
    judge: (g) => {
      if (g.s.phase !== 'final') return undefined;
      const l = lead(g);
      if (g.s.winner === 'home') return win(`You won in overtime by ${l}.`, l);
      if (g.s.winner === 'tie') return { result: 'tie', message: 'It ended in a tie.', metric: 0 };
      return lose('They won in overtime.');
    },
  },
];

export const scenarioById = (id: string) => SCENARIOS.find((s) => s.id === id);

export function formatMetric(sc: Scenario, v: number | undefined): string {
  if (v === undefined || !sc.metric) return '';
  if (sc.metric.unit === 'seconds') return `${Math.floor(v / 60)}:${String(Math.round(v) % 60).padStart(2, '0')} left`;
  if (sc.metric.unit === 'plays') return `${v} play${v === 1 ? '' : 's'}`;
  return `${v > 0 ? '+' : ''}${v} pts`;
}
