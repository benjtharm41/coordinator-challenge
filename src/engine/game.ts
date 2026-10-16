// The game: state, rules, clock, scoring, overtime.
import { chooseDefense, chooseOffense, chooseTry, chooseTwoPointPlay, newScout, recordScout, wantsOnside, wantsTimeout, type CallMemory, type ScoutReport, type Situation, leagueXPass } from './ai';
import { describePlay } from './narrate';
import { buildLineup, unitRatings } from './ratings';
import { resolveScrimmage, type Penalty, type ScrimmageOutcome, type Unit } from './resolve';
import { clamp, Rng } from './rng';
import { extraPoint, fieldGoal, fieldGoalProb, kickoff, punt, type KickResult } from './special';
import { other, type DefCall, type OffCall, type OffChoice, type Side, type Team, type Tempo } from './types';

export type Controller = 'human' | 'cpu';

export interface ScenarioSetup {
  quarter: number;
  clock: number;
  possession: Side;
  /** Distance to the end zone the offense attacks. */
  yardline: number;
  down: number;
  distance: number;
  score: Record<Side, number>;
  timeouts: Record<Side, number>;
  ot?: boolean;
}

export interface GameSettings {
  quarterSeconds: number;
  /** Short game: the clock runs faster between plays (outside the last 2:00 of each half). */
  short: boolean;
  otSeconds: number;
  penalties: boolean;
  seed?: number;
}

export const DEFAULT_SETTINGS: GameSettings = { quarterSeconds: 900, short: false, otSeconds: 600, penalties: true };

/** Extra between-play runoff multiplier for short games (tuned to ~half the snaps). */
export const SHORT_GAME_RUNOFF = 2.6;

export interface TeamSide {
  team: Team;
  unit: Unit;
  score: number;
  timeouts: number;
  controller: Controller;
  memory: CallMemory;
  /** This team's own recent calls (what the opponent has scouted). */
  scout: ScoutReport;
}

export type Phase = 'kickoff' | 'scrimmage' | 'try' | 'final';

export type LogKind =
  | 'run' | 'pass' | 'sack' | 'scramble' | 'kneel' | 'spike' | 'penalty'
  | 'kickoff' | 'punt' | 'fg' | 'xp' | '2pt' | 'timeout' | 'info';

export interface PlayLog {
  id: number;
  kind: LogKind;
  quarter: number;
  clock: number;
  offense: Side;
  down: number;
  distance: number;
  yardline: number;
  offCall?: OffCall;
  defCall?: DefCall;
  tempo?: Tempo;
  outcome?: ScrimmageOutcome;
  kick?: KickResult;
  penalty?: Penalty & { accepted: boolean };
  /** Net yards for the offense (after penalties). */
  yards: number;
  firstDown?: boolean;
  turnover?: boolean;
  touchdown?: boolean;
  points?: { side: Side; pts: number; type: 'TD' | 'FG' | 'XP' | '2PT' | 'SAFETY' };
  text: string;
  score: Record<Side, number>;
  /** Seconds of game clock used by the play itself plus the pre-snap runoff. */
  elapsed: number;
}

export interface Drive {
  side: Side;
  startYardline: number;
  quarter: number;
  clock: number;
  plays: number;
  yards: number;
  result?: string;
  reachedRedZone: boolean;
}

export type Decision =
  | { kind: 'kickoff'; kicking: Side; canOnside: boolean }
  | { kind: 'try'; team: Side }
  | { kind: 'snap'; offense: Side; defense: Side }
  | { kind: 'final' };

export interface GameState {
  quarter: number;
  clock: number;
  phase: Phase;
  possession: Side;
  yardline: number;
  down: number;
  distance: number;
  clockRunning: boolean;
  kickingTeam: Side;
  kickFrom: number;
  openingReceiver: Side;
  warned: Record<number, boolean>;
  ot: { on: boolean; possessions: Record<Side, number>; first?: Side };
  untimedDown: boolean;
  winner?: Side | 'tie';
  /** Set when the last possession has ended and the quarter is out of time. */
  pendingQuarterEnd: boolean;
}

export class Game {
  readonly settings: GameSettings;
  readonly rng: Rng;
  readonly sides: Record<Side, TeamSide>;
  s: GameState;
  log: PlayLog[] = [];
  drives: Drive[] = [];
  private nextId = 1;

