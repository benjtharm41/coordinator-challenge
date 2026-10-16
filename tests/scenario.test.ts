// Situations: every scenario starts legally, can be won and lost, and always finishes.
import { describe, expect, it } from 'vitest';
import { Game } from '../src/engine/game';
import { SCENARIOS } from '../src/engine/scenario';
import { Rng } from '../src/engine/rng';
import { averageTeam, simulateScenario } from '../src/engine/testkit';

const a = averageTeam('KC');
const b = averageTeam('BUF');

describe('situations', () => {
  for (const sc of SCENARIOS) {
    it(`${sc.title}: legal start, finishes, winnable but not a given`, () => {
      const g = new Game(a, b, { home: 'cpu', away: 'cpu' }, { seed: 1 });
      g.applySetup(sc.setup);
      expect(g.s.phase).toBe('scrimmage');
      expect(g.s.distance).toBeLessThanOrEqual(g.s.yardline);
      expect(g.sides.home.score).toBe(sc.setup.score.home);
      expect(sc.judge(g, g.log)).toBeUndefined(); // not already decided
      const rng = new Rng(5);
      let w = 0;
      let done = 0;
      const n = 80;
      for (let i = 0; i < n; i++) {
        const r = simulateScenario(sc, a, b, rng.int(1, 2 ** 31));
        if (r) {
          done++;
          w += r.result === 'win' ? 1 : r.result === 'tie' ? 0.5 : 0;
        }
      }
      expect(done).toBe(n);
      expect(w / n).toBeGreaterThan(sc.longShot ? 0.0 : 0.05);
      expect(w / n).toBeLessThan(0.95);
    }, 60000);
  }
});
