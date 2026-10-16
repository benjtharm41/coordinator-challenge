// Interface: set up a game, call every play on an animated field, read the results.
import { chooseTry, chooseTwoPointPlay, leagueXPass, quickPicksDefense, quickPicksOffense, type Situation } from '../engine/ai';
import { recommendFourthDown, recommendTry } from '../engine/analytics';
import { Game, type PlayLog } from '../engine/game';
import { type Outcome, type Scenario } from '../engine/scenario';
import { addGame, addScenario, callRecords, gameRecord, loadSave, scenarioRecord, writeSave, type CallRec, type Save } from '../store/store';
import { defCallName } from '../engine/narrate';
import { describeFreshness, loadManifest, loadTeam, placeholderPreviews, type Manifest, type TeamPreview } from '../data/load';
import { CONCEPTS, COVERAGES, FORMATIONS, FRONTS, PRESSURES, pressuresFor } from '../engine/playbook';
import { fieldGoalProb } from '../engine/special';
import { boxScore, playerSummary } from '../engine/stats';
import {
  conceptMatchups, COVERAGE_PLAIN, coverageMatchups, describeConcept, describeCoverage, describeFormation, describeFront, describePressure,
  explainPlay, FORMATION_SHORT, FRONT_PLAIN,
} from '../engine/teach';
import { other, type Concept, type Coverage, type DefCall, type Formation, type Front, type OffCall, type OffChoice, type Pressure, type Side, type Tempo } from '../engine/types';
import { defenseDiagram, formationDiagram, offenseDiagram } from '../field/diagram';
import { DEFAULT_DEF, shotFor, type Shot } from '../field/director';
import { buildScene, type Scene } from '../field/scene';
import { FieldView, type OverlayChoice } from '../field/view';
import { h } from './dom';
import { homeScreen, installScreen, situationsScreen, statsScreen, type ScreenCtx } from './screens';

type Screen = 'home' | 'setup' | 'situations' | 'stats' | 'install' | 'game' | 'learn';
type OverlayMode = 'off' | 'mine' | 'both';

interface Settings {
  coachRec: boolean;
  tips: boolean;
  autoWhy: boolean;
  /** Tap a call once to see it on the field, tap again (or press Run) to call it. */
  preview: boolean;
  overlay: OverlayMode;
  /** 1 or 2 = animation speed, 0 = skip animations. */
  speed: 0 | 1 | 2;
}

interface Shown {
  quarter: number;
  clock: number;
  score: Record<Side, number>;
  timeouts: Record<Side, number>;
  possession: Side;
  down: string;
  running: boolean;
  final: boolean;
  ot: boolean;
}

interface UIState {
  screen: Screen;
  learnReturn: Screen;
  game?: Game;
  userSide: Side;
  tempo: Tempo;
  formation?: Formation;
  front?: Front;
  pressure: Pressure;
  pickOff?: OffCall;
  pickDef?: DefCall;
  cpuChoice?: OffChoice;
  cpuTry?: OffCall;
  tryMode: boolean;
  unplayed: PlayLog[];
  played: PlayLog[];
  watching?: string;
  shown: Shown | null;
  animating: boolean;
  logOpen: boolean;
  save: Save;
  scenario?: Scenario;
  pendingScenario?: Scenario;
  scenarioResult?: Outcome;
  calls: CallRec[];
  recorded: boolean;
  mode: 'full' | 'short';
  message: { text: string; bad?: boolean } | null;
  settings: Settings;
  setup: { team: string; opp: string; home: boolean; short: boolean };
}

const SUFFIXES = new Set(['jr.', 'jr', 'sr.', 'sr', 'ii', 'iii', 'iv', 'v']);
const lastName = (full: string) => {
  const parts = full.split(' ');
  while (parts.length > 1 && SUFFIXES.has(parts[parts.length - 1].toLowerCase())) parts.pop();
  return parts[parts.length - 1];
};
let roster: TeamPreview[] = placeholderPreviews();
let manifest: Manifest | null = null;
let dataState: 'loading' | 'real' | 'placeholder' = 'loading';
const previewOf = (a: string): TeamPreview => roster.find((t) => t.abbr === a) ?? roster[0];

