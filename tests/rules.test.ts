// Game rules: scoring, downs, clock, timeouts, overtime.
import { describe, expect, it } from 'vitest';
import { Game, type PlayLog } from '../src/engine/game';
import { allPlaceholderTeams } from '../src/engine/placeholder';
import { averageTeam } from '../src/engine/testkit';

const teams = allPlaceholderTeams();
const newGame = (seed = 1) => new Game(averageTeam('KC'), averageTeam('BUF'), { home: 'cpu', away: 'cpu' }, { seed });
// Access to internals for targeted rule checks.
type Internals = { advanceDowns(y: number, s: boolean, e?: PlayLog): void; push(e: object): PlayLog };
const internals = (g: Game) => g as unknown as Internals;
const fakeEntry = (g: Game) => internals(g).push({ kind: 'run', quarter: g.s.quarter, clock: g.s.clock, offense: g.s.possession, down: g.s.down, distance: g.s.distance, yardline: g.s.yardline, yards: 0, text: 'test', elapsed: 0 });

function toScrimmage(g: Game) {
  g.doKickoff(false);
  expect(g.s.phase).toBe('scrimmage');
}

describe('downs and scoring', () => {
  it('gaining the distance gives a first down', () => {
    const g = newGame();
    toScrimmage(g);
    g.s.yardline = 60; g.s.down = 2; g.s.distance = 4;
    internals(g).advanceDowns(5, true, fakeEntry(g));
    expect(g.s.down).toBe(1);
    expect(g.s.distance).toBe(10);
    expect(g.s.yardline).toBe(55);
  });

  it('first down inside the 10 is "and goal"', () => {
    const g = newGame();
    toScrimmage(g);
    g.s.yardline = 15; g.s.down = 1; g.s.distance = 10;
    internals(g).advanceDowns(10, true, fakeEntry(g));
    expect(g.s.down).toBe(1);
    expect(g.s.distance).toBe(5);
  });

  it('failing on 4th down turns the ball over where the play ended', () => {
    const g = newGame();
    toScrimmage(g);
    const offense = g.s.possession;
    g.s.yardline = 40; g.s.down = 4; g.s.distance = 3;
    internals(g).advanceDowns(1, true, fakeEntry(g));
    expect(g.s.possession).not.toBe(offense);
    expect(g.s.yardline).toBe(61);
    expect(g.s.down).toBe(1);
  });

  it('crossing the goal line is a touchdown worth 6, then a try', () => {
    const g = newGame();
    toScrimmage(g);
    const offense = g.s.possession;
    g.s.yardline = 5;
    internals(g).advanceDowns(5, true, fakeEntry(g));
    expect(g.sides[offense].score).toBe(6);
    expect(g.s.phase).toBe('try');
    g.doTry('xp');
    expect([6, 7]).toContain(g.sides[offense].score);
    expect(g.s.phase).toBe('kickoff');
    expect(g.s.kickingTeam).toBe(offense);
  });

  it('being tackled in your own end zone is a safety: 2 points and a free kick', () => {
    const g = newGame();
    toScrimmage(g);
    const offense = g.s.possession;
    const defense = offense === 'home' ? 'away' : 'home';
    g.s.yardline = 97;
    internals(g).advanceDowns(-4, true, fakeEntry(g));
    expect(g.sides[defense].score).toBe(2);
    expect(g.s.phase).toBe('kickoff');
    expect(g.s.kickingTeam).toBe(offense);
    expect(g.s.kickFrom).toBe(20);
  });
});