  constructor(home: Team, away: Team, controllers: Record<Side, Controller>, settings: Partial<GameSettings> = {}) {
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
    this.rng = new Rng(this.settings.seed ?? (Date.now() ^ Math.floor(Math.random() * 1e9)));
    const mk = (team: Team, controller: Controller): TeamSide => {
      const lineup = buildLineup(team);
      return { team, unit: { lineup, ratings: unitRatings(lineup) }, score: 0, timeouts: 3, controller, memory: { recent: [] }, scout: newScout() };
    };
    this.sides = { home: mk(home, controllers.home), away: mk(away, controllers.away) };
    const receiver: Side = this.rng.chance(0.5) ? 'home' : 'away';
    this.s = {
      quarter: 1, clock: this.settings.quarterSeconds, phase: 'kickoff', possession: receiver, yardline: 75, down: 1, distance: 10,
      clockRunning: false, kickingTeam: other(receiver), kickFrom: 35, openingReceiver: receiver, warned: {},
      ot: { on: false, possessions: { home: 0, away: 0 } }, untimedDown: false, pendingQuarterEnd: false,
    };
    this.info(`${this.sides[receiver].team.info.name} will receive the opening kickoff.`);
  }

  // ---------------- Scenarios ----------------

  /** Jump straight to a game situation (used by Situations mode). */
  applySetup(setup: ScenarioSetup) {
    this.s.quarter = setup.quarter;
    this.s.clock = setup.clock;
    this.s.phase = 'scrimmage';
    this.s.possession = setup.possession;
    this.s.yardline = setup.yardline;
    this.s.down = setup.down;
    this.s.distance = setup.distance;
    this.s.clockRunning = false;
    this.s.untimedDown = false;
    this.s.warned = {};
    if ((setup.quarter === 2 || setup.quarter === 4) && setup.clock <= 120) this.s.warned[setup.quarter] = true;
    this.s.ot = { on: !!setup.ot, possessions: { home: 0, away: 0 }, first: setup.ot ? setup.possession : undefined };
    this.s.openingReceiver = other(setup.possession);
    this.sides.home.score = setup.score.home;
    this.sides.away.score = setup.score.away;
    this.sides.home.timeouts = setup.timeouts.home;
    this.sides.away.timeouts = setup.timeouts.away;
    this.log = [];
    this.drives = [];
    this.startDrive();
  }

  // ---------------- Queries ----------------

  get offense(): TeamSide {
    return this.sides[this.s.possession];
  }
  get defense(): TeamSide {
    return this.sides[other(this.s.possession)];
  }

  secondsLeftHalf(): number {
    const q = this.settings.quarterSeconds;
    return this.s.quarter === 1 || this.s.quarter === 3 ? this.s.clock + q : this.s.clock;
  }
  secondsLeftGame(): number {
    const q = this.settings.quarterSeconds;
    return this.s.quarter >= 4 ? this.s.clock : this.s.clock + (4 - this.s.quarter) * q;
  }

  situation(side: Side = this.s.possession): Situation {
    const off = this.sides[side];
    const def = this.sides[other(side)];
    return {
      down: this.s.down, distance: this.s.distance, yardline: this.s.yardline,
      scoreDiff: off.score - def.score, quarter: this.s.quarter, clock: this.s.clock,
      secondsLeftHalf: this.s.ot.on ? this.s.clock : this.secondsLeftHalf(),
      secondsLeftGame: this.s.ot.on ? this.s.clock : this.secondsLeftGame(),
      offTimeouts: off.timeouts, defTimeouts: def.timeouts, clockRunning: this.s.clockRunning, ot: this.s.ot.on,
      fgProb: this.s.yardline + 17 <= 70 ? fieldGoalProb(off.unit, this.s.yardline + 17) : 0,
      netPunt: 42,
    };
  }

  pending(): Decision {
    switch (this.s.phase) {
      case 'final':
        return { kind: 'final' };
      case 'kickoff': {
        const k = this.sides[this.s.kickingTeam];
        const diff = k.score - this.sides[other(this.s.kickingTeam)].score;
        return { kind: 'kickoff', kicking: this.s.kickingTeam, canOnside: this.s.kickFrom === 35 && this.s.quarter >= 4 && diff < 0 };
      }
      case 'try':
        return { kind: 'try', team: this.s.possession };
      default:
        return { kind: 'snap', offense: this.s.possession, defense: other(this.s.possession) };
    }
  }

  /** "KC 32" style field position for the given offense. */
  spotName(offense: Side, yardline: number): string {
    if (yardline === 50) return '50';
    const off = this.sides[offense].team.info.abbr;
    const def = this.sides[other(offense)].team.info.abbr;
    return yardline > 50 ? `${off} ${100 - yardline}` : `${def} ${yardline}`;
  }

  // ---------------- Logging ----------------

