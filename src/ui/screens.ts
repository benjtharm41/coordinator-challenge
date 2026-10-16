// Home menu, Situations list, My Stats and install help.
import { CONCEPTS, COVERAGES } from '../engine/playbook';
import { formatMetric, SCENARIOS, type Scenario } from '../engine/scenario';
import { exportFileName, exportJson, importJson, summarize, type GameRecord, type Save, type Tally } from '../store/store';
import { h } from './dom';

export interface ScreenCtx {
  go: (screen: 'home' | 'setup' | 'situations' | 'stats' | 'install' | 'learn') => void;
  save: () => Save;
  setSave: (s: Save) => void;
  dataNote: () => string;
  startScenario: (sc: Scenario) => void;
  /** Shown when a team picker is needed for a scenario. */
  teamPickers: () => HTMLElement;
  rerender: () => void;
  message: { text: string; bad?: boolean } | null;
  setMessage: (m: { text: string; bad?: boolean } | null) => void;
  pendingScenario: Scenario | undefined;
  pickScenario: (sc: Scenario | undefined) => void;
}

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '–');

export function homeScreen(ctx: ScreenCtx): HTMLElement {
  const s = summarize(ctx.save(), () => undefined);
  const big = (title: string, sub: string, onclick: () => void, primary = false) =>
    h('button', { class: `home-btn ${primary ? 'primary' : ''}`, onclick }, h('b', {}, title), h('small', {}, sub));
  return h('div', { class: 'screen home' },
    h('h1', {}, 'Coordinator Challenge'),
    h('p', { class: 'muted' }, 'Call every play, offense and defense, for a real NFL team.'),
    h('p', { class: 'data-note real' }, ctx.dataNote()),
    big('Play a full game', 'Pick your team and call every snap', () => ctx.go('setup'), true),
    big('Situations', '11 pressure-packed scenarios: 2-minute drill, goal-line stand, Hail Mary...', () => ctx.go('situations')),
    big('My stats', s.games ? `${s.w}-${s.l}${s.t ? '-' + s.t : ''} in ${s.games} game${s.games === 1 ? '' : 's'}. Backup and restore.` : 'Your record, play-calling success, backup', () => ctx.go('stats')),
    big('Learn the basics', 'Formations, coverages and what beats what', () => ctx.go('learn')),
    big('Put it on your phone', 'Add to your home screen. Works offline.', () => ctx.go('install')));
}

export function situationsScreen(ctx: ScreenCtx): HTMLElement {
  const sum = summarize(ctx.save(), (sid) => SCENARIOS.find((x) => x.id === sid)?.metric?.better);
  const picked = ctx.pendingScenario;
  if (picked) {
    const r = sum.scenarios[picked.id];
    return h('div', { class: 'screen' },
      h('div', { class: 'row-head' }, h('button', { class: 'linklike', onclick: () => ctx.pickScenario(undefined) }, '‹ Situations'), h('b', {}, picked.title)),
      h('div', { class: 'card scen' },
        h('p', {}, picked.situation),
        h('p', {}, h('b', { class: 'good' }, 'You win: '), picked.win),
        h('p', {}, h('b', { class: 'bad' }, 'You lose: '), picked.lose),
        picked.longShot ? h('p', { class: 'muted' }, 'This is a long shot in real football too, so even a small chance is a good outcome. (For example, real NFL offenses score about 8 times in 10 from the 3-yard line.)') : null,
        picked.playsOnly ? h('p', { class: 'muted' }, 'One play decides it: pick the call.') : null,
        r ? h('p', { class: 'muted' }, `Your record: ${r.wins}/${r.attempts} wins (${pct(r.wins, r.attempts)})${picked.metric && r.best !== undefined ? `. Best: ${formatMetric(picked, r.best)}` : ''}`) : null),
      ctx.teamPickers(),
      h('button', { class: 'primary big', onclick: () => ctx.startScenario(picked) }, 'Start'));
  }
  return h('div', { class: 'screen' },
    h('div', { class: 'row-head' }, h('button', { class: 'linklike', onclick: () => ctx.go('home') }, '‹ Menu'), h('b', {}, 'Situations')),
    h('p', { class: 'muted' }, 'Each one is a short, clear challenge. Pick one to see the details.'),
    ...SCENARIOS.map((sc) => {
      const r = sum.scenarios[sc.id];
      return h('button', { class: 'scen-card', onclick: () => ctx.pickScenario(sc) },
        h('div', { class: 'scen-top' }, h('b', {}, sc.title), h('span', { class: `tag ${sc.side}` }, sc.side === 'defense' ? 'Defense' : 'Offense')),
        h('small', {}, sc.situation),
        h('div', { class: 'scen-rec' }, r
          ? `Won ${r.wins} of ${r.attempts} (${pct(r.wins, r.attempts)})${sc.metric && r.best !== undefined ? ` · Best: ${formatMetric(sc, r.best)}` : ''}`
          : 'Not tried yet'));
    }));
}

