// Saving, summaries, and backup export/import.
import { describe, expect, it } from 'vitest';
import { Game } from '../src/engine/game';
import { averageTeam } from '../src/engine/testkit';
import { addGame, addScenario, callRecords, emptySave, exportJson, gameRecord, importJson, scenarioRecord, summarize, validate } from '../src/store/store';
import { SCENARIOS } from '../src/engine/scenario';

function playedGame(seed: number) {
  const g = new Game(averageTeam('KC'), averageTeam('BUF'), { home: 'cpu', away: 'cpu' }, { seed });
  g.simToEnd();
  return g;
}

describe('saved stats', () => {
  const g1 = playedGame(1);
  const g2 = playedGame(2);
  let save = emptySave();
  save = addGame(save, gameRecord(g1, 'home', 'full', callRecords(g1.log, 'home')));
  save = addGame(save, gameRecord(g2, 'away', 'short', callRecords(g2.log, 'away')));
  save = addScenario(save, scenarioRecord(SCENARIOS[0], { result: 'win', metric: 42, message: '' }, 'KC', 'BUF'));
  save = addScenario(save, scenarioRecord(SCENARIOS[0], { result: 'lose', message: '' }, 'KC', 'BUF'));
  save = addScenario(save, scenarioRecord(SCENARIOS[0], { result: 'win', metric: 61, message: '' }, 'KC', 'BUF'));

  it('records and summarizes games', () => {
    const s = summarize(save, (sid) => SCENARIOS.find((x) => x.id === sid)?.metric?.better);
    expect(s.games).toBe(2);
    expect(s.w + s.l + s.t).toBe(2);
    expect(s.pf).toBe(g1.sides.home.score + g2.sides.away.score);
    expect(s.pa).toBe(g1.sides.away.score + g2.sides.home.score);
    expect(Object.keys(s.offConcepts).length).toBeGreaterThan(3);
    expect(Object.keys(s.defCoverages).length).toBeGreaterThan(2);
    const total = Object.values(s.offConcepts).reduce((a, t) => a + t.n, 0);
    expect(total).toBeGreaterThan(30);
    for (const t of Object.values(s.offConcepts)) expect(t.ok).toBeLessThanOrEqual(t.n);
  });

  it('tracks best scenario result in the right direction', () => {
    const s = summarize(save, (sid) => SCENARIOS.find((x) => x.id === sid)?.metric?.better);
    const e = s.scenarios['two_minute'];
    expect(e.attempts).toBe(3);
    expect(e.wins).toBe(2);
    expect(e.best).toBe(61); // more time left is better
  });

  it('survives an export and import round trip', () => {
    const text = exportJson(save);
    const r = importJson(text, emptySave(), 'replace');
    expect('save' in r && r.save.games.length).toBe(2);
    expect('save' in r && r.save.scenarios.length).toBe(3);
  });

  it('merging a backup twice does not create duplicates', () => {
    const text = exportJson(save);
    const once = importJson(text, save, 'merge');
    expect('save' in once && once.save.games.length).toBe(2);
    expect('save' in once && once.added).toBe(0);
    const fresh = importJson(text, emptySave(), 'merge');
    expect('save' in fresh && fresh.save.games.length).toBe(2);
  });

  it('rejects files that are not backups', () => {
    expect('error' in importJson('not json', save, 'merge')).toBe(true);
    expect('error' in importJson('{"hello":1}', save, 'merge')).toBe(true);
    expect('error' in importJson(JSON.stringify({ version: 1, games: [{ id: 1 }], scenarios: [] }), save, 'merge')).toBe(true);
    expect(validate({ version: 2, games: [], scenarios: [] })).toBeNull();
  });

  it('ignores unexpected extra fields in a backup', () => {
    const data = JSON.parse(exportJson(save));
    data.games[0].evil = '<script>alert(1)</script>';
    data.extra = { x: 1 };
    const v = validate(data)!;
    expect((v.games[0] as unknown as Record<string, unknown>).evil).toBeUndefined();
  });
});