  private push(entry: Omit<PlayLog, 'id' | 'score'>): PlayLog {
    const e: PlayLog = { ...entry, id: this.nextId++, score: { home: this.sides.home.score, away: this.sides.away.score } };
    this.log.push(e);
    return e;
  }

  private info(text: string): PlayLog {
    return this.push({ kind: 'info', quarter: this.s.quarter, clock: this.s.clock, offense: this.s.possession, down: this.s.down, distance: this.s.distance, yardline: this.s.yardline, yards: 0, text, elapsed: 0 });
  }

  private get drive(): Drive | undefined {
    return this.drives[this.drives.length - 1];
  }

  private startDrive() {
    this.drives.push({ side: this.s.possession, startYardline: this.s.yardline, quarter: this.s.quarter, clock: this.s.clock, plays: 0, yards: 0, reachedRedZone: this.s.yardline <= 20 });
  }

  private endDrive(result: string) {
    const d = this.drive;
    if (!d || d.result) return;
    d.result = result;
    if (this.s.ot.on) this.s.ot.possessions[d.side]++;
  }

  // ---------------- Clock ----------------

  private inTwoMinuteQuarter() {
    return this.s.quarter === 2 || this.s.quarter === 4 || this.s.ot.on;
  }

  /** Out-of-bounds stops the clock only late in halves. */
  private lateWindow() {
    if (this.s.quarter === 2 || this.s.ot.on) return this.s.clock <= 120;
    if (this.s.quarter === 4) return this.s.clock <= 300;
    return false;
  }

  private checkTwoMinute(before: number, exact: boolean): boolean {
    if (!this.inTwoMinuteQuarter() || this.s.warned[this.s.quarter]) return false;
    if (before > 120 && this.s.clock <= 120) {
      if (exact) this.s.clock = 120;
      this.s.warned[this.s.quarter] = true;
      this.s.clockRunning = false;
      this.info('Two-minute warning.');
      return true;
    }
    return false;
  }

  private preSnapRunoff(tempo: Tempo | 'spike' | 'kneel'): number {
    if (!this.s.clockRunning) return 0;
    const rng = this.rng;
    let sec: number;
    switch (tempo) {
      case 'hurry':
        sec = clamp(rng.normal(13, 2.5), 8, 20);
        break;
      case 'milk':
      case 'kneel':
        sec = clamp(rng.normal(38.5, 1), 36, 40);
        break;
      case 'spike':
        sec = clamp(rng.normal(9, 2), 5, 14);
        break;
      default:
        sec = clamp(rng.normal(33.8, 3), 22, 39);
    }
    if (this.settings.short && this.secondsLeftHalf() > 120 && !this.s.ot.on && tempo !== 'spike') sec *= SHORT_GAME_RUNOFF;
    sec = Math.round(sec);
    const before = this.s.clock;
    this.s.clock = Math.max(0, this.s.clock - sec);
    this.checkTwoMinute(before, true);
    return before - this.s.clock;
  }

  private runPlayClock(duration: number) {
    const before = this.s.clock;
    this.s.clock = Math.max(0, this.s.clock - Math.round(duration));
    // The two-minute warning after a play that crossed 2:00 stops the clock.
    if (this.inTwoMinuteQuarter() && !this.s.warned[this.s.quarter] && before > 120 && this.s.clock <= 120) {
      this.s.warned[this.s.quarter] = true;
      return true;
    }
    return false;
  }

  timeout(side: Side): boolean {
    const t = this.sides[side];
    if (t.timeouts <= 0 || this.s.phase === 'final' || this.s.phase === 'kickoff') return false;
    t.timeouts--;
    this.s.clockRunning = false;
    this.push({ kind: 'timeout', quarter: this.s.quarter, clock: this.s.clock, offense: this.s.possession, down: this.s.down, distance: this.s.distance, yardline: this.s.yardline, yards: 0, elapsed: 0,
      text: `Timeout, ${t.team.info.name} (${t.timeouts} left).` });
    return true;
  }

  // ---------------- Kickoffs and tries ----------------