function tallyTable(title: string, rows: Record<string, Tally>, name: (k: string) => string, minShow = 1): HTMLElement | null {
  const entries = Object.entries(rows).filter(([, t]) => t.n >= minShow).sort((a, b) => b[1].n - a[1].n);
  if (!entries.length) return null;
  return h('div', { class: 'tally' },
    h('h3', {}, title),
    h('table', { class: 'stat-table' },
      h('tr', {}, h('th', {}, ''), h('th', {}, 'Calls'), h('th', {}, 'Worked'), h('th', {}, 'Yds/play')),
      entries.map(([k, t]) => h('tr', {}, h('td', {}, name(k)), h('td', {}, String(t.n)), h('td', {}, pct(t.ok, t.n)), h('td', {}, (t.yards / t.n).toFixed(1))))));
}

function gameCard(g: GameRecord): HTMLElement {
  const d = new Date(g.ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  const b = g.box;
  const top = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  return h('details', { class: 'game-card' },
    h('summary', {}, h('span', { class: `res ${g.result}` }, g.result), ` ${g.home ? 'vs' : '@'} ${g.opp}  ${g.us}-${g.them}`, h('span', { class: 'muted' }, `  ${d}${g.mode === 'short' ? ' · short' : ''}`)),
    h('table', { class: 'box' },
      h('tr', {}, h('td', {}, g.user), h('th', {}, ''), h('td', {}, g.opp)),
      ...([
        ['Points', String(g.us), String(g.them)], ['Total yards', String(b.us.yards), String(b.them.yards)], ['Passing yards', String(b.us.pass), String(b.them.pass)],
        ['Rushing yards', String(b.us.rush), String(b.them.rush)], ['First downs', String(b.us.firstDowns), String(b.them.firstDowns)],
        ['3rd down', `${b.us.third[0]}/${b.us.third[1]}`, `${b.them.third[0]}/${b.them.third[1]}`], ['Turnovers', String(b.us.turnovers), String(b.them.turnovers)],
        ['Penalties', String(b.us.penalties), String(b.them.penalties)], ['Possession', top(b.us.top), top(b.them.top)],
      ] as [string, string, string][]).map(([l, a, c]) => h('tr', {}, h('td', {}, a), h('th', {}, l), h('td', {}, c)))),
    g.log ? h('details', { class: 'log-details' }, h('summary', {}, 'Play-by-play'), h('ol', { class: 'log-list' }, g.log.map((l) => h('li', {}, l)))) : h('p', { class: 'muted' }, 'Play-by-play is only kept for recent games.'));
}

async function shareOrDownload(text: string, name: string): Promise<'shared' | 'downloaded' | 'failed'> {
  try {
    const file = new File([text], name, { type: 'application/json' });
    const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
    if (nav.canShare?.({ files: [file] })) {
      await nav.share({ files: [file], title: 'Coordinator Challenge backup' });
      return 'shared';
    }
  } catch (e) {
    if ((e as Error).name === 'AbortError') return 'failed';
  }
  try {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = h('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return 'downloaded';
  } catch {
    return 'failed';
  }
}

export function statsScreen(ctx: ScreenCtx): HTMLElement {
  const save = ctx.save();
  const sum = summarize(save, (sid) => SCENARIOS.find((x) => x.id === sid)?.metric?.better);
  const games = sum.games;
  const msg = ctx.message;
  const doImport = (text: string, mode: 'merge' | 'replace') => {
    const r = importJson(text, ctx.save(), mode);
    if ('error' in r) ctx.setMessage({ text: r.error, bad: true });
    else {
      ctx.setSave(r.save);
      ctx.setMessage({ text: mode === 'replace' ? 'Backup restored.' : r.added ? `Added ${r.added} item${r.added === 1 ? '' : 's'} from the backup.` : 'Nothing new in that backup: everything was already saved.' });
    }
    ctx.rerender();
  };
  const fileInput = h('input', {
    type: 'file', accept: '.json,application/json', class: 'hidden-input',
    onchange: (e: Event) => {
      const f = (e.target as HTMLInputElement).files?.[0];
      if (!f) return;
      f.text().then((t) => {
        const replace = save.games.length + save.scenarios.length > 0 && confirm('Replace everything on this device with the backup?\n\nOK = replace\nCancel = add the backup to what is already here');
        doImport(t, replace ? 'replace' : 'merge');
      });
    },
  });
  const paste = h('textarea', { class: 'paste', placeholder: 'Paste backup text here', rows: '3' });
  return h('div', { class: 'screen stats' },
    h('div', { class: 'row-head' }, h('button', { class: 'linklike', onclick: () => ctx.go('home') }, '‹ Menu'), h('b', {}, 'My stats')),
    msg ? h('div', { class: `notice ${msg.bad ? 'bad' : 'good'}` }, msg.text) : null,
    h('div', { class: 'card' },
      h('h2', {}, games ? `${sum.w}-${sum.l}${sum.t ? '-' + sum.t : ''}` : 'No games yet'),
      games ? h('p', { class: 'muted' }, `${pct(sum.w, games)} wins. Points for ${sum.pf} (${(sum.pf / games).toFixed(1)} per game), against ${sum.pa} (${(sum.pa / games).toFixed(1)} per game).`) : h('p', { class: 'muted' }, 'Finish a full game and it shows up here.'),
      sum.byTeam.length
        ? h('table', { class: 'stat-table' }, h('tr', {}, h('th', {}, 'Team'), h('th', {}, 'Record'), h('th', {}, 'PF'), h('th', {}, 'PA')),
            sum.byTeam.map((t) => h('tr', {}, h('td', {}, t.team), h('td', {}, `${t.w}-${t.l}${t.t ? '-' + t.t : ''}`), h('td', {}, String(t.pf)), h('td', {}, String(t.pa)))))
        : null),
    h('details', { class: 'learn-sec', open: games > 0 },
      h('summary', {}, 'My play calling'),
      games ? [
        h('p', { class: 'muted' }, '"Worked" means the offense got what it needed for that down (or scored). On defense it means you stopped them.'),
        tallyTable('Offense: by play', sum.offConcepts, (k) => CONCEPTS[k as keyof typeof CONCEPTS]?.name ?? k),
        tallyTable('Offense: by situation', sum.offSituations, (k) => k),
        tallyTable('Defense: by coverage', sum.defCoverages, (k) => COVERAGES[k as keyof typeof COVERAGES]?.name ?? k),
        tallyTable('Defense: by situation', sum.defSituations, (k) => k),
      ] : h('p', { class: 'muted' }, 'Nothing yet.')),
    h('details', { class: 'learn-sec' },
      h('summary', {}, 'Situations'),
      h('table', { class: 'stat-table' }, h('tr', {}, h('th', {}, ''), h('th', {}, 'Tries'), h('th', {}, 'Wins'), h('th', {}, 'Best')),
        SCENARIOS.map((sc) => {
          const r = sum.scenarios[sc.id];
          return h('tr', {}, h('td', {}, sc.title), h('td', {}, String(r?.attempts ?? 0)), h('td', {}, r ? pct(r.wins, r.attempts) : '–'), h('td', {}, r && sc.metric && r.best !== undefined ? formatMetric(sc, r.best) : '–'));
        }))),
    h('details', { class: 'learn-sec' },
      h('summary', {}, `Game log (${games})`),
      games ? [...save.games].reverse().slice(0, 25).map(gameCard) : h('p', { class: 'muted' }, 'No games yet.')),
    h('div', { class: 'card' },
      h('h3', {}, 'Back up your stats'),
      h('p', { class: 'muted' }, 'Stats live in this browser. Clearing browser data erases them, so save a backup file now and then.'),
      h('div', { class: 'grid2' },
        h('button', { class: 'primary', onclick: async () => {
          const r = await shareOrDownload(exportJson(ctx.save()), exportFileName());
          ctx.setMessage(r === 'failed' ? { text: 'Could not save the backup. Try "Copy backup text" instead.', bad: true } : { text: r === 'shared' ? 'Choose where to save it (for example "Save to Files").' : 'Backup file saved to your downloads.' });
          ctx.rerender();
        } }, 'Save backup file'),
        h('button', { onclick: () => fileInput.click() }, 'Restore from file')),
      fileInput,
      h('div', { class: 'grid2', style: { marginTop: '8px' } },
        h('button', { onclick: async () => {
          try {
            await navigator.clipboard.writeText(exportJson(ctx.save()));
            ctx.setMessage({ text: 'Backup text copied. Paste it somewhere safe (like a note to yourself).' });
          } catch {
            ctx.setMessage({ text: 'Could not copy automatically. Use "Save backup file".', bad: true });
          }
          ctx.rerender();
        } }, 'Copy backup text'),
        h('button', { onclick: () => { const t = (paste as HTMLTextAreaElement).value.trim(); if (t) doImport(t, 'merge'); else { ctx.setMessage({ text: 'Paste the backup text into the box first.', bad: true }); ctx.rerender(); } } }, 'Restore pasted text')),
      paste,
      h('button', { class: 'danger', onclick: () => {
        if (confirm('Erase ALL saved games, stats and Situations results on this device? This cannot be undone.')) {
          ctx.setSave({ version: 1, games: [], scenarios: [] });
          ctx.setMessage({ text: 'All stats erased.' });
          ctx.rerender();
        }
      } }, 'Erase all my stats')));
}

export function installScreen(ctx: ScreenCtx): HTMLElement {
  const step = (n: number, text: string) => h('li', {}, h('span', { class: 'num' }, String(n)), h('span', {}, text));
  return h('div', { class: 'screen' },
    h('div', { class: 'row-head' }, h('button', { class: 'linklike', onclick: () => ctx.go('home') }, '‹ Menu'), h('b', {}, 'Put it on your phone')),
    h('p', { class: 'muted' }, 'Adding it to your home screen gives it an app icon and full-screen play. After the first time you open it with internet, it works offline too.'),
    h('div', { class: 'card' },
      h('h3', {}, 'iPhone or iPad (use Safari)'),
      h('ol', { class: 'steps' },
        step(1, 'Open this page in Safari (it has to be Safari, not Chrome).'),
        step(2, 'Tap the Share button: the square with an arrow pointing up, at the bottom of the screen.'),
        step(3, 'Scroll down in the menu and tap "Add to Home Screen".'),
        step(4, 'Tap "Add" in the top-right corner. The icon appears on your home screen.'))),
    h('div', { class: 'card' },
      h('h3', {}, 'Android (use Chrome)'),
      h('ol', { class: 'steps' },
        step(1, 'Open this page in Chrome.'),
        step(2, 'Tap the three dots (⋮) in the top-right corner.'),
        step(3, 'Tap "Install app" (or "Add to Home screen").'),
        step(4, 'Tap "Install". The icon appears on your home screen.'))),
    h('p', { class: 'muted' }, 'Your stats are saved on the device you play on. Use "My stats" to save a backup file now and then.'));
}