const SETTINGS_KEY = 'cc.settings.v2';
const DEFAULTS: Settings = { coachRec: true, tips: true, autoWhy: true, preview: true, overlay: 'both', speed: 1 };
function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...DEFAULTS, ...JSON.parse(raw) };
  } catch {
    /* storage may be unavailable */
  }
  return { ...DEFAULTS };
}
function saveSettings(s: Settings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

const st: UIState = {
  screen: 'home', learnReturn: 'home', userSide: 'home', tempo: 'normal', pressure: 'base', tryMode: false, unplayed: [], played: [],
  shown: null, animating: false, logOpen: false, settings: loadSettings(), save: loadSave(), calls: [], recorded: false, mode: 'full', message: null,
  setup: { team: 'KC', opp: 'BUF', home: true, short: false },
};

let root: HTMLElement;
let field: FieldView | undefined;
let fieldHost: HTMLElement | undefined;
let lastOffense: Side | undefined;

export function startApp(el: HTMLElement) {
  root = el;
  render();
  void loadManifest().then((m) => {
    manifest = m;
    if (m) roster = m.teams;
    dataState = m ? 'real' : 'placeholder';
    if (!roster.some((t) => t.abbr === st.setup.team)) st.setup.team = roster[0].abbr;
    if (st.screen === 'setup' || st.screen === 'home' || st.screen === 'situations') render();
  });
  if (import.meta.env.DEV) (window as unknown as { __cc: unknown }).__cc = { st, get field() { return field; } };
}

function render() {
  document.body.classList.toggle('in-game', st.screen === 'game');
  const view =
    st.screen === 'home' ? homeScreen(screenCtx())
    : st.screen === 'setup' ? setupScreen()
    : st.screen === 'situations' ? situationsScreen(screenCtx())
    : st.screen === 'stats' ? statsScreen(screenCtx())
    : st.screen === 'install' ? installScreen(screenCtx())
    : st.screen === 'learn' ? learnScreen()
    : gameScreen();
  root.replaceChildren(view);
  window.scrollTo(0, 0);
  if (st.screen === 'game') syncField();
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

function snapshot(game: Game): Shown {
  return {
    quarter: game.s.quarter, clock: game.s.clock, score: { home: game.sides.home.score, away: game.sides.away.score },
    timeouts: { home: game.sides.home.timeouts, away: game.sides.away.timeouts }, possession: game.s.possession, down: downText(game),
    running: game.s.clockRunning && game.s.phase === 'scrimmage', final: game.s.phase === 'final', ot: game.s.ot.on,
  };
}

// ---------- game flow ----------
function ensureField() {
  if (!fieldHost) {
    fieldHost = h('div', { class: 'field-host', onclick: () => { if (field?.isPlaying()) field.skip(); } });
    field = new FieldView(fieldHost);
  }
}

let starting = false;
async function newGame(scenario?: Scenario) {
  if (starting) return;
  starting = true;
  ensureField();
  const [mine, opp] = await Promise.all([loadTeam(st.setup.team), loadTeam(st.setup.opp)]);
  starting = false;
  // Situations always put you on the home side.
  const home_ = scenario ? true : st.setup.home;
  st.userSide = home_ ? 'home' : 'away';
  const home = home_ ? mine : opp;
  const away = home_ ? opp : mine;
  st.game = new Game(home, away, { home: home_ ? 'human' : 'cpu', away: home_ ? 'cpu' : 'human' }, { short: !scenario && st.setup.short });
  st.scenario = scenario;
  st.scenarioResult = undefined;
  st.calls = [];
  st.recorded = false;
  st.mode = !scenario && st.setup.short ? 'short' : 'full';
  if (scenario) st.game.applySetup(scenario.setup);
  st.unplayed = [];
  st.played = [];
  st.shown = null;
  st.animating = false;
  st.logOpen = false;
  st.tempo = 'normal';
  lastOffense = undefined;
  field?.stop();
  resetSelection();
  st.screen = 'game';
  advance();
}

function resetSelection() {
  st.formation = undefined;
  st.front = undefined;
  st.pickOff = undefined;
  st.pickDef = undefined;
  st.cpuChoice = undefined;
  st.cpuTry = undefined;
  st.tryMode = false;
}

/** Run any steps that don't need the human, stopping at the next human decision. */
function judgeScenario(): boolean {
  const sc = st.scenario;
  if (!sc) return false;
  if (st.scenarioResult) return true;
  const out = sc.judge(g(), g().log);
  if (!out) return false;
  st.scenarioResult = out;
  st.save = addScenario(st.save, scenarioRecord(sc, out, g().sides[st.userSide].team.info.abbr, cpuTeam().team.info.abbr));
  if (!writeSave(st.save)) st.message = { text: 'Could not save this result (browser storage is full or blocked).', bad: true };
  return true;
}

function advance() {
  const game = g();
  for (let i = 0; i < 50; i++) {
    if (judgeScenario()) break;
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
    st.unplayed.push(...game.log.slice(before));
  }
  judgeScenario();
  startPlayback();
}

function act(fn: () => void) {
  const game = g();
  const before = game.log.length;
  st.shown = snapshot(game);
  st.played = [];
  fn();
  const made = game.log.slice(before);
  st.calls.push(...callRecords(made, st.userSide));
  st.unplayed.push(...made);
  resetSelection();
  advance();
}

// ---------- playback ----------
function startPlayback() {
  if (st.animating) return;
  if (!st.shown && st.unplayed.length) st.shown = snapshot(g());
  playNext();
}

function describeShot(e: PlayLog): string {
  switch (e.kind) {
    case 'kickoff': return 'Kickoff';
    case 'punt': return 'Punt';
    case 'fg': return `Field goal try, ${e.yardline + 17} yards`;
    case 'xp': return 'Extra point';
    case '2pt': return 'Two-point try';
    case 'kneel': return 'Kneel down';
    case 'spike': return 'Spike';
    case 'penalty': return 'Penalty flag';
    default:
      return e.offCall && e.defCall ? `${FORMATIONS[e.offCall.formation].name} · ${CONCEPTS[e.offCall.concept].name}  vs  ${defCallName(e.defCall)}` : 'Play';
  }
}

function overlayFor(side: 'off' | 'def' | null): OverlayChoice {
  const m = st.settings.overlay;
  return { mine: m === 'off' ? null : side, reveal: m === 'both', labels: false };
}

function playNext() {
  const game = g();
  const e = st.unplayed.shift();
  if (!e) {
    st.animating = false;
    st.shown = null;
    st.watching = undefined;
    if (game.s.phase === 'final' && !st.scenario && !st.recorded) {
      st.recorded = true;
      st.save = addGame(st.save, gameRecord(game, st.userSide, st.mode, st.calls));
      if (!writeSave(st.save)) st.message = { text: 'Could not save this game (browser storage is full or blocked). Save a backup from My stats.', bad: true };
    }
    render();
    return;
  }
  const shot: Shot | null = shotFor(game, e);
  if (!shot) {
    settle(e);
    playNext();
    return;
  }
  ensureField();
  st.animating = true;
  st.watching = describeShot(e);
  const offTeam = game.sides[e.offense].team;
  const defTeam = game.sides[other(e.offense)].team;
  field!.setTeams(offTeam, defTeam);
  lastOffense = e.offense;
  render();
  const side: 'off' | 'def' = e.offense === st.userSide ? 'off' : 'def';
  field!.play(shot, overlayFor(shot.scene ? side : null), Math.max(1, st.settings.speed), () => {
    settle(e);
    playNext();
  });
  if (st.settings.speed === 0) field!.skip();
}

function settle(e: PlayLog) {
  if (st.shown) st.shown = { ...st.shown, score: e.score };
  st.played.push(e);
  if (st.animating) render();
}

function setSpeed(s: 0 | 1 | 2) {
  st.settings.speed = s;
  saveSettings(st.settings);
  field?.setSpeed(Math.max(1, s));
  if (s === 0) field?.skip();
  render();
}

// ---------- calling plays ----------
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

const sameOff = (a?: OffCall, b?: OffCall) => !!a && !!b && a.formation === b.formation && a.concept === b.concept;
const sameDef = (a?: DefCall, b?: DefCall) => !!a && !!b && a.front === b.front && a.coverage === b.coverage && a.pressure === b.pressure;

function selectOff(call: OffCall) {
  if (!st.settings.preview || sameOff(st.pickOff, call)) callOffense(call);
  else {
    st.pickOff = call;
    st.formation = call.formation;
    render();
  }
}
function selectDef(dc: DefCall) {
  if (!st.settings.preview || sameDef(st.pickDef, dc)) callDefense(dc);
  else {
    st.pickDef = dc;
    st.front = dc.front;
    render();
  }
}

// ---------- the field ----------
const HIDE_ROUTES = (s: Scene): Scene => ({ ...s, routes: [], run: undefined, blockers: [] });

const defaultFormation = (yardline: number): Formation => (yardline <= 3 ? 'goalline' : 'shotgun');
const defaultConcept = (f: Formation): Concept => (f === 'goalline' || f === 'heavy' || f === 'iform' ? 'inside_zone' : 'slant_flat');

function syncField() {
  if (!field || !fieldHost || st.animating || !st.game || st.scenarioResult) return;
  const game = g();
  const d = game.pending();
  if (d.kind === 'final') return;
  const offSide: Side = d.kind === 'kickoff' ? d.kicking : d.kind === 'try' ? d.team : d.offense;
  const defSide = other(offSide);
  const offTeam = game.sides[offSide].team;
  const defTeam = game.sides[defSide].team;
  field.setTeams(offTeam, defTeam);
  const flipped = lastOffense !== offSide;
  lastOffense = offSide;
  field.setSpeed(Math.max(1, st.settings.speed));

  if (d.kind === 'kickoff') {
    field.showEmpty(35);
    return;
  }
  const isTry = d.kind === 'try';
  const yardline = isTry ? 2 : game.s.yardline;
  const losAbs = 100 - yardline;
  const firstDownAbs = isTry ? undefined : Math.min(100, losAbs + game.s.distance);
  const userOff = offSide === st.userSide;

  let offCall: OffCall;
  let defCall: DefCall;
  let hideOff = false;
  let ghost: 'off' | 'def' | undefined;
  let side: 'off' | 'def' | null = null;
  let labels = false;
  if (userOff) {
    const f = st.formation ?? defaultFormation(yardline);
    offCall = st.pickOff ?? { formation: f, concept: defaultConcept(f) };
    defCall = DEFAULT_DEF;
    hideOff = !st.pickOff;
    ghost = 'def';
    side = st.pickOff ? 'off' : null;
  } else {
    const formation = st.cpuTry?.formation ?? (st.cpuChoice && st.cpuChoice.type === 'play' ? st.cpuChoice.call.formation : 'shotgun');
    offCall = { formation, concept: defaultConcept(formation) };
    hideOff = true;
    const front = st.front ?? DEFAULT_DEF.front;
    defCall = st.pickDef ?? { front, coverage: DEFAULT_DEF.coverage, pressure: pressuresFor(DEFAULT_DEF.coverage).includes(st.pressure) ? st.pressure : 'base' };
    side = st.pickDef ? 'def' : null;
    labels = !!st.pickDef;
  }
  let scene = buildScene(offTeam, defTeam, offCall, defCall);
  if (hideOff) scene = HIDE_ROUTES(scene);
  const ov = overlayFor(side);
  ov.reveal = false;
  ov.labels = labels;
  field.showScene({ scene, losAbs, firstDownAbs }, ov, flipped, ghost);
}

// ---------- screens ----------
const dataNote = () =>
  dataState === 'loading' ? 'Loading team data…'
  : manifest ? describeFreshness(manifest)
  : 'Could not load the latest data, so games use made-up players. Connect to the internet once and reload.';

/** Team pickers with a preview of each team (used for full games and Situations). */
function teamPickers(withSides: boolean): HTMLElement {
  const opt = (t: TeamPreview, sel: string) => h('option', { value: t.abbr, selected: t.abbr === sel }, `${t.name}`);
  const teamSelect = (key: 'team' | 'opp') =>
    h('select', { onchange: (e: Event) => { st.setup[key] = (e.target as HTMLSelectElement).value; render(); } }, roster.map((t) => opt(t, st.setup[key])));
  const mine = previewOf(st.setup.team);
  const opp = previewOf(st.setup.opp);
  const teamCard = (t: TeamPreview, who: string) => {
    const g = t.grades;
    return [
      h('div', { class: 'coach' }, `${who}: ${t.headCoach}`),
      t.headline.length
        ? h('div', { class: 'preview' },
            h('div', {}, t.headline.slice(0, 5).map((p) => h('span', { class: `pl ${p.injury ? 'hurt' : ''}` }, `${p.label} ${lastName(p.name)} ${p.ovr}${p.injury ? ' (' + p.injury + ')' : ''}`))),
            h('div', { class: 'grades' }, `QB ${g.qb} · O-line ${g.ol} · Receivers ${g.pass} · Pass rush ${g.rush} · Coverage ${g.cover}`),
            t.injuries.length ? h('div', { class: 'inj' }, 'Injury report: ' + t.injuries.slice(0, 5).map((i) => `${i.name} (${i.status})`).join(', ')) : null)
        : null,
    ];
  };
  return h('div', { class: 'card' },
    h('label', { class: 'field' }, h('span', {}, 'Your team'), teamSelect('team')),
    teamCard(mine, 'Your head coach'),
    h('label', { class: 'field' }, h('span', {}, 'Opponent'), teamSelect('opp')),
    teamCard(opp, 'Their play-caller'),
    st.setup.team === st.setup.opp ? h('div', { class: 'warn' }, 'Pick two different teams.') : null,
    withSides ? [
      h('div', { class: 'seg' },
        h('button', { class: st.setup.home ? 'on' : '', onclick: () => { st.setup.home = true; render(); } }, 'Home'),
        h('button', { class: !st.setup.home ? 'on' : '', onclick: () => { st.setup.home = false; render(); } }, 'Away')),
      h('div', { class: 'seg' },
        h('button', { class: !st.setup.short ? 'on' : '', onclick: () => { st.setup.short = false; render(); } }, 'Full game (~30 min)'),
        h('button', { class: st.setup.short ? 'on' : '', onclick: () => { st.setup.short = true; render(); } }, 'Short quarters (~15 min)')),
    ] : null);
}

function screenCtx(): ScreenCtx {
  return {
    go: (screen) => {
      if (screen === 'learn') st.learnReturn = st.screen;
      st.message = null;
      st.pendingScenario = undefined;
      st.screen = screen;
      render();
    },
    save: () => st.save,
    setSave: (v) => {
      st.save = v;
      if (!writeSave(v)) st.message = { text: 'Could not save to this browser (storage is full or blocked).', bad: true };
    },
    dataNote,
    startScenario: (sc) => {
      if (st.setup.team === st.setup.opp || dataState === 'loading') return;
      void newGame(sc);
    },
    teamPickers: () => teamPickers(false),
    rerender: render,
    get message() { return st.message; },
    setMessage: (m) => { st.message = m; },
    get pendingScenario() { return st.pendingScenario; },
    pickScenario: (sc) => { st.pendingScenario = sc; render(); },
  } as ScreenCtx;
}

function setupScreen(): HTMLElement {
  const toggle = (label: string, key: 'coachRec' | 'tips' | 'autoWhy' | 'preview', help: string) =>
    h('label', { class: 'toggle' },
      h('input', { type: 'checkbox', checked: st.settings[key], onchange: (e: Event) => { st.settings[key] = (e.target as HTMLInputElement).checked; saveSettings(st.settings); } }),
      h('span', {}, h('b', {}, label), h('small', {}, help)));
  const seg = <T extends string | number>(label: string, value: T, options: [T, string][], set: (v: T) => void, help: string) =>
    h('div', { class: 'seg-setting' }, h('b', {}, label), h('small', {}, help),
      h('div', { class: 'seg' }, options.map(([v, text]) => h('button', { class: v === value ? 'on' : '', onclick: () => { set(v); saveSettings(st.settings); render(); } }, text))));
  return h('div', { class: 'screen setup' },
    h('div', { class: 'row-head' }, h('button', { class: 'linklike', onclick: () => { st.screen = 'home'; render(); } }, '‹ Menu'), h('b', {}, 'Full game')),
    h('p', { class: `data-note ${dataState}` }, dataNote()),
    teamPickers(true),
    h('div', { class: 'card' },
      toggle("Coach's recommendation", 'coachRec', 'Suggests what to do on 4th downs and after touchdowns, with a reason.'),
      toggle('Play tips on buttons', 'tips', 'Shows what each call does and what it beats.'),
      toggle('Explain every play', 'autoWhy', 'Opens the "why it worked / failed" note automatically.'),
      toggle('Preview before calling', 'preview', 'Tap a call once to see it drawn on the field, tap again to run it.'),
      seg<OverlayMode>('Routes and zones on the field', st.settings.overlay, [['off', 'Off'], ['mine', 'My call'], ['both', 'Both after snap']], (v) => { st.settings.overlay = v; },
        'Draws your routes (offense) or zones (defense). "Both" reveals the opponent\'s call once the play starts.'),
      seg<0 | 1 | 2>('Animation speed', st.settings.speed, [[1, '1x'], [2, '2x'], [0, 'Skip']], (v) => { st.settings.speed = v; }, 'You can change this during a game.')),
    h('button', { class: 'primary big', disabled: st.setup.team === st.setup.opp || dataState === 'loading', onclick: () => void newGame() }, dataState === 'loading' ? 'Loading…' : 'Kick off'),
  );
}

function scoreboard(): HTMLElement {
  const game = g();
  const s = st.shown ?? snapshot(game);
  const side = (sd: Side) => {
    const t = game.sides[sd];
    const hasBall = s.possession === sd && !s.final;
    return h('div', { class: `sb-team ${sd}`, style: { borderColor: t.team.info.color } },
      h('div', { class: 'sb-abbr' }, t.team.info.abbr, hasBall ? h('span', { class: 'ball' }, ' 🏈') : null, sd === st.userSide ? h('span', { class: 'you' }, 'YOU') : null),
      h('div', { class: 'sb-score' }, String(s.score[sd])),
      h('div', { class: 'sb-to' }, Array.from({ length: s.ot ? 2 : 3 }, (_, i) => h('i', { class: i < s.timeouts[sd] ? 'full' : '' }))));
  };
  return h('header', { class: 'scoreboard' },
    h('div', { class: 'sb-row' },
      side('away'),
      h('div', { class: 'sb-mid' },
        h('div', { class: 'sb-clock' }, s.final ? 'FINAL' : `${qName(s.quarter)} ${fmtClock(s.clock)}`),
        h('div', { class: 'sb-run' }, s.running ? '⏱ clock running' : '')),
      side('home')),
    h('div', { class: 'sb-down' }, s.down));
}

function entryClass(e: PlayLog) {
  if (e.points) return 'score';
  if (e.turnover) return 'turnover';
  if (e.kind === 'info' || e.kind === 'timeout') return 'info';
  return '';
}

const NOTABLE = /warning|quarter|Halftime|Overtime|toss|Turnover|Final|receive/;

function fieldBar(): HTMLElement {
  const sp = (v: 0 | 1 | 2, label: string) => h('button', { class: `chip ${st.settings.speed === v ? 'on' : ''}`, onclick: (e: Event) => { e.stopPropagation(); setSpeed(v); } }, label);
  const mode = st.settings.overlay;
  return h('div', { class: 'field-bar' },
    h('div', { class: 'speed' }, sp(1, '1x'), sp(2, '2x'), sp(0, 'Skip')),
    h('button', {
      class: `chip lines ${mode === 'off' ? '' : 'on'}`,
      onclick: (e: Event) => {
        e.stopPropagation();
        st.settings.overlay = mode === 'off' ? 'both' : 'off';
        saveSettings(st.settings);
        render();
      },
    }, mode === 'off' ? 'Routes: off' : 'Routes: on'));
}

function stripCard(): HTMLElement | null {
  if (st.animating) {
    return h('section', { class: 'strip watching' }, h('div', { class: 'meta' }, 'Watching'), h('div', { class: 'txt' }, st.watching ?? ''));
  }
  const items = st.played.filter((e) => e.kind !== 'info' || NOTABLE.test(e.text));
  if (!items.length) return null;
  const game = g();
  const rows = items.slice(-3).map((e, i, arr) => {
    const off = game.sides[e.offense].team.info.abbr;
    const meta = e.down > 0 && e.kind !== 'info' && e.kind !== 'timeout' ? `${off} · ${ord(e.down)} & ${e.distance} · ${qName(e.quarter)} ${fmtClock(e.clock)}` : '';
    const last = i === arr.length - 1;
    const why = last && e.outcome && e.offCall && e.defCall && e.kind !== 'penalty'
      ? h('details', { class: 'why', open: st.settings.autoWhy },
          h('summary', {}, e.offense === st.userSide ? 'Why it worked / failed' : 'What happened on defense'),
          h('p', {}, explainPlay(e.outcome, e.offCall, e.defCall, e.offense === st.userSide, e.down || 4, e.distance || 2)))
      : null;
    return h('div', { class: `play ${entryClass(e)}` }, meta ? h('div', { class: 'meta' }, meta) : null, h('div', { class: 'txt' }, e.text), why);
  });
  return h('section', { class: 'strip' }, rows);
}

function logModal(): HTMLElement | null {
  if (!st.logOpen) return null;
  const game = g();
  return h('div', { class: 'modal', onclick: () => { st.logOpen = false; render(); } },
    h('div', { class: 'modal-card', onclick: (e: Event) => e.stopPropagation() },
      h('div', { class: 'row-head' }, h('b', {}, 'Play-by-play'), h('button', { class: 'linklike', onclick: () => { st.logOpen = false; render(); } }, 'Close')),
      h('ol', { class: 'log-list' }, [...game.log].reverse().slice(0, 300).map((e) =>
        h('li', { class: entryClass(e) },
          h('span', { class: 'meta' }, `${qName(e.quarter)} ${fmtClock(e.clock)} ${e.down ? `${game.sides[e.offense].team.info.abbr} ${ord(e.down)}&${e.distance}` : ''}`),
          ' ', e.text)))));
}

function gameScreen(): HTMLElement {
  ensureField();
  const game = g();
  const isFinal = game.s.phase === 'final' && !st.animating;
  return h('div', { class: 'screen game' },
    scoreboard(),
    h('div', { class: 'opp-line' },
      h('span', {}, `vs ${cpuTeam().team.info.name} · play-caller ${cpuTeam().team.info.headCoach}`),
      h('span', { class: 'links' },
        h('button', { class: 'linklike', onclick: leaveGame }, 'Menu'),
        h('button', { class: 'linklike', onclick: () => { st.logOpen = true; render(); } }, 'Log'),
        h('button', { class: 'linklike', onclick: () => { st.learnReturn = 'game'; st.screen = 'learn'; render(); } }, 'Learn'))),
    st.scenario ? h('div', { class: 'goal' }, h('b', {}, st.scenario.title + ': '), st.scenario.win) : null,
    h('div', { class: 'field-wrap' }, fieldHost!, fieldBar()),
    stripCard(),
    st.scenarioResult && !st.animating ? scenarioResultPanel() : isFinal ? finalPanel() : h('div', { class: 'sheet' }, st.animating ? watchingSheet() : controls()),
    logModal());
}

function leaveGame() {
  const live = st.game && st.game.s.phase !== 'final' && !st.scenarioResult;
  if (live && !confirm('Leave this game? It will not be saved.')) return;
  field?.stop();
  st.animating = false;
  st.unplayed = [];
  st.shown = null;
  st.screen = st.scenario ? 'situations' : 'home';
  st.pendingScenario = undefined;
  render();
}

function scenarioResultPanel(): HTMLElement {
  const sc = st.scenario!;
  const r = st.scenarioResult!;
  return h('section', { class: 'sheet final' },
    h('h2', { class: r.result }, r.result === 'win' ? 'You did it!' : r.result === 'tie' ? 'So close.' : 'Not this time.'),
    h('p', {}, r.message),
    h('p', { class: 'muted' }, r.result === 'win' ? sc.win : sc.lose),
    h('div', { class: 'grid2' },
      h('button', { class: 'primary', onclick: () => void newGame(sc) }, 'Try again'),
      h('button', { onclick: () => { st.screen = 'situations'; st.pendingScenario = undefined; render(); } }, 'More situations')));
}

function watchingSheet(): HTMLElement[] {
  return [h('div', { class: 'prompt' }, 'Watching the play…'),
    h('div', { class: 'grid2' }, h('button', { onclick: () => field?.skip() }, 'Skip this play'), h('button', { onclick: () => setSpeed(0) }, 'Skip all animations'))];
}

// ---------- the bottom sheet ----------
function controls(): (HTMLElement | null)[] {
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
  return body;
}

function tipLine(text: string) {
  return st.settings.tips ? h('small', {}, text) : null;
}

function situationForPicks(asTry: boolean): Situation {
  const s = g().situation();
  return asTry ? { ...s, down: 4, distance: 2, yardline: 2 } : s;
}

function pickBar(name: string, detail: string, run: () => void, clear: () => void): HTMLElement {
  return h('div', { class: 'pick-bar' },
    h('div', { class: 'pick-name' }, h('b', {}, name), h('small', {}, detail)),
    h('button', { class: 'chip', onclick: clear }, 'Cancel'),
    h('button', { class: 'primary run', onclick: run }, 'Run it'));
}

function artButton(img: string, title: string, lines: (HTMLElement | null)[], onclick: () => void, selected = false, quick = false) {
  return h('button', { class: `call art ${selected ? 'selected' : ''} ${quick ? 'quick-btn' : ''}`, onclick },
    h('img', { src: img, alt: '', draggable: 'false' }), h('span', { class: 'call-title' }, title), lines);
}

function offensePicker(title: string | null, asTry: boolean): (HTMLElement | null)[] {
  const game = g();
  const s = situationForPicks(asTry);
  const out: (HTMLElement | null)[] = [];
  if (title) out.push(h('div', { class: 'prompt' }, title));

  if (st.pickOff) {
    const c = st.pickOff;
    out.push(pickBar(CONCEPTS[c.concept].name, `${FORMATIONS[c.formation].name}. ${CONCEPTS[c.concept].blurb}`, () => callOffense(c), () => { st.pickOff = undefined; render(); }));
  }

  if (st.formation) {
    const f = st.formation;
    const avail = FORMATIONS[f].concepts.filter((c) => conceptAllowed(c, s));
    const btn = (c: Concept) => {
      const m = conceptMatchups(c);
      const tip = [m.strong.length ? `Beats ${m.strong.map((x) => COVERAGES[x].name).join(', ')}` : '', m.weak.length ? `Weak vs ${m.weak.map((x) => COVERAGES[x].name).join(', ')}` : ''].filter(Boolean).join(' · ');
      const call = { formation: f, concept: c };
      return artButton(offenseDiagram(call), CONCEPTS[c].name, [tipLine(CONCEPTS[c].blurb), tipLine(tip)], () => selectOff(call), sameOff(st.pickOff, call));
    };
    out.push(h('div', { class: 'row-head' }, h('button', { class: 'linklike', onclick: () => { st.formation = undefined; st.pickOff = undefined; render(); } }, '‹ Formations'), h('b', {}, FORMATIONS[f].name)));
    const runs = avail.filter((c) => CONCEPTS[c].kind === 'run');
    const passes = avail.filter((c) => CONCEPTS[c].kind === 'pass');
    if (runs.length) out.push(h('div', { class: 'label' }, 'Runs'), h('div', { class: 'grid2' }, runs.map(btn)));
    if (passes.length) out.push(h('div', { class: 'label' }, 'Passes'), h('div', { class: 'grid2' }, passes.map(btn)));
    return out;
  }

  // 4th down / special options and coach's recommendation.
  const playsOnly = !!st.scenario?.playsOnly;
  if (!asTry && !playsOnly) {
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
    artButton(offenseDiagram(c), CONCEPTS[c.concept].name, [h('small', {}, FORMATIONS[c.formation].name)], () => selectOff(c), sameOff(st.pickOff, c), true))));
  out.push(h('div', { class: 'label' }, 'Formation'),
    h('div', { class: 'grid3' }, (Object.keys(FORMATIONS) as Formation[]).filter((f) => FORMATIONS[f].concepts.some((c) => conceptAllowed(c, s))).map((f) =>
      h('button', { class: 'call art', onclick: () => { st.formation = f; st.pickOff = undefined; render(); } },
        h('img', { src: formationDiagram(f), alt: '', draggable: 'false' }), h('span', { class: 'call-title' }, FORMATIONS[f].name), tipLine(FORMATION_SHORT[f])))));
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
    const before = game.log.length;
    game.timeout(st.userSide);
    st.played = game.log.slice(before);
    render();
  } }, 'Timeout', h('small', {}, `${userTeam().timeouts} left`));
}

