// Checks on the generated real-team files (public/data) and games played with them.
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Game } from '../src/engine/game';
import { scoreSanity } from '../src/engine/testkit';
import { buildLineup } from '../src/engine/ratings';
import { DATA_DIR, hasRealData, loadRealTeams } from './helpers/realTeams';

describe.skipIf(!hasRealData())('real team data', () => {
  const teams = loadRealTeams();
  const manifest = JSON.parse(readFileSync(join(DATA_DIR, 'manifest.json'), 'utf8'));

  it('has all 32 teams with a head coach and colors', () => {
    expect(teams).toHaveLength(32);
    expect(manifest.teams).toHaveLength(32);
    for (const t of teams) {
      expect(t.info.headCoach.length).toBeGreaterThan(3);
      expect(t.info.color).toMatch(/^#[0-9a-f]{6}$/i);
      expect(t.source).toBe('nflverse');
    }
  });

  it('every team can field a full lineup', () => {
    for (const t of teams) {
      const l = buildLineup(t);
      expect(l.QB, t.info.abbr).toBeTruthy();
      expect(l.OL.length, `${t.info.abbr} OL`).toBe(5);
      expect(l.WR.length, `${t.info.abbr} WR`).toBeGreaterThanOrEqual(3);
      expect(l.TE.length, `${t.info.abbr} TE`).toBeGreaterThanOrEqual(1);
      expect(l.CB.length, `${t.info.abbr} CB`).toBeGreaterThanOrEqual(2);
      // Injuries can leave a team thin at safety; a cornerback then fills in.
      expect(l.S.length + l.CB.length, `${t.info.abbr} DBs`).toBeGreaterThanOrEqual(4);
      expect(l.S.length, `${t.info.abbr} S`).toBeGreaterThanOrEqual(1);
      expect(l.EDGE.length + l.DL.length, `${t.info.abbr} DL`).toBeGreaterThanOrEqual(4);
      expect(l.K && l.P).toBeTruthy();
    }
  });

  it('ratings are on the 40-99 scale and starters average about 70', () => {
    const all: number[] = [];
    for (const t of teams) {
      const byId = new Map(t.players.map((p) => [p.id, p]));
      for (const p of t.players) {
        for (const v of Object.values(p.r)) {
          expect(v).toBeGreaterThanOrEqual(40);
          expect(v).toBeLessThanOrEqual(99);
        }
        expect(p.ovr).toBeGreaterThanOrEqual(35);
        expect(p.ovr).toBeLessThanOrEqual(99);
      }
      for (const id of [...t.depth.QB.slice(0, 1), ...t.depth.WR.slice(0, 3), ...t.depth.OL.slice(0, 5)]) all.push(byId.get(id)!.ovr);
    }
    const mean = all.reduce((a, b) => a + b, 0) / all.length;
    expect(mean).toBeGreaterThan(64);
    expect(mean).toBeLessThan(76);
  });

  it('depth charts only reference real players, with no duplicates', () => {
    for (const t of teams) {
      const ids = new Set(t.players.map((p) => p.id));
      const seen = new Set<string>();
      for (const list of Object.values(t.depth)) {
        for (const id of list) {
          expect(ids.has(id), `${t.info.abbr} ${id}`).toBe(true);
          expect(seen.has(id), `${t.info.abbr} duplicate ${id}`).toBe(false);
          seen.add(id);
        }
      }
    }
  });

  it('tendencies are sensible', () => {
    for (const t of teams) {
      const { off, def } = t.tendencies;
      expect(Math.abs(off.proe)).toBeLessThan(1);
      expect(off.shotgun).toBeGreaterThan(0.2);
      expect(off.shotgun).toBeLessThan(0.95);
      expect(def.blitz).toBeGreaterThan(0.05);
      expect(def.blitz).toBeLessThan(0.5);
      const sum = Object.values(def.coverage).reduce((a, b) => a + b, 0);
      expect(sum).toBeGreaterThan(0.97);
      expect(sum).toBeLessThan(1.03);
    }
  });

  it('files are small enough for a phone', () => {
    const dir = join(DATA_DIR, 'teams');
    for (const f of readdirSync(dir)) expect(statSync(join(dir, f)).size).toBeLessThan(15_000);
  });

  it('games with real teams finish with realistic scores', () => {
    const s = scoreSanity(300, teams);
    expect(s.avgTeamPoints).toBeGreaterThan(19.5);
    expect(s.avgTeamPoints).toBeLessThan(26.5);
    expect(s.maxTeamPoints).toBeLessThanOrEqual(70);
    expect(s.impossibleScores).toBe(0);
  }, 60000);

  it('a better team wins more often than a worse one', () => {
    const grade = (t: (typeof teams)[number]) => {
      const m = manifest.teams.find((x: { abbr: string }) => x.abbr === t.info.abbr).grades;
      return m.qb + m.ol + m.pass + m.rush + m.cover;
    };
    const sorted = [...teams].sort((a, b) => grade(b) - grade(a));
    const best = sorted.slice(0, 3);
    const worst = sorted.slice(-3);
    let wins = 0;
    let n = 0;
    for (let i = 0; i < 90; i++) {
      const b = best[i % 3];
      const w = worst[(i >> 1) % 3];
      const home = i % 2 === 0;
      const g = new Game(home ? b : w, home ? w : b, { home: 'cpu', away: 'cpu' }, { seed: 900 + i });
      g.simToEnd();
      const bScore = home ? g.sides.home.score : g.sides.away.score;
      const wScore = home ? g.sides.away.score : g.sides.home.score;
      wins += bScore > wScore ? 1 : bScore === wScore ? 0.5 : 0;
      n++;
    }
    expect(wins / n).toBeGreaterThan(0.55);
  }, 60000);
});
