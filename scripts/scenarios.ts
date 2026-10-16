// Plain-English check that each Situations scenario is neither impossible nor a given.
// Run with:  npm run scenarios   (writes docs/SCENARIOS.md)
import { writeFileSync } from 'node:fs';
import { SCENARIOS } from '../src/engine/scenario';
import { averageTeam, simulateScenario } from '../src/engine/testkit';
import { Rng } from '../src/engine/rng';

const N = Number(process.argv[2] ?? 300);
const lines: string[] = [];
const out = (s = '') => { lines.push(s); console.log(s); };
out('# Situations: are they fair?');
out();
out(`Each scenario was played ${N} times with a league-average team on each side and the computer calling plays for you. A scenario passes if it is hard but winnable: you win between 10% and 90% of the time. Two are long shots by design (a Hail Mary and a 10-point comeback with 5 minutes left); those only need to be possible (at least 3%).`);
out();
out('| Scenario | You win | Tie | You lose | Check |');
out('|---|---|---|---|---|');
const a = averageTeam('KC');
const b = averageTeam('BUF');
let bad = 0;
for (const sc of SCENARIOS) {
  const rng = new Rng(77);
  let w = 0, t = 0, l = 0, unfinished = 0;
  for (let i = 0; i < N; i++) {
    const r = simulateScenario(sc, a, b, rng.int(1, 2 ** 31));
    if (!r) unfinished++;
    else if (r.result === 'win') w++;
    else if (r.result === 'tie') t++;
    else l++;
  }
  const pct = (x: number) => `${Math.round((x / N) * 100)}%`;
  const rate = (w + t / 2) / N;
  const ok = unfinished === 0 && rate >= (sc.longShot ? 0.03 : 0.1) && rate <= 0.9;
  if (!ok) bad++;
  out(`| ${sc.title} | ${pct(w)} | ${pct(t)} | ${pct(l)} | ${ok ? 'pass' : `**FAIL** (${unfinished} unfinished)`} |`);
}
out();
out(bad === 0 ? 'Every scenario is winnable and none is a sure thing.' : `${bad} scenario(s) need tuning.`);
writeFileSync('docs/SCENARIOS.md', lines.join('\n') + '\n');