describe('clock and timeouts', () => {
  it('a timeout stops the clock and uses one of 3', () => {
    const g = newGame();
    toScrimmage(g);
    g.s.clockRunning = true;
    expect(g.timeout('home')).toBe(true);
    expect(g.s.clockRunning).toBe(false);
    expect(g.sides.home.timeouts).toBe(2);
    g.timeout('home');
    g.timeout('home');
    expect(g.timeout('home')).toBe(false);
  });

  it('a spike stops the clock and costs a down', () => {
    const g = newGame();
    toScrimmage(g);
    g.s.clockRunning = true;
    const down = g.s.down;
    g.snap({ type: 'spike' });
    expect(g.s.clockRunning).toBe(false);
    expect(g.s.down).toBe(down + 1);
  });

  it('a kneel keeps the clock running', () => {
    const g = newGame();
    toScrimmage(g);
    g.snap({ type: 'kneel' });
    expect(g.s.clockRunning).toBe(true);
  });

  it('the clock runs down to the two-minute warning and stops there', () => {
    const g = newGame();
    toScrimmage(g);
    g.s.quarter = 2; g.s.clock = 125; g.s.clockRunning = true;
    g.snap({ type: 'play', call: { formation: 'shotgun', concept: 'inside_zone' }, tempo: 'normal' });
    expect(g.log.some((e) => e.text === 'Two-minute warning.')).toBe(true);
    expect(g.s.warned[2]).toBe(true);
  });
});

describe('full games always end correctly', () => {
  const games: Game[] = [];
  for (let i = 0; i < 150; i++) {
    const g = new Game(teams[i % 32], teams[(i * 5 + 1) % 32], { home: 'cpu', away: 'cpu' }, { seed: 1000 + i });
    g.simToEnd();
    games.push(g);
  }

  it('every game finishes with a winner that matches the score', () => {
    for (const g of games) {
      expect(g.s.phase).toBe('final');
      const h = g.sides.home.score;
      const a = g.sides.away.score;
      if (g.s.winner === 'tie') {
        expect(h).toBe(a);
        expect(g.s.quarter).toBe(5); // ties only after overtime
      } else expect(g.sides[g.s.winner!].score).toBeGreaterThan(g.sides[g.s.winner === 'home' ? 'away' : 'home'].score);
    }
  });

  it('points in the log add up to the final score', () => {
    for (const g of games) {
      const sum = { home: 0, away: 0 };
      for (const e of g.log) if (e.points) sum[e.points.side] += e.points.pts;
      expect(sum.home).toBe(g.sides.home.score);
      expect(sum.away).toBe(g.sides.away.score);
    }
  });

  it('downs, distances, yard lines, clock and timeouts stay in legal ranges', () => {
    for (const g of games) {
      for (const e of g.log) {
        if (['run', 'pass', 'sack', 'scramble'].includes(e.kind)) {
          expect(e.down).toBeGreaterThanOrEqual(1);
          expect(e.down).toBeLessThanOrEqual(4);
          expect(e.distance).toBeGreaterThanOrEqual(1);
          expect(e.yardline).toBeGreaterThanOrEqual(1);
          expect(e.yardline).toBeLessThanOrEqual(99);
          expect(e.distance).toBeLessThanOrEqual(e.yardline);
        }
        expect(e.clock).toBeGreaterThanOrEqual(0);
      }
      expect(g.sides.home.timeouts).toBeGreaterThanOrEqual(0);
    }
  });

  it('two-minute warning happens at most once per half', () => {
    for (const g of games) {
      const warnings = g.log.filter((e) => e.text === 'Two-minute warning.');
      const byQ = new Map<number, number>();
      for (const w of warnings) byQ.set(w.quarter, (byQ.get(w.quarter) ?? 0) + 1);
      for (const n of byQ.values()) expect(n).toBe(1);
    }
  });

  it('overtime only ends when both teams have had the ball, unless the defense scores', () => {
    for (const g of games.filter((x) => x.s.quarter === 5 && x.s.winner !== 'tie')) {
      const p = g.s.ot.possessions;
      const defensiveEnd = g.log.slice(-3).some((e) => e.points?.type === 'SAFETY' || (e.points?.type === 'TD' && e.turnover));
      const timeUp = g.s.clock <= 0;
      expect(defensiveEnd || timeUp || (p.home > 0 && p.away > 0)).toBe(true);
    }
  });
});