  doKickoff(onside = false): PlayLog {
    const kicking = this.s.kickingTeam;
    const receiving = other(kicking);
    const allowed = this.pending();
    if (allowed.kind !== 'kickoff') throw new Error('Not a kickoff');
    const k = kickoff(this.rng, this.sides[kicking].unit, this.sides[receiving].unit, onside && allowed.canOnside, this.s.kickFrom);
    this.s.kickFrom = 35;
    const clockBefore = this.s.clock;
    this.runPlayClock(k.duration);
    this.s.clockRunning = false;
    const newOffense = k.kickingTeamBall ? kicking : receiving;
    this.s.possession = newOffense;
    this.s.yardline = k.newYardline;
    this.s.down = 1;
    this.s.distance = Math.min(10, this.s.yardline);
    this.s.phase = 'scrimmage';
    k.text = k.text.replace('{spot}', this.spotName(newOffense, this.s.yardline));
    const entry = this.push({ kind: 'kickoff', quarter: this.s.quarter, clock: clockBefore, offense: kicking, down: 0, distance: 0, yardline: 65, kick: k, yards: 0, text: k.text, elapsed: clockBefore - this.s.clock });
    if (k.touchdown) this.scoreTD(newOffense, entry, 'return');
    else this.startDrive();
    this.afterPlay();
    return entry;
  }

  /** Extra point or 2-point try. For a 2-point try pass the calls (CPU fills missing ones). */
  doTry(kind: 'xp' | '2pt', offCall?: OffCall, defCall?: DefCall): PlayLog {
    const team = this.s.possession;
    const off = this.sides[team];
    const def = this.sides[other(team)];
    let entry: PlayLog;
    if (kind === 'xp') {
      const r = extraPoint(this.rng, off.unit);
      if (r.good) off.score += 1;
      entry = this.push({ kind: 'xp', quarter: this.s.quarter, clock: this.s.clock, offense: team, down: 0, distance: 0, yardline: 15, yards: 0, text: r.text, elapsed: 0,
        points: r.good ? { side: team, pts: 1, type: 'XP' } : undefined });
    } else {
      const oc = offCall ?? chooseTwoPointPlay(off.team, this.rng);
      const sit: Situation = { ...this.situation(team), down: 4, distance: 2, yardline: 2 };
      const dc = defCall ?? chooseDefense(sit, def.team, oc.formation, this.rng);
      const out = resolveScrimmage({ off: oc, def: dc, o: off.unit, d: def.unit, sit: { down: 4, distance: 2, yardline: 2, xpass: 0.6 }, penalties: false, rng: this.rng });
      const good = !out.intercepted && !out.fumbleLost && out.type !== 'sack' && out.yards >= 2;
      if (good) off.score += 2;
      const text = `2-point try: ${describePlay(out, oc, dc, this.sides)} ${good ? 'GOOD!' : 'Failed.'}`;
      entry = this.push({ kind: '2pt', quarter: this.s.quarter, clock: this.s.clock, offense: team, down: 0, distance: 2, yardline: 2, offCall: oc, defCall: dc, outcome: out, yards: out.yards, text, elapsed: 0,
        points: good ? { side: team, pts: 2, type: '2PT' } : undefined });
    }
    this.s.phase = 'kickoff';
    this.s.kickingTeam = team;
    this.s.kickFrom = 35;
    this.checkOtAfterScore(team, false);
    this.checkEndOfPeriod();
    return entry;
  }

  // ---------------- Scrimmage ----------------

  /** CPU timeouts before a snap. Returns log entries for any timeouts called. */
  cpuTimeouts(): PlayLog[] {
    if (this.s.phase !== 'scrimmage') return [];
    const out: PlayLog[] = [];
    const off = this.s.possession;
    const def = other(off);
    if (this.sides[def].controller === 'cpu' && wantsTimeout(this.situation(), 'def') && this.timeout(def)) out.push(this.log[this.log.length - 1]);
    else if (this.sides[off].controller === 'cpu' && wantsTimeout(this.situation(), 'off') && this.timeout(off)) out.push(this.log[this.log.length - 1]);
    return out;
  }

  cpuOffenseChoice(): OffChoice {
    return chooseOffense(this.situation(), this.offense.team, this.rng, this.offense.memory, this.defense.scout);
  }

  cpuDefenseCall(offFormation: OffCall['formation']): DefCall {
    return chooseDefense(this.situation(), this.defense.team, offFormation, this.rng, this.offense.scout);
  }