function defensePicker(title: string | null, offFormation: Formation, asTry: boolean): (HTMLElement | null)[] {
  const s = situationForPicks(asTry);
  const f = FORMATIONS[offFormation];
  const out: (HTMLElement | null)[] = [];
  const choice = st.cpuChoice;
  const tempoNote = choice?.type === 'play' && choice.tempo === 'hurry' ? ' They are hurrying to the line.' : '';
  out.push(h('div', { class: 'prompt-row' },
    h('div', { class: 'prompt' }, title ?? `${cpuTeam().team.info.abbr} line up in ${f.name}: ${f.wr} WR, ${f.te} TE, ${f.rb + f.fb} RB.${tempoNote}`),
    !asTry && userTeam().timeouts > 0 ? timeoutButton(true) : null));

  if (st.pickDef) {
    const dc = st.pickDef;
    out.push(pickBar(`${COVERAGES[dc.coverage].name}${dc.pressure === 'base' ? '' : ' + ' + PRESSURES[dc.pressure].name}`, `${FRONTS[dc.front].name}. ${COVERAGES[dc.coverage].blurb}`, () => callDefense(dc), () => { st.pickDef = undefined; render(); }));
  }

  if (st.front) {
    const fr = st.front;
    out.push(h('div', { class: 'row-head' }, h('button', { class: 'linklike', onclick: () => { st.front = undefined; st.pickDef = undefined; render(); } }, '‹ Fronts'), h('b', {}, FRONTS[fr].name)));
    out.push(h('div', { class: 'label' }, 'Pressure (pick first, then tap a coverage)'),
      h('div', { class: 'seg wrap' }, (Object.keys(PRESSURES) as Pressure[]).map((p) =>
        h('button', { class: st.pressure === p ? 'on' : '', onclick: () => { st.pressure = p; st.pickDef = undefined; render(); } }, PRESSURES[p].name))));
    if (st.settings.tips) out.push(h('div', { class: 'tip' }, describePressure(st.pressure)));
    out.push(h('div', { class: 'label' }, 'Coverage'),
      h('div', { class: 'grid2' }, (Object.keys(COVERAGES) as Coverage[]).map((c) => {
        const allowed = pressuresFor(c);
        const pr = allowed.includes(st.pressure) ? st.pressure : allowed[0];
        const m = coverageMatchups(c);
        const tip = `${COVERAGE_PLAIN[c].split(',')[0]}${m.stops.length ? ` · Stops ${m.stops.slice(0, 2).map((x) => CONCEPTS[x].name).join(', ')}` : ''}`;
        const dc: DefCall = { front: fr, coverage: c, pressure: pr };
        return artButton(defenseDiagram(dc, offFormation), COVERAGES[c].name + (pr !== st.pressure ? ` + ${PRESSURES[pr].name}` : ''), [tipLine(tip)], () => selectDef(dc), sameDef(st.pickDef, dc));
      })));
    return out;
  }

  const picks = quickPicksDefense(s, cpuTeam().team, offFormation);
  out.push(h('div', { class: 'label' }, 'Quick picks'), h('div', { class: 'grid2 quick' }, picks.map((dc) =>
    artButton(defenseDiagram(dc, offFormation), COVERAGES[dc.coverage].name + (dc.pressure !== 'base' ? ` · ${PRESSURES[dc.pressure].name}` : ''), [h('small', {}, FRONTS[dc.front].name)], () => selectDef(dc), sameDef(st.pickDef, dc), true))));
  const xp = leagueXPass(s);
  out.push(h('div', { class: 'hint' }, `League teams pass about ${Math.round(xp * 100)}% of the time in this spot.`));
  out.push(h('div', { class: 'label' }, 'Front'),
    h('div', { class: 'grid2' }, (Object.keys(FRONTS) as Front[]).map((fr) =>
      artButton(defenseDiagram({ front: fr, coverage: 'c3', pressure: 'base' }, offFormation), FRONTS[fr].name,
        [tipLine(FRONT_PLAIN[fr].split('.').slice(1, 2).join('').trim() || FRONT_PLAIN[fr])], () => { st.front = fr; st.pickDef = undefined; render(); }))));
  return out;
}

