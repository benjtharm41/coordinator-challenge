// Calibration report: sims computer-vs-computer games and compares to real NFL averages.
// Run with:  npm run calibrate            (1,000 games)
//            npm run calibrate -- 300     (quicker)
import { writeFileSync } from 'node:fs';
import { formatMetric, metrics, simulate, TARGETS } from '../src/engine/calibration';
import { Game } from '../src/engine/game';
import { hasRealData, loadRealTeams } from '../tests/helpers/realTeams';
import { allPlaceholderTeams } from '../src/engine/placeholder';
import { buildLineup, unitRatings } from '../src/engine/ratings';
import { Rng } from '../src/engine/rng';
import type { Team } from '../src/engine/types';

const N = Number(process.argv[2] ?? 1000);
const lines: string[] = [];
const out = (s = '') => {
  lines.push(s);
  console.log(s);
};

const t0 = Date.now();
const real = hasRealData() ? loadRealTeams() : undefined;
const totals = simulate({ games: N, seed: 2026, teams: real });
const ms = Date.now() - t0;

out(`# Calibration report`);
out();
out(`${N} computer-vs-computer games (${real ? 'real 2026 rosters and tendencies' : 'placeholder rosters'}), simulated in ${(ms / 1000).toFixed(1)}s.`);
out(`Real numbers: nflverse play-by-play, 2025 season + 2026 to date (${TARGETS.games} regular-season games).`);
out();
out(`| Stat | Sim | Real NFL | Within tolerance? |`);
out(`|---|---|---|---|`);
let pass = 0;
const ms_ = metrics(totals);
for (const m of ms_) {
  const ok = m.real === null || Math.abs(m.sim - m.real) <= m.tol;
  if (ok) pass++;
  out(`| ${m.label} | ${formatMetric(m.sim, m.fmt)} | ${m.real === null ? 'n/a' : formatMetric(m.real, m.fmt)} | ${ok ? 'yes' : `NO (±${formatMetric(m.tol, m.fmt)})`} |`);
}
out();
out(`${pass} of ${ms_.length} stats within tolerance.`);
const tg = totals.games * 2;
out();
out(`Drive results (share of drives): ` + Object.entries(totals.driveResults).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${((v / totals.drives) * 100).toFixed(1)}%`).join(', '));
out(`Average game clock per offensive play: ${(totals.scrimmageSeconds / totals.plays).toFixed(1)}s. Ties: ${totals.ties}.`);
void tg;

// ---- Short game mode
const short = simulate({ games: Math.max(100, Math.round(N / 5)), seed: 7, short: true });
out();
out(`## Short-quarters mode`);
out(`Plays per team per game: ${(short.plays / (short.games * 2)).toFixed(1)} (full game: ${(totals.plays / tg).toFixed(1)}). Points per team: ${(short.points / (short.games * 2)).toFixed(1)}.`);

// ---- Do better players matter?
const teams = real ?? allPlaceholderTeams();
const strength = (t: Team) => {
  const r = unitRatings(buildLineup(t));
  return (r.qbAcc + r.passBlock + r.runBlock + r.rbRush + r.passRush + r.runDef + r.coverage) / 7;
};
const ranked = [...teams].sort((a, b) => strength(b) - strength(a));
const headToHead = (a: Team, b: Team, n: number) => {
  const rng = new Rng(99);
  let wins = 0;
  let margin = 0;
  for (let i = 0; i < n; i++) {
    const aHome = i % 2 === 0;
    const g = new Game(aHome ? a : b, aHome ? b : a, { home: 'cpu', away: 'cpu' }, { seed: rng.int(1, 2 ** 31) });
    g.simToEnd();
    const aSide = aHome ? 'home' : 'away';
    const bSide = aHome ? 'away' : 'home';
    if (g.s.winner === aSide) wins++;
    else if (g.s.winner === 'tie') wins += 0.5;
    margin += g.sides[aSide].score - g.sides[bSide].score;
  }
  return { winPct: wins / n, margin: margin / n };
};
out();
out(`## Do better players matter?`);
const best = ranked[0];
const worst = ranked[ranked.length - 1];
const mid = ranked[Math.floor(ranked.length / 2)];
for (const [a, b] of [[best, worst], [best, mid], [mid, worst]] as [Team, Team][]) {
  const r = headToHead(a, b, 400);
  out(`- ${a.info.abbr} (rating ${strength(a).toFixed(1)}) vs ${b.info.abbr} (rating ${strength(b).toFixed(1)}): wins ${(r.winPct * 100).toFixed(0)}%, average margin ${r.margin >= 0 ? '+' : ''}${r.margin.toFixed(1)}`);
}

// ---- Do better calls matter?
const buckets = new Map<string, { n: number; yards: number; success: number }>();
const rng = new Rng(5);
for (let i = 0; i < Math.max(150, N / 4); i++) {
  const g = new Game(teams[rng.int(0, teams.length - 1)], teams[rng.int(0, teams.length - 1)], { home: 'cpu', away: 'cpu' }, { seed: rng.int(1, 2 ** 31) });
  g.simToEnd();
  for (const e of g.log) {
    const o = e.outcome;
    if (!o || e.kind === 'penalty' || e.kind === '2pt' || !['run', 'pass', 'sack', 'scramble'].includes(e.kind)) continue;
    const a = o.matchup.adv;
    const key = a <= -2 ? '1: bad call (advantage -2 or worse)' : a < -0.5 ? '2: slightly bad' : a <= 0.5 ? '3: neutral' : a < 2 ? '4: slightly good' : '5: great call (+2 or better)';
    const b = buckets.get(key) ?? { n: 0, yards: 0, success: 0 };
    b.n++;
    b.yards += o.yards;
    const need = e.down === 1 ? 0.4 * e.distance : e.down === 2 ? 0.6 * e.distance : e.distance;
    if (o.yards >= need && !o.intercepted && !o.fumbleLost) b.success++;
    buckets.set(key, b);
  }
}
out();
out(`## Do better calls matter?`);
out(`| Call quality (matchup advantage) | Share of plays | Yards per play | Success rate |`);
out(`|---|---|---|---|`);
const totalN = [...buckets.values()].reduce((a, b) => a + b.n, 0);
for (const [k, b] of [...buckets.entries()].sort()) {
  out(`| ${k.slice(3)} | ${((b.n / totalN) * 100).toFixed(0)}% | ${(b.yards / b.n).toFixed(2)} | ${((b.success / b.n) * 100).toFixed(0)}% |`);
}

writeFileSync('docs/CALIBRATION.md', lines.join('\n') + '\n');
console.log('\nSaved to docs/CALIBRATION.md');