  /** Run one snap. Missing defensive call is filled by the CPU. Returns new log entries. */
  snap(choice: OffChoice, defCall?: DefCall): PlayLog[] {
    if (this.s.phase !== 'scrimmage') throw new Error('Not a scrimmage down');
    const startLen = this.log.length;
    const offSide = this.s.possession;
    const defSide = other(offSide);
    const off = this.sides[offSide];
    const def = this.sides[defSide];

    const tempo: Tempo | 'spike' | 'kneel' = choice.type === 'play' ? choice.tempo : choice.type === 'spike' ? 'spike' : choice.type === 'kneel' ? 'kneel' : 'normal';
    const runoff = this.preSnapRunoff(tempo);
    if (this.s.clock <= 0 && !this.s.untimedDown) {
      this.endQuarter();
      return this.log.slice(startLen);
    }
    this.s.untimedDown = false;
    const snapClock = this.s.clock;
    const base = { quarter: this.s.quarter, clock: snapClock, offense: offSide, down: this.s.down, distance: this.s.distance, yardline: this.s.yardline };
    if (this.drive) this.drive.plays++;

    if (choice.type === 'punt') {
      const k = punt(this.rng, off.unit, def.unit, this.s.yardline);
      this.runPlayClock(k.duration);
      this.s.clockRunning = false;
      const entry = this.push({ ...base, kind: 'punt', kick: k, yards: 0, text: k.text, elapsed: runoff + snapClock - this.s.clock });
      this.endDrive('Punt');
      this.s.possession = k.kickingTeamBall ? offSide : defSide;
      this.s.yardline = k.newYardline;
      this.newSeries();
      if (k.touchdown) this.scoreTD(this.s.possession, entry, 'return');
      else this.startDrive();
      this.afterPlay();
      return this.log.slice(startLen);
    }

    if (choice.type === 'fg') {
      const r = fieldGoal(this.rng, off.unit, this.s.yardline);
      this.runPlayClock(5);
      this.s.clockRunning = false;
      const entry = this.push({ ...base, kind: 'fg', yards: 0, text: r.text, elapsed: runoff + snapClock - this.s.clock, points: r.good ? { side: offSide, pts: 3, type: 'FG' } : undefined });
      if (r.good) {
        off.score += 3;
        this.endDrive('Field goal');
        this.s.phase = 'kickoff';
        this.s.kickingTeam = offSide;
        this.s.kickFrom = 35;
        this.checkOtAfterScore(offSide, false);
      } else {
        this.endDrive(r.blocked ? 'Blocked field goal' : 'Missed field goal');
        const spot = this.s.yardline + 7;
        this.s.possession = defSide;
        this.s.yardline = spot <= 20 ? 80 : clamp(100 - spot, 1, 99);
        this.newSeries();
        this.startDrive();
        entry.turnover = true;
      }
      this.afterPlay();
      return this.log.slice(startLen);
    }

    if (choice.type === 'kneel') {
      this.runPlayClock(2);
      this.s.clockRunning = true;
      const entry = this.push({ ...base, kind: 'kneel', yards: -1, text: `${off.unit.lineup.QB.name} takes a knee.`, elapsed: runoff + snapClock - this.s.clock });
      this.advanceDowns(-1, false, entry);
      this.afterPlay();
      return this.log.slice(startLen);
    }

    if (choice.type === 'spike') {
      this.runPlayClock(1);
      this.s.clockRunning = false;
      const entry = this.push({ ...base, kind: 'spike', yards: 0, text: `${off.unit.lineup.QB.name} spikes it to stop the clock.`, elapsed: runoff + snapClock - this.s.clock });
      this.advanceDowns(0, false, entry);
      this.afterPlay();
      return this.log.slice(startLen);
    }

    // A real play.
    const call = choice.call;
    const dc = defCall ?? this.cpuDefenseCall(call.formation);
    recordScout(off.scout, call.concept);
    recordScout(def.scout, undefined, dc);
    const sit = this.situation();
    const out = resolveScrimmage({
      off: call, def: dc, o: off.unit, d: def.unit,
      sit: { down: this.s.down, distance: this.s.distance, yardline: this.s.yardline, xpass: leagueXPass(sit) },
      penalties: this.settings.penalties, rng: this.rng, hurry: choice.tempo === 'hurry',
    });
    this.applyScrimmage(out, call, dc, choice.tempo, base, runoff);
    return this.log.slice(startLen);
  }