function finalPanel(): HTMLElement {
  const game = g();
  const box = boxScore(game);
  const row = (label: string, f: (s: Side) => string) => h('tr', {}, h('td', {}, f('away')), h('th', {}, label), h('td', {}, f('home')));
  const b = box.team;
  const won = game.s.winner === st.userSide;
  const players = box.players.filter((l) => l.passAtt || l.rushAtt >= 3 || l.rec >= 2).sort((a, b2) => (b2.passYds + b2.rushYds + b2.recYds) - (a.passYds + a.rushYds + a.recYds)).slice(0, 8);
  return h('section', { class: 'sheet final' },
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
      h('button', { class: 'primary', onclick: () => void newGame() }, 'Rematch'),
      h('button', { onclick: () => { st.screen = 'setup'; render(); } }, 'New matchup')));
}

// ---------- Learn ----------
function learnScreen(): HTMLElement {
  const sec = (title: string, ...items: (HTMLElement | string)[]) => h('details', { class: 'learn-sec' }, h('summary', {}, title), ...items.map((x) => (typeof x === 'string' ? h('p', {}, x) : x)));
  const list = (items: string[]) => h('ul', {}, items.map((t) => {
    const i = t.indexOf(':');
    return h('li', {}, h('b', {}, t.slice(0, i + 1)), t.slice(i + 1));
  }));
  const withArt = (items: { text: string; img: string }[]) => h('ul', { class: 'art-list' }, items.map(({ text, img }) => {
    const i = text.indexOf(':');
    return h('li', {}, h('img', { src: img, alt: '', draggable: 'false' }), h('div', {}, h('b', {}, text.slice(0, i + 1)), text.slice(i + 1)));
  }));
  const concepts = Object.keys(CONCEPTS) as Concept[];
  const formationFor = (c: Concept): Formation => (FORMATIONS.shotgun.concepts.includes(c) ? 'shotgun' : (Object.keys(FORMATIONS) as Formation[]).find((f) => FORMATIONS[f].concepts.includes(c))!);
  const offArt = (kind: 'run' | 'pass') => concepts.filter((c) => CONCEPTS[c].kind === kind).map((c) => ({ text: describeConcept(c), img: offenseDiagram({ formation: formationFor(c), concept: c }) }));
  const exampleFormation: Formation = 'shotgun';
  return h('div', { class: 'screen learn' },
    h('div', { class: 'row-head' }, h('button', { class: 'linklike', onclick: () => { st.screen = st.learnReturn; render(); } }, '‹ Back'), h('b', {}, 'Learn')),
    h('p', { class: 'muted' }, 'Tap a section to open it. You can read these any time during a game.'),
    sec('How to read the diagrams',
      'Offense is drawn with circles (O) and the quarterback is the filled circle. White lines are routes: where each receiver runs. A yellow arrow is the ball carrier on a run. Short T-shaped lines are players staying in to block.',
      'Defense is drawn with X\'s. Yellow and pink ovals are zones: each defender guards an area. Dashed blue lines mean man-to-man: that defender follows one receiver. Red arrows are blitzers rushing the quarterback.',
      'On the field during a game the same lines are drawn on top of the players. Turn them on or off with the "Routes" button above the field.'),
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
        'The field view: The offense always moves up the screen. The blue line is where the ball is spotted; the yellow line is where the offense needs to reach for a first down.',
      ])),
    sec('How each play is decided',
      'Every snap, your call is matched against the other coordinator\'s call. Some calls beat others (a screen against a blitz, a run against a defense with few players near the line). That matchup matters most.',
      'Then player ratings matter: a great quarterback completes more passes, a great pass rush gets more sacks.',
      'Finally there\'s some luck, so a good call can still fail and a bad call can still work. Over a game, good calls add up.',
      'Watch out: the other coordinator scouts you. Call the same thing over and over and they will adjust to stop it.'),
    sec('Offensive formations', withArt((Object.keys(FORMATIONS) as Formation[]).map((f) => ({ text: describeFormation(f), img: formationDiagram(f) })))),
    sec('Run plays', withArt(offArt('run'))),
    sec('Pass plays', withArt(offArt('pass'))),
    sec('Defensive fronts (who is on the field)', withArt((Object.keys(FRONTS) as Front[]).map((fr) => ({ text: describeFront(fr), img: defenseDiagram({ front: fr, coverage: 'c3', pressure: 'base' }, exampleFormation) })))),
    sec('Coverages (how the defense guards passes)', withArt((Object.keys(COVERAGES) as Coverage[]).map((c) => ({ text: describeCoverage(c), img: defenseDiagram({ front: 'nickel', coverage: c, pressure: 'base' }, exampleFormation) })))),
    sec('Pressure (blitzing)', withArt((Object.keys(PRESSURES) as Pressure[]).map((p) => ({
      text: describePressure(p), img: defenseDiagram({ front: '43', coverage: p === 'all_out' ? 'c0' : p === 'zone_blitz' ? 'c3' : 'c1', pressure: p }, exampleFormation),
    })))),
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
