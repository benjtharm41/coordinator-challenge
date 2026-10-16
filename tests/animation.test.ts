// Every play in real simulated games must produce a sane animation.
import { describe, expect, it } from 'vitest';
import { Game } from '../src/engine/game';
import { allPlaceholderTeams } from '../src/engine/placeholder';
import { CONCEPTS, COVERAGES, FORMATIONS, FRONTS, pressuresFor } from '../src/engine/playbook';
import { ballAt } from '../src/field/anim';
import { shotFor } from '../src/field/director';
import { defenseLayout, offenseLayout } from '../src/field/geometry';
import { buildScene } from '../src/field/scene';
import type { Concept, Coverage, Formation, Front } from '../src/engine/types';

const teams = allPlaceholderTeams();

describe('formations and defenses line up legally', () => {
  for (const f of Object.keys(FORMATIONS) as Formation[]) {
    it(`offense ${f} has 11 players on legal spots`, () => {
      const spots = offenseLayout(f);
      expect(spots).toHaveLength(11);
      expect(new Set(spots.map((s) => s.slot)).size).toBe(11);
      for (const s of spots) expect(Math.abs(s.x)).toBeLessThan(26);
      // Seven on the line of scrimmage (5 OL + others) is not required, but at least 5 OL.
      expect(spots.filter((s) => ['LT', 'LG', 'C', 'RG', 'RT'].includes(s.slot))).toHaveLength(5);
    });
  }
  for (const front of Object.keys(FRONTS) as Front[]) {
    for (const cov of Object.keys(COVERAGES) as Coverage[]) {
      for (const pr of pressuresFor(cov)) {
        it(`defense ${front}/${cov}/${pr} has 11 defenders with assignments`, () => {
          for (const f of ['shotgun', 'empty', 'heavy', 'goalline'] as Formation[]) {
            const d = defenseLayout({ front, coverage: cov, pressure: pr }, offenseLayout(f));
            expect(d).toHaveLength(11);
            for (const x of d) {
              expect(Number.isFinite(x.x) && Number.isFinite(x.y)).toBe(true);
              expect(x.assign).toBeTruthy();
            }
            const rushers = d.filter((x) => x.assign.kind === 'rush').length;
            expect(rushers).toBeGreaterThanOrEqual(3);
            expect(rushers).toBeLessThanOrEqual(8);
          }
        });
      }
    }
  }
});

describe('every concept in every formation builds a scene', () => {
  for (const f of Object.keys(FORMATIONS) as Formation[]) {
    for (const c of FORMATIONS[f].concepts as Concept[]) {
      it(`${f} ${c}`, () => {
        const s = buildScene(teams[0], teams[1], { formation: f, concept: c }, { front: 'nickel', coverage: 'c3', pressure: 'base' });
        expect(s.off).toHaveLength(11);
        expect(s.def).toHaveLength(11);
        if (CONCEPTS[c].kind === 'pass') expect(s.routes.length).toBeGreaterThan(0);
        for (const r of s.routes) for (const p of r.path) expect(Number.isFinite(p.x + p.y)).toBe(true);
      });
    }
  }
});

describe('animations from real games', () => {
  const games: Game[] = [];
  for (let i = 0; i < 40; i++) {
    const g = new Game(teams[i % 32], teams[(i * 7 + 3) % 32], { home: 'cpu', away: 'cpu' }, { seed: 500 + i });
    g.simToEnd();
    games.push(g);
  }
  it('every entry produces finite, in-bounds, reasonably short animations', () => {
    let count = 0;
    const kinds = new Set<string>();
    for (const g of games) {
      for (const e of g.log) {
        const shot = shotFor(g, e);
        if (!shot) continue;
        count++;
        kinds.add(e.kind);
        const a = shot.anim;
        expect(a.duration).toBeGreaterThan(1);
        expect(a.duration).toBeLessThan(12.5);
        for (const tr of a.tracks) {
          let last = -1;
          for (const k of tr.keys) {
            expect(Number.isFinite(k.t + k.x + k.y), `${e.kind} ${tr.id}`).toBe(true);
            expect(k.t).toBeGreaterThanOrEqual(last);
            last = k.t;
            expect(Math.abs(k.x)).toBeLessThanOrEqual(27);
          }
        }
        for (let t = 0; t <= a.duration; t += 0.5) {
          const b = ballAt(a, t);
          expect(Number.isFinite(b.x + b.y + b.z)).toBe(true);
        }
        expect(a.tracks.filter((t) => t.side === 'off').length).toBeGreaterThanOrEqual(11);
      }
    }
    expect(count).toBeGreaterThan(3000);
    for (const k of ['run', 'pass', 'sack', 'kickoff', 'punt', 'fg', 'xp']) expect(kinds.has(k), k).toBe(true);
  }, 60000);

  it('the player named in the play text is on the field in the animation', () => {
    for (const g of games.slice(0, 15)) {
      for (const e of g.log) {
        const o = e.outcome;
        if (!o || !['run', 'pass'].includes(e.kind)) continue;
        const shot = shotFor(g, e)!;
        const nums = new Map(shot.anim.tracks.map((t) => [t.name, t.num]));
        const named = o.type === 'pass' ? o.target : o.carrier;
        if (named) expect(nums.has(named.name), `${e.kind} ${named.name}`).toBe(true);
        if (o.defender && o.type !== 'none') expect(nums.has(o.defender.name), `defender ${o.defender.name}`).toBe(true);
      }
    }
  });
});