  private applyScrimmage(out: ScrimmageOutcome, call: OffCall, dc: DefCall, tempo: Tempo, base: Pick<PlayLog, 'quarter' | 'clock' | 'offense' | 'down' | 'distance' | 'yardline'>, runoff: number) {
    const offSide = this.s.possession;
    const defSide = other(offSide);
    const y0 = this.s.yardline;
    const pen = out.penalty;
    let text = describePlay(out, call, dc, this.sides);

    // ----- Pre-snap penalties: no play, no time off.
    if (pen?.presnap) {
      const yards = this.penaltyYards(pen);
      const signed = pen.on === 'off' ? -yards : yards;
      const entry = this.push({ ...base, kind: 'penalty', offCall: call, defCall: dc, tempo, outcome: out, penalty: { ...pen, accepted: true }, yards: signed, text: penaltyText(pen, this.sides, offSide, yards), elapsed: runoff });
      this.s.yardline -= signed;
      this.s.distance -= signed;
      if (this.s.distance <= 0) {
        this.newSeries();
        entry.firstDown = true;
      }
      this.afterPlay();
      return;
    }

    // ----- Decide whether a live-ball penalty is accepted.
    let accepted = false;
    if (pen) {
      if (pen.on === 'off') {
        const turnover = out.intercepted || out.fumbleLost;
        const badPlay = out.yards <= -pen.yards || (out.type === 'pass' && !out.complete && this.s.down >= 3);
        accepted = !turnover && !badPlay;
      } else {
        // Offense declines if the play itself was better.
        const playTD = out.yards >= y0 && !out.intercepted && !out.fumbleLost;
        const playFirst = out.yards >= this.s.distance && !out.intercepted && !out.fumbleLost;
        accepted = pen.addOn ? true : !(playTD || (playFirst && out.yards >= pen.yards));
      }
    }

    const playClockStop = this.runPlayClock(out.duration);
    const timeExpired = this.s.clock <= 0;

    if (pen && accepted) {
      const yards = this.penaltyYards(pen);
      if (pen.on === 'def' && pen.addOn && !out.intercepted && !out.fumbleLost && out.yards < y0) {
        // Play stands, 15 more yards and a first down.
        const total = out.yards + Math.min(yards, Math.floor((y0 - out.yards) / 2));
        text += ` ${penaltyText(pen, this.sides, offSide, yards)}`;
        const entry = this.push({ ...base, kind: out.type === 'none' ? 'penalty' : (out.type as LogKind), offCall: call, defCall: dc, tempo, outcome: out, penalty: { ...pen, accepted: true }, yards: total, text, elapsed: runoff + base.clock - this.s.clock });
        this.s.yardline = y0 - total;
        this.newSeries();
        entry.firstDown = true;
        if (this.drive) this.drive.yards += total;
        this.s.clockRunning = !(out.type === 'pass' && !out.complete);
        if (timeExpired) this.s.untimedDown = true;
        this.afterPlay();
        return;
      }
      // Penalty replaces the play.
      const entry = this.push({ ...base, kind: 'penalty', offCall: call, defCall: dc, tempo, outcome: out, penalty: { ...pen, accepted: true }, yards: pen.on === 'off' ? -yards : yards,
        text: `${penaltyText(pen, this.sides, offSide, yards)} (Play: ${text})`, elapsed: runoff + base.clock - this.s.clock });
      if (pen.on === 'off') {
        this.s.yardline += yards;
        this.s.distance += yards;
      } else {
        this.s.yardline -= yards;
        this.s.distance -= yards;
        if (pen.autoFirst || this.s.distance <= 0) {
          this.newSeries();
          entry.firstDown = true;
        }
        if (timeExpired) this.s.untimedDown = true;
      }
      if (this.drive) this.drive.yards += entry.yards;
      this.s.clockRunning = !(out.type === 'pass' && !out.complete) && !playClockStop;
      this.afterPlay();
      return;
    }
    if (pen && !accepted) text += ` (${pen.name} declined)`;

    const kind: LogKind = out.type === 'none' ? 'penalty' : out.type;
    const entry = this.push({ ...base, kind, offCall: call, defCall: dc, tempo, outcome: out, penalty: pen ? { ...pen, accepted: false } : undefined, yards: out.yards, text, elapsed: runoff + base.clock - this.s.clock });

    // ----- Turnovers.
    if (out.intercepted || out.fumbleLost) {
      entry.turnover = true;
      if (this.drive) this.drive.yards += out.intercepted ? 0 : out.yards;
      this.endDrive(out.intercepted ? 'Interception' : 'Fumble');
      const spot = y0 - (out.intercepted ? out.airYards ?? 0 : out.yards); // distance to the defense's goal... from offense's view
      this.s.possession = defSide;
      if (out.touchback) {
        this.s.yardline = 80;
      } else {
        this.s.yardline = clamp(100 - spot, 1, 99) - (out.returnYards ?? 0);
      }
      this.s.clockRunning = false;
      if (this.s.yardline <= 0) {
        this.scoreTD(defSide, entry, 'defense');
      } else {
        if (this.s.yardline >= 100) this.s.yardline = 80;
        this.newSeries();
        this.startDrive();
      }
      this.afterPlay();
      return;
    }

    // ----- Clock after the play.
    const incomplete = out.type === 'pass' && !out.complete;
    this.s.clockRunning = !(incomplete || (out.outOfBounds && this.lateWindow()) || playClockStop);
    if (playClockStop) this.info('Two-minute warning.');

    if (this.drive) {
      this.drive.yards += out.yards;
    }
    this.advanceDowns(out.yards, true, entry);
    this.afterPlay();
  }

