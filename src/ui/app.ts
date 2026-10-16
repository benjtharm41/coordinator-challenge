// Phase 1 text-only interface: pick teams, call every play, read the play-by-play.
import { chooseTry, chooseTwoPointPlay, leagueXPass, quickPicksDefense, quickPicksOffense, type Situation } from '../engine/ai';
import { recommendFourthDown, recommendTry } from '../engine/analytics';
import { Game, type PlayLog } from '../engine/game';
import { defCallName } from '../engine/narrate';
import { allPlaceholderTeams } from '../engine/placeholder';
import { CONCEPTS, COVERAGES, FORMATIONS, FRONTS, PRESSURES, pressuresFor } from '../engine/playbook';
import { fieldGoalProb } from '../engine/special';
import { boxScore, playerSummary } from '../engine/stats';
import {
  conceptMatchups, COVERAGE_PLAIN, describeConcept, describeCoverage, describeFormation, describeFront, describePressure,
  explainPlay, FORMATION_SHORT, FRONT_PLAIN, coverageMatchups,
} from '../engine/teach';
import { other, type Concept, type Coverage, type DefCall, type Formation, type Front, type OffCall, type OffChoice, type Pressure, type Side, type Team, type Tempo } from '../engine/types';

type Screen = 'setup' | 'game' | 'learn';

interface UIState {
  screen: Screen;
  learnReturn: Screen;
  game?: Game;
  userSide: Side;
  tempo: Tempo;
  formation?: Formation;
  front?: Front;
  pressure: Pressure;
  cpuChoice?: OffChoice;
  cpuTry?: OffCall;
  tryMode: boolean;
  recent: PlayLog[];
  showLog: boolean;
  settings: { coachRec: boolean; tips: boolean; autoWhy: boolean };
  setup: { team: string; opp: string; home: boolean; short: boolean };
}

const teams = allPlaceholderTeams();
const byAbbr = (a: string) => teams.find((t) => t.info.abbr === a)!;

const SETTINGS_KEY = 'cc.settings.v1';
function loadSettings(): UIState['settings'] {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { coachRec: true, tips: true, autoWhy: true, ...JSON.parse(raw) };
  } catch {
    /* storage may be unavailable */
  }
  return { coachRec: true, tips: true, autoWhy: true };
}
function saveSettings(s: UIState['settings']) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

const st: UIState = {
  screen: 'setup', learnReturn: 'setup', userSide: 'home', tempo: 'normal', pressure: 'base', tryMode: false, recent: [], showLog: false,
  settings: loadSettings(),
  setup: { team: 'KC', opp: 'BUF', home: true, short: false },
};

let root: HTMLElement;

