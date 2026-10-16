// The engine must match real NFL averages. Full report: `npm run calibrate`.
import { describe, expect, it } from 'vitest';
import { metrics, simulate } from '../src/engine/calibration';

describe('calibration vs real NFL averages', () => {
  const m = metrics(simulate({ games: 400, seed: 77 }));
  const core = ['points', 'ypp', 'comp', 'sack', 'int', 'fum', 'plays', 'passrate', 'ypc', 'third'];
  for (const k of core) {
    const x = m.find((y) => y.key === k)!;
    it(`${x.label} within tolerance`, () => {
      expect(Math.abs(x.sim - (x.real ?? x.sim))).toBeLessThanOrEqual(x.tol);
    });
  }
  it('at least 32 of 36 stats within tolerance', () => {
    const ok = m.filter((x) => x.real === null || Math.abs(x.sim - x.real) <= x.tol).length;
    expect(ok).toBeGreaterThanOrEqual(32);
  });
});