  private penaltyYards(p: Penalty): number {
    const y = this.s.yardline;
    if (p.on === 'off') return Math.min(p.yards, Math.floor((100 - y) / 2));
    if (p.spot !== undefined) return Math.min(p.spot, y - 1);
    return Math.min(p.yards, Math.floor(y / 2));
  }

  private advanceDowns(yards: number, scrimmagePlay: boolean, entry?: PlayLog) {
    const offSide = this.s.possession;
    const newY = this.s.yardline - yards;
    if (newY <= 0) {
      if (entry) this.scoreTD(offSide, entry, 'offense');
      return;
    }
    if (newY >= 100) {
      // Safety.
      const defSide = other(offSide);
      this.sides[defSide].score += 2;
      if (entry) {
        entry.points = { side: defSide, pts: 2, type: 'SAFETY' };
        entry.text += ' SAFETY!';
        entry.score = { home: this.sides.home.score, away: this.sides.away.score };
      }
      this.endDrive('Safety');
      this.s.clockRunning = false;
      this.s.phase = 'kickoff';
      this.s.kickingTeam = offSide;
      this.s.kickFrom = 20;
      this.checkOtAfterScore(defSide, true);
      return;
    }
    this.s.yardline = newY;
    if (this.drive && newY <= 20) this.drive.reachedRedZone = true;
    if (yards >= this.s.distance) {
      this.newSeries();
      if (entry) entry.firstDown = scrimmagePlay;
      return;
    }
    this.s.distance -= yards;
    this.s.down++;
    if (this.s.down > 4) {
      if (entry) entry.turnover = true;
      this.info(`Turnover on downs.`);
      this.endDrive('Downs');
      this.s.possession = other(offSide);
      this.s.yardline = 100 - newY;
      this.s.clockRunning = false;
      this.newSeries();
      this.startDrive();
    }
  }

  private newSeries() {
    this.s.down = 1;
    this.s.distance = Math.min(10, this.s.yardline);
  }

  /** how: offense scored on its drive, defense scored on a turnover, or a kick/punt return. */
  private scoreTD(side: Side, entry: PlayLog, how: 'offense' | 'defense' | 'return') {
    this.sides[side].score += 6;
    entry.touchdown = true;
    entry.points = { side, pts: 6, type: 'TD' };
    entry.score = { home: this.sides.home.score, away: this.sides.away.score };
    if (!/TOUCHDOWN/.test(entry.text)) entry.text += ` TOUCHDOWN ${this.sides[side].team.info.nick}!`;
    if (how === 'offense') this.endDrive('Touchdown');
    // A return touchdown counts as the returning team's possession in overtime.
    if (how === 'return' && this.s.ot.on) this.s.ot.possessions[side]++;
    this.s.possession = side;
    this.s.clockRunning = false;
    this.s.yardline = 15;
    this.s.down = 1;
    this.s.distance = 2;
    this.s.phase = 'try';
    const over = this.checkOtAfterScore(side, how === 'defense');
    if (!over && !this.s.ot.on && this.s.quarter >= 4 && this.s.clock <= 0) {
      // Touchdown on the final play: skip the try if it can't matter.
      const lead = this.sides[side].score - this.sides[other(side)].score;
      if (lead > 0) {
        this.s.phase = 'kickoff';
        this.checkEndOfPeriod();
      }
    }
  }

  /** Returns true if the game ended. */
  private checkOtAfterScore(scorer: Side, defensiveScore: boolean): boolean {
    if (!this.s.ot.on || this.s.phase === 'final') return false;
    const lead = this.sides[scorer].score - this.sides[other(scorer)].score;
    const p = this.s.ot.possessions;
    const bothHad = p.home > 0 && p.away > 0;
    if (lead > 0 && (defensiveScore || bothHad)) {
      this.finish(scorer);
      return true;
    }
    return false;
  }

  /** Called after every play: handles end of quarters/halves/game. */
  private afterPlay() {
    if (this.s.phase === 'final') return;
    // OT: second team's possession ended without taking the lead.
    if (this.s.ot.on && this.s.phase === 'scrimmage') {
      const p = this.s.ot.possessions;
      if (p.home > 0 && p.away > 0 && this.sides.home.score !== this.sides.away.score) {
        this.finish(this.sides.home.score > this.sides.away.score ? 'home' : 'away');
        return;
      }
    }
    this.checkEndOfPeriod();
  }