// ---------- tiny DOM helper ----------
type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, unknown> = {}, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k === 'class') el.className = String(v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

export function startApp(el: HTMLElement) {
  root = el;
  render();
}

function render() {
  root.replaceChildren(st.screen === 'setup' ? setupScreen() : st.screen === 'learn' ? learnScreen() : gameScreen());
}

// ---------- helpers ----------
const g = () => st.game!;
const userTeam = () => g().sides[st.userSide];
const cpuTeam = () => g().sides[other(st.userSide)];

function fmtClock(sec: number) {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
const qName = (q: number) => (q <= 4 ? `Q${q}` : 'OT');
const ord = (n: number) => ['', '1st', '2nd', '3rd', '4th'][n] ?? `${n}th`;

function spotText(game: Game, offense: Side, yardline: number) {
  if (yardline === 50) return 'midfield';
  const off = game.sides[offense].team.info.abbr;
  const def = game.sides[other(offense)].team.info.abbr;
  return yardline > 50 ? `${off} ${100 - yardline}` : `${def} ${yardline}`;
}

function downText(game: Game) {
  const s = game.s;
  if (s.phase !== 'scrimmage') return s.phase === 'try' ? 'Extra point try' : s.phase === 'kickoff' ? 'Kickoff' : 'Final';
  const dist = s.yardline <= s.distance ? 'Goal' : String(s.distance);
  return `${ord(s.down)} & ${dist} · ${spotText(game, s.possession, s.yardline)}`;
}

// ---------- game flow ----------
function newGame() {
  const mine = byAbbr(st.setup.team);
  const opp = byAbbr(st.setup.opp);
  st.userSide = st.setup.home ? 'home' : 'away';
  const home = st.setup.home ? mine : opp;
  const away = st.setup.home ? opp : mine;
  st.game = new Game(home, away, { home: st.setup.home ? 'human' : 'cpu', away: st.setup.home ? 'cpu' : 'human' }, { short: st.setup.short });
  st.recent = [...st.game.log];
  st.tempo = 'normal';
  resetSelection();
  st.screen = 'game';
  advance();
}

function resetSelection() {
  st.formation = undefined;
  st.front = undefined;
  st.cpuChoice = undefined;
  st.cpuTry = undefined;
  st.tryMode = false;
}

/** Run any steps that don't need the human, stopping at the next human decision. */
function advance() {
  const game = g();
  for (let i = 0; i < 50; i++) {
    const d = game.pending();
    const before = game.log.length;
    if (d.kind === 'final') break;
    if (d.kind === 'kickoff') {
      if (game.sides[d.kicking].controller === 'cpu') game.cpuAct();
      else break;
    } else if (d.kind === 'try') {
      if (game.sides[d.team].controller === 'human') break;
      const t = game.sides[d.team];
      const choice = chooseTry(t.score - game.sides[other(d.team)].score, game.s.quarter, game.secondsLeftGame());
      if (choice === '2pt') {
        st.cpuTry = chooseTwoPointPlay(t.team, game.rng);
        break; // the human picks the defense
      }
      game.doTry('xp');
    } else {
      // Snap.
      if (!st.cpuChoice) game.cpuTimeouts();
      if (d.offense === st.userSide) break;
      if (!st.cpuChoice) st.cpuChoice = game.cpuOffenseChoice();
      if (st.cpuChoice.type !== 'play') {
        game.snap(st.cpuChoice);
        st.cpuChoice = undefined;
      } else break; // the human picks the defense
    }
    st.recent.push(...game.log.slice(before));
  }
  render();
}

function act(fn: () => void) {
  const game = g();
  const before = game.log.length;
  st.recent = [];
  fn();
  st.recent.push(...game.log.slice(before));
  resetSelection();
  advance();
}

function callOffense(call: OffCall) {
  if (st.tryMode) act(() => g().doTry('2pt', call));
  else act(() => g().snap({ type: 'play', call, tempo: st.tempo }));
}

function callDefense(dc: DefCall) {
  if (st.cpuTry) {
    const oc = st.cpuTry;
    act(() => g().doTry('2pt', oc, dc));
    return;
  }
  const choice = st.cpuChoice!;
  act(() => g().snap(choice, dc));
}

// ---------- screens ----------
function setupScreen(): HTMLElement {
  const opt = (t: Team, sel: string) => h('option', { value: t.info.abbr, selected: t.info.abbr === sel }, `${t.info.name}`);
  const teamSelect = (key: 'team' | 'opp') =>
    h('select', { onchange: (e: Event) => { st.setup[key] = (e.target as HTMLSelectElement).value; render(); } }, teams.map((t) => opt(t, st.setup[key])));
  const mine = byAbbr(st.setup.team);
  const opp = byAbbr(st.setup.opp);
  const toggle = (label: string, key: keyof UIState['settings'], help: string) =>
    h('label', { class: 'toggle' },
      h('input', { type: 'checkbox', checked: st.settings[key], onchange: (e: Event) => { st.settings[key] = (e.target as HTMLInputElement).checked; saveSettings(st.settings); } }),
      h('span', {}, h('b', {}, label), h('small', {}, help)));
  return h('div', { class: 'screen setup' },
    h('h1', {}, 'Coordinator Challenge'),
    h('p', { class: 'muted' }, 'You call every play: offense and defense. Phase 1: text play-by-play with placeholder players.'),
    h('div', { class: 'card' },
      h('label', { class: 'field' }, h('span', {}, 'Your team'), teamSelect('team')),
      h('div', { class: 'coach' }, `Your head coach: ${mine.info.headCoach}`),
      h('label', { class: 'field' }, h('span', {}, 'Opponent'), teamSelect('opp')),
      h('div', { class: 'coach' }, `Their play-caller: ${opp.info.headCoach}`),
      st.setup.team === st.setup.opp ? h('div', { class: 'warn' }, 'Pick two different teams.') : null,
      h('div', { class: 'seg' },
        h('button', { class: st.setup.home ? 'on' : '', onclick: () => { st.setup.home = true; render(); } }, 'Home'),
        h('button', { class: !st.setup.home ? 'on' : '', onclick: () => { st.setup.home = false; render(); } }, 'Away')),
      h('div', { class: 'seg' },
        h('button', { class: !st.setup.short ? 'on' : '', onclick: () => { st.setup.short = false; render(); } }, 'Full game (~30 min)'),
        h('button', { class: st.setup.short ? 'on' : '', onclick: () => { st.setup.short = true; render(); } }, 'Short quarters (~15 min)')),
    ),
    h('div', { class: 'card' },
      toggle("Coach's recommendation", 'coachRec', 'Suggests what to do on 4th downs and after touchdowns, with a reason.'),
      toggle('Play tips on buttons', 'tips', 'Shows what each call does and what it beats.'),
      toggle('Explain every play', 'autoWhy', 'Opens the "why it worked / failed" note automatically.')),
    h('button', { class: 'primary big', disabled: st.setup.team === st.setup.opp, onclick: newGame }, 'Kick off'),
    h('button', { class: 'ghost big', onclick: () => { st.learnReturn = 'setup'; st.screen = 'learn'; render(); } }, 'Learn the basics'),
  );
}

function scoreboard(): HTMLElement {
  const game = g();
  const side = (s: Side) => {
    const t = game.sides[s];
    const hasBall = game.s.possession === s && game.s.phase !== 'final';
    return h('div', { class: `sb-team ${s}`, style: { borderColor: t.team.info.color } },
      h('div', { class: 'sb-abbr' }, t.team.info.abbr, hasBall ? h('span', { class: 'ball' }, ' 🏈') : null, s === st.userSide ? h('span', { class: 'you' }, 'YOU') : null),
      h('div', { class: 'sb-score' }, String(t.score)),
      h('div', { class: 'sb-to' }, Array.from({ length: game.s.ot.on ? 2 : 3 }, (_, i) => h('i', { class: i < t.timeouts ? 'full' : '' }))));
  };
  return h('header', { class: 'scoreboard' },
    h('div', { class: 'sb-row' },
      side('away'),
      h('div', { class: 'sb-mid' },
        h('div', { class: 'sb-clock' }, game.s.phase === 'final' ? 'FINAL' : `${qName(game.s.quarter)} ${fmtClock(game.s.clock)}`),
        h('div', { class: 'sb-run' }, game.s.clockRunning && game.s.phase === 'scrimmage' ? '⏱ clock running' : '')),
      side('home')),
    h('div', { class: 'sb-down' }, downText(game)));
}

function entryClass(e: PlayLog) {
  if (e.points) return 'score';
  if (e.turnover) return 'turnover';
  if (e.kind === 'info' || e.kind === 'timeout') return 'info';
  return '';
}

function lastPlayCard(): HTMLElement | null {
  const game = g();
  const items = st.recent.filter((e) => e.kind !== 'info' || /warning|quarter|Halftime|Overtime|toss|Turnover|Final|receive/.test(e.text));
  if (!items.length) return null;
  const rows = items.map((e) => {
    const off = game.sides[e.offense].team.info.abbr;
    const meta = e.down > 0 && e.kind !== 'info' && e.kind !== 'timeout' ? `${off} · ${ord(e.down)} & ${e.distance} · ${qName(e.quarter)} ${fmtClock(e.clock)}` : '';
    const why = e.outcome && e.offCall && e.defCall && e.kind !== 'penalty'
      ? h('details', { class: 'why', open: st.settings.autoWhy },
          h('summary', {}, e.offense === st.userSide ? 'Why it worked / failed' : 'What happened on defense'),
          h('p', {}, explainPlay(e.outcome, e.offCall, e.defCall, e.offense === st.userSide, e.down || 4, e.distance || 2)),
          h('p', { class: 'calls' }, `Offense: ${FORMATIONS[e.offCall.formation].name} · ${CONCEPTS[e.offCall.concept].name}. Defense: ${defCallName(e.defCall)}.`))
      : null;
    return h('div', { class: `play ${entryClass(e)}` }, meta ? h('div', { class: 'meta' }, meta) : null, h('div', { class: 'txt' }, e.text), why);
  });
  return h('section', { class: 'card last' }, rows);
}

function logPanel(): HTMLElement {
  const game = g();
  return h('section', { class: 'card log' },
    h('button', { class: 'linklike', onclick: () => { st.showLog = !st.showLog; render(); } }, st.showLog ? 'Hide play-by-play ▲' : 'Show full play-by-play ▼'),
    st.showLog
      ? h('ol', { reversed: true }, [...game.log].reverse().slice(0, 250).map((e) =>
          h('li', { class: entryClass(e) },
            h('span', { class: 'meta' }, `${qName(e.quarter)} ${fmtClock(e.clock)} ${e.down ? `${game.sides[e.offense].team.info.abbr} ${ord(e.down)}&${e.distance}` : ''}`),
            ' ', e.text)))
      : null);
}

function gameScreen(): HTMLElement {
  const game = g();
  return h('div', { class: 'screen game' },
    scoreboard(),
    h('div', { class: 'opp-line' }, `vs ${cpuTeam().team.info.name} · play-caller ${cpuTeam().team.info.headCoach}`,
      h('button', { class: 'linklike', onclick: () => { st.learnReturn = 'game'; st.screen = 'learn'; render(); } }, 'Learn')),
    lastPlayCard(),
    game.s.phase === 'final' ? finalPanel() : null,
    logPanel(),
    game.s.phase === 'final' ? null : h('div', { class: 'sheet-spacer' }),
    game.s.phase === 'final' ? null : controls());
}

// ---------- the bottom sheet ----------
function controls(): HTMLElement {
  const game = g();
  const d = game.pending();
  let body: (HTMLElement | null)[] = [];
  if (d.kind === 'kickoff') {
    body = [h('div', { class: 'prompt' }, 'Your kickoff.'),
      h('div', { class: 'grid2' },
        h('button', { class: 'primary', onclick: () => act(() => game.doKickoff(false)) }, 'Kick off'),
        d.canOnside ? h('button', { onclick: () => act(() => game.doKickoff(true)) }, 'Onside kick', h('small', {}, 'About 1 in 8 recovered')) : null)];
  } else if (d.kind === 'try' && st.cpuTry) {
    body = defensePicker(`${cpuTeam().team.info.abbr} go for 2! They line up in ${FORMATIONS[st.cpuTry.formation].name}.`, st.cpuTry.formation, true);
  } else if (d.kind === 'try') {
    if (st.tryMode) body = offensePicker('2-point try from the 2. Pick your play.', true);
    else {
      const diff = userTeam().score - cpuTeam().score;
      const rec = recommendTry({ diffAfterTD: diff, quarter: game.s.quarter, secondsLeftInGame: game.secondsLeftGame() });
      body = [h('div', { class: 'prompt' }, 'Touchdown! Kick the extra point or go for 2?'),
        st.settings.coachRec ? h('div', { class: 'rec' }, `Coach: ${rec.choice === 'xp' ? 'Kick it' : 'Go for 2'}. ${rec.reason}`) : null,
        h('div', { class: 'grid2' },
          h('button', { class: 'primary', onclick: () => act(() => game.doTry('xp')) }, 'Extra point', h('small', {}, 'About 95%')),
          h('button', { onclick: () => { st.tryMode = true; render(); } }, 'Go for 2', h('small', {}, 'About 48%')))];
    }
  } else if (d.kind === 'snap') {
    if (d.offense === st.userSide) body = offensePicker(null, false);
    else body = defensePicker(null, (st.cpuChoice as { call: OffCall }).call.formation, false);
  }
  return h('div', { class: 'sheet' }, body);
}

function tipLine(text: string) {
  return st.settings.tips ? h('small', {}, text) : null;
}

function situationForPicks(asTry: boolean): Situation {
  const s = g().situation();
  return asTry ? { ...s, down: 4, distance: 2, yardline: 2 } : s;
}

function offensePicker(title: string | null, asTry: boolean): HTMLElement[] {
  const game = g();
  const s = situationForPicks(asTry);
  const out: HTMLElement[] = [];
  if (title) out.push(h('div', { class: 'prompt' }, title));

  if (st.formation) {
    const f = st.formation;
    const avail = FORMATIONS[f].concepts.filter((c) => conceptAllowed(c, s));
    const btn = (c: Concept) => {
      const m = conceptMatchups(c);
      const tip = [m.strong.length ? `Beats ${m.strong.map((x) => COVERAGES[x].name).join(', ')}` : '', m.weak.length ? `Weak vs ${m.weak.map((x) => COVERAGES[x].name).join(', ')}` : ''].filter(Boolean).join(' · ');
      return h('button', { class: 'call', onclick: () => callOffense({ formation: f, concept: c }) }, CONCEPTS[c].name, tipLine(CONCEPTS[c].blurb), tipLine(tip));
    };
    out.push(h('div', { class: 'row-head' }, h('button', { class: 'linklike', onclick: () => { st.formation = undefined; render(); } }, '‹ Formations'), h('b', {}, FORMATIONS[f].name)));
    const runs = avail.filter((c) => CONCEPTS[c].kind === 'run');
    const passes = avail.filter((c) => CONCEPTS[c].kind === 'pass');
    if (runs.length) out.push(h('div', { class: 'label' }, 'Runs'), h('div', { class: 'grid2' }, runs.map(btn)));
    if (passes.length) out.push(h('div', { class: 'label' }, 'Passes'), h('div', { class: 'grid2' }, passes.map(btn)));
    return out;
  }

  // 4th down / special options and coach's recommendation.
  if (!asTry) {
    if (s.down === 4 && st.settings.coachRec) {
      const rec = recommendFourthDown({ yardline: s.yardline, distance: s.distance, scoreDiff: s.scoreDiff, quarter: s.quarter, secondsLeftInGame: s.secondsLeftGame, secondsLeftInHalf: s.secondsLeftHalf, fgProb: s.fgProb, netPunt: 42, ot: s.ot });
      out.push(h('div', { class: 'rec' }, `Coach: ${rec.choice === 'go' ? 'Go for it' : rec.choice === 'fg' ? 'Kick the field goal' : 'Punt'}. ${rec.reason}`));
    }
    const fgDist = s.yardline + 17;
    const special: HTMLElement[] = [];
    if (s.down === 4) special.push(h('button', { onclick: () => act(() => game.snap({ type: 'punt' })) }, 'Punt'));
    if (fgDist <= 66 && (s.down === 4 || s.secondsLeftHalf <= 40)) {
      special.push(h('button', { onclick: () => act(() => game.snap({ type: 'fg' })) }, `Field goal`, h('small', {}, `${fgDist} yds · ${Math.round(fieldGoalProb(userTeam().unit, fgDist) * 100)}%`)));
    }
    if (s.clockRunning && s.down < 4) special.push(h('button', { onclick: () => act(() => game.snap({ type: 'spike' })) }, 'Spike', h('small', {}, 'Stops clock, costs a down')));
    if (s.scoreDiff > 0 && (s.quarter >= 4 || s.quarter === 2)) special.push(h('button', { onclick: () => act(() => game.snap({ type: 'kneel' })) }, 'Kneel', h('small', {}, 'Runs the clock')));
    out.push(h('div', { class: 'seg tempo' },
      (['normal', 'hurry', 'milk'] as Tempo[]).map((t) => h('button', { class: st.tempo === t ? 'on' : '', onclick: () => { st.tempo = t; render(); } }, t === 'normal' ? 'Huddle' : t === 'hurry' ? 'Hurry-up' : 'Milk clock')),
      userTeam().timeouts > 0 ? timeoutButton(true) : null));
    if (special.length) out.push(h('div', { class: 'grid-special' }, special));
  }

  const picks = quickPicksOffense(s, userTeam().team);
  out.push(h('div', { class: 'label' }, 'Quick picks'), h('div', { class: 'grid2 quick' }, picks.map((c) =>
    h('button', { class: 'call', onclick: () => callOffense(c) }, `${CONCEPTS[c.concept].name}`, h('small', {}, FORMATIONS[c.formation].name)))));
  out.push(h('div', { class: 'label' }, 'Formation'),
    h('div', { class: 'grid3' }, (Object.keys(FORMATIONS) as Formation[]).filter((f) => FORMATIONS[f].concepts.some((c) => conceptAllowed(c, s))).map((f) =>
      h('button', { class: 'call', onclick: () => { st.formation = f; render(); } }, FORMATIONS[f].name, tipLine(FORMATION_SHORT[f])))));
  return out;
}

function conceptAllowed(c: Concept, s: Situation) {
  if (c === 'hail_mary') return s.yardline >= 30 && s.secondsLeftHalf <= 30;
  if (c === 'qb_sneak') return s.distance <= 2;
  return true;
}

function timeoutButton(chip = false) {
  const game = g();
  return h('button', { class: chip ? 'chip' : '', onclick: () => {
    st.recent = [];
    const before = game.log.length;
    game.timeout(st.userSide);
    st.recent.push(...game.log.slice(before));
    render();
  } }, 'Timeout', h('small', {}, `${userTeam().timeouts} left`));
}

function defensePicker(title: string | null, offFormation: Formation, asTry: boolean): HTMLElement[] {
  const game = g();
  const s = situationForPicks(asTry);
  const f = FORMATIONS[offFormation];
  const out: HTMLElement[] = [];
  const choice = st.cpuChoice;
  const tempoNote = choice?.type === 'play' && choice.tempo === 'hurry' ? ' They are hurrying to the line.' : '';
  out.push(h('div', { class: 'prompt-row' },
    h('div', { class: 'prompt' }, title ?? `${cpuTeam().team.info.abbr} line up in ${f.name}: ${f.wr} WR, ${f.te} TE, ${f.rb + f.fb} RB.${tempoNote}`),
    !asTry && userTeam().timeouts > 0 ? timeoutButton(true) : null));

  if (st.front) {
    const fr = st.front;
    out.push(h('div', { class: 'row-head' }, h('button', { class: 'linklike', onclick: () => { st.front = undefined; render(); } }, '‹ Fronts'), h('b', {}, FRONTS[fr].name)));
    out.push(h('div', { class: 'label' }, 'Pressure (pick first, then tap a coverage)'),
      h('div', { class: 'seg wrap' }, (Object.keys(PRESSURES) as Pressure[]).map((p) =>
        h('button', { class: st.pressure === p ? 'on' : '', onclick: () => { st.pressure = p; render(); } }, PRESSURES[p].name))));
    if (st.settings.tips) out.push(h('div', { class: 'tip' }, describePressure(st.pressure)));
    out.push(h('div', { class: 'label' }, 'Coverage'),
      h('div', { class: 'grid2' }, (Object.keys(COVERAGES) as Coverage[]).map((c) => {
        const allowed = pressuresFor(c);
        const pr = allowed.includes(st.pressure) ? st.pressure : allowed[0];
        const m = coverageMatchups(c);
        const tip = `${COVERAGE_PLAIN[c].split(',')[0]}${m.stops.length ? ` · Stops ${m.stops.slice(0, 2).map((x) => CONCEPTS[x].name).join(', ')}` : ''}`;
        return h('button', { class: 'call', onclick: () => callDefense({ front: fr, coverage: c, pressure: pr }) },
          COVERAGES[c].name + (pr !== st.pressure ? ` + ${PRESSURES[pr].name}` : ''), tipLine(tip));
      })));
    return out;
  }

  const picks = quickPicksDefense(s, cpuTeam().team, offFormation);
  out.push(h('div', { class: 'label' }, 'Quick picks'), h('div', { class: 'grid2 quick' }, picks.map((dc) =>
    h('button', { class: 'call', onclick: () => callDefense(dc) }, COVERAGES[dc.coverage].name + (dc.pressure !== 'base' ? ` · ${PRESSURES[dc.pressure].name}` : ''), h('small', {}, FRONTS[dc.front].name)))));
  const xp = leagueXPass(s);
  out.push(h('div', { class: 'hint' }, `League teams pass about ${Math.round(xp * 100)}% of the time in this spot.`));
  out.push(h('div', { class: 'label' }, 'Front'),
    h('div', { class: 'grid2' }, (Object.keys(FRONTS) as Front[]).map((fr) =>
      h('button', { class: 'call', onclick: () => { st.front = fr; render(); } }, FRONTS[fr].name, tipLine(FRONT_PLAIN[fr].split('.').slice(1, 2).join('').trim() || FRONT_PLAIN[fr])))));
  void game;
  return out;
}

function finalPanel(): HTMLElement {
  const game = g();
  const box = boxScore(game);
  const row = (label: string, f: (s: Side) => string) => h('tr', {}, h('td', {}, f('away')), h('th', {}, label), h('td', {}, f('home')));
  const b = box.team;
  const won = game.s.winner === st.userSide;
  const players = box.players.filter((l) => l.passAtt || l.rushAtt >= 3 || l.rec >= 2).sort((a, b2) => (b2.passYds + b2.rushYds + b2.recYds) - (a.passYds + a.rushYds + a.recYds)).slice(0, 8);
  return h('section', { class: 'card final' },
    h('h2', {}, game.s.winner === 'tie' ? 'A tie.' : won ? 'You win!' : 'You lose.'),
    h('table', { class: 'box' },
      h('tr', {}, h('td', {}, game.sides.away.team.info.abbr), h('th', {}, ''), h('td', {}, game.sides.home.team.info.abbr)),
      row('Points', (s) => String(b[s].points)),
      row('Total yards', (s) => String(b[s].totalYards)),
      row('Passing', (s) => `${b[s].comp}/${b[s].att}, ${b[s].passYards}`),
      row('Rushing', (s) => `${b[s].rushAtt}-${b[s].rushYards}`),
      row('First downs', (s) => String(b[s].firstDowns)),
      row('3rd down', (s) => `${b[s].thirdConv}/${b[s].thirdAtt}`),
      row('Turnovers', (s) => String(b[s].ints + b[s].fumblesLost)),
      row('Sacks allowed', (s) => String(b[s].sacks)),
      row('Penalties', (s) => `${b[s].penalties}-${b[s].penaltyYards}`),
      row('Possession', (s) => fmtClock(b[s].timeOfPossession))),
    h('h3', {}, 'Top players'),
    h('ul', { class: 'players' }, players.map((l) => h('li', {}, `${game.sides[l.side].team.info.abbr} ${playerSummary(l)}`))),
    h('div', { class: 'grid2' },
      h('button', { class: 'primary', onclick: newGame }, 'Rematch'),
      h('button', { onclick: () => { st.screen = 'setup'; render(); } }, 'New matchup')));
}

// ---------- Learn ----------
function learnScreen(): HTMLElement {
  const sec = (title: string, ...items: (HTMLElement | string)[]) => h('details', { class: 'learn-sec' }, h('summary', {}, title), ...items.map((x) => (typeof x === 'string' ? h('p', {}, x) : x)));
  const list = (items: string[]) => h('ul', {}, items.map((t) => {
    const i = t.indexOf(':');
    return h('li', {}, h('b', {}, t.slice(0, i + 1)), t.slice(i + 1));
  }));
  const concepts = Object.keys(CONCEPTS) as Concept[];
  return h('div', { class: 'screen learn' },
    h('div', { class: 'row-head' }, h('button', { class: 'linklike', onclick: () => { st.screen = st.learnReturn; render(); } }, '‹ Back'), h('b', {}, 'Learn')),
    h('p', { class: 'muted' }, 'Tap a section to open it. You can read these any time during a game.'),
    sec('The basics',
      list([
        'Downs: The offense gets 4 tries ("downs") to gain 10 yards. Gain them and you get a fresh set: "1st & 10".',
        '"2nd & 6": It is the 2nd try and 6 yards are still needed.',
        'Scoring: Touchdown = 6 points, then a kick for 1 more (about 95%) or a play from the 2-yard line for 2 (about 48%). Field goal = 3. Safety (tackled in your own end zone) = 2 for the defense.',
        '4th down: Usually you punt (kick it away so they start far back) or try a field goal if you are close. "Going for it" risks giving them the ball right there.',
        'Field position: The field is 100 yards. "KC 25" means 25 yards from the Chiefs\' own goal line. The red zone is inside the opponent\'s 20.',
        'Clock: The clock stops on incomplete passes, scores, turnovers, and timeouts, and (late in halves) when a player runs out of bounds. Each team has 3 timeouts per half.',
        'Tempo: Huddle uses about 35 seconds between plays. Hurry-up uses about 13. Milk clock uses all 40 seconds of the play clock: great when protecting a lead.',
        'Spike and kneel: Spike = throw the ball into the ground to stop the clock (costs a down). Kneel = take a knee to run out the clock when winning.',
      ])),
    sec('How each play is decided',
      'Every snap, your call is matched against the other coordinator\'s call. Some calls beat others (a screen against a blitz, a run against a defense with few players near the line). That matchup matters most.',
      'Then player ratings matter: a great quarterback completes more passes, a great pass rush gets more sacks.',
      'Finally there\'s some luck, so a good call can still fail and a bad call can still work. Over a game, good calls add up.',
      'Watch out: the other coordinator scouts you. Call the same thing over and over and they will adjust to stop it.'),
    sec('Offensive formations', list((Object.keys(FORMATIONS) as Formation[]).map(describeFormation))),
    sec('Run plays', list(concepts.filter((c) => CONCEPTS[c].kind === 'run').map(describeConcept))),
    sec('Pass plays', list(concepts.filter((c) => CONCEPTS[c].kind === 'pass').map(describeConcept))),
    sec('Defensive fronts (who is on the field)', list((Object.keys(FRONTS) as Front[]).map(describeFront))),
    sec('Coverages (how the defense guards passes)', list((Object.keys(COVERAGES) as Coverage[]).map(describeCoverage))),
    sec('Pressure (blitzing)', list((Object.keys(PRESSURES) as Pressure[]).map(describePressure))),
    sec('Cheat sheet: what beats what',
      list([
        'Blitz coming: Screens and quick passes (Slant-Flat, Mesh, WR Screen). Avoid slow deep shots.',
        'Defense playing soft deep zones (Cover 3, Cover 4): Short passes underneath and runs.',
        'Man coverage (Cover 0, Cover 1): Crossing routes (Mesh, Y-Cross, Slant-Flat) and QB scrambles.',
        'Few defenders near the line (Nickel/Dime, two deep safeties): Run the ball.',
        'Defense stacked near the line (Goal Line, Cover 1/Cover 3): Pass, especially play-action.',
        'On defense, 3rd & long: Play Cover 4 or Cover 2 to keep everything in front, or blitz to force a quick throw.',
        'On defense, short yardage: Goal Line or base front with Cover 1/Cover 0 to load the line.',
        'Big formation (Heavy, Goal Line): Match it with your base or Goal Line front, or they will run right at you.',
      ])),
  );
}