  private checkEndOfPeriod() {
    if (this.s.phase === 'final' || this.s.phase === 'try') return;
    if (this.s.clock > 0 || this.s.untimedDown) return;
    this.endQuarter();
  }

  private endQuarter() {
    const q = this.s.quarter;
    if (this.s.phase === 'try') return;
    if (q === 1 || q === 3) {
      this.info(`End of ${q === 1 ? '1st' : '3rd'} quarter.`);
      this.s.quarter++;
      this.s.clock = this.settings.quarterSeconds;
      return;
    }
    if (q === 2) {
      this.endDrive('End of half');
      this.info('Halftime.');
      this.s.quarter = 3;
      this.s.clock = this.settings.quarterSeconds;
      this.sides.home.timeouts = 3;
      this.sides.away.timeouts = 3;
      this.s.phase = 'kickoff';
      this.s.kickingTeam = this.s.openingReceiver;
      this.s.kickFrom = 35;
      this.s.clockRunning = false;
      return;
    }
    // End of regulation or overtime.
    this.endDrive('End of game');
    const h = this.sides.home.score;
    const a = this.sides.away.score;
    if (h !== a) {
      this.finish(h > a ? 'home' : 'away');
      return;
    }
    if (this.s.ot.on) {
      this.finish('tie');
      return;
    }
    // Overtime: 10 minutes, both teams get the ball, 2 timeouts each.
    this.info('End of regulation. Overtime!');
    const receiver: Side = this.rng.chance(0.5) ? 'home' : 'away';
    this.s.quarter = 5;
    this.s.clock = this.settings.otSeconds;
    this.s.ot = { on: true, possessions: { home: 0, away: 0 }, first: receiver };
    this.sides.home.timeouts = 2;
    this.sides.away.timeouts = 2;
    this.s.warned[5] = false;
    this.s.phase = 'kickoff';
    this.s.kickingTeam = other(receiver);
    this.s.kickFrom = 35;
    this.s.clockRunning = false;
    this.info(`${this.sides[receiver].team.info.name} win the toss and will receive.`);
  }

  private finish(w: Side | 'tie') {
    this.s.phase = 'final';
    this.s.winner = w;
    this.s.clockRunning = false;
    const h = this.sides.home;
    const a = this.sides.away;
    this.info(
      w === 'tie'
        ? `Final: ${h.team.info.abbr} ${h.score}, ${a.team.info.abbr} ${a.score}. It's a tie.`
        : `Final: ${this.sides[w].team.info.name} win ${Math.max(h.score, a.score)}-${Math.min(h.score, a.score)}.`,
    );
  }

  // ---------------- CPU driver ----------------

  /** Let the CPU make the pending decision when it belongs to the CPU. Returns new entries. */
  cpuAct(): PlayLog[] {
    const d = this.pending();
    const start = this.log.length;
    if (d.kind === 'kickoff' && this.sides[d.kicking].controller === 'cpu') {
      const k = this.sides[d.kicking];
      this.doKickoff(d.canOnside && wantsOnside(k.score - this.sides[other(d.kicking)].score, this.s.quarter, this.secondsLeftGame()));
    } else if (d.kind === 'try' && this.sides[d.team].controller === 'cpu') {
      const t = this.sides[d.team];
      this.doTry(chooseTry(t.score - this.sides[other(d.team)].score, this.s.quarter, this.secondsLeftGame()));
    } else if (d.kind === 'snap' && this.sides[d.offense].controller === 'cpu' && this.sides[d.defense].controller === 'cpu') {
      this.cpuTimeouts();
      this.snap(this.cpuOffenseChoice());
    }
    return this.log.slice(start);
  }

  /** Simulate to the end (both teams CPU). */
  simToEnd(maxSteps = 5000) {
    for (let i = 0; i < maxSteps && this.s.phase !== 'final'; i++) this.cpuAct();
  }
}

function penaltyText(p: Penalty, sides: Record<Side, TeamSide>, offense: Side, yards: number): string {
  const team = p.on === 'off' ? sides[offense].team.info.abbr : sides[other(offense)].team.info.abbr;
  const who = p.player ? ` (#${p.player.num} ${p.player.name})` : '';
  const extra = p.autoFirst && p.on === 'def' ? ', automatic first down' : p.on === 'off' && !p.presnap ? ', repeat the down' : '';
  return `PENALTY ${team}: ${p.name}${who}, ${yards} yard${yards === 1 ? '' : 's'}${extra}.`;
}
