// Box score from a game log.
import type { Game, PlayLog } from './game';
import { shortName } from './narrate';
import type { Player, Side } from './types';

export interface TeamBox {
  points: number;
  firstDowns: number;
  plays: number;
  totalYards: number;
  passYards: number;
  rushYards: number;
  comp: number;
  att: number;
  passTD: number;
  ints: number;
  sacks: number;
  rushAtt: number;
  rushTD: number;
  fumblesLost: number;
  thirdConv: number;
  thirdAtt: number;
  fourthConv: number;
  fourthAtt: number;
  penalties: number;
  penaltyYards: number;
  timeOfPossession: number;
}

export interface PlayerLine {
  player: Player;
  side: Side;
  passComp: number;
  passAtt: number;
  passYds: number;
  passTD: number;
  passInt: number;
  rushAtt: number;
  rushYds: number;
  rushTD: number;
  rec: number;
  recYds: number;
  recTD: number;
  targets: number;
}

const emptyBox = (): TeamBox => ({
  points: 0, firstDowns: 0, plays: 0, totalYards: 0, passYards: 0, rushYards: 0, comp: 0, att: 0, passTD: 0, ints: 0, sacks: 0,
  rushAtt: 0, rushTD: 0, fumblesLost: 0, thirdConv: 0, thirdAtt: 0, fourthConv: 0, fourthAtt: 0, penalties: 0, penaltyYards: 0, timeOfPossession: 0,
});

export interface BoxScore {
  team: Record<Side, TeamBox>;
  players: PlayerLine[];
  scoring: PlayLog[];
  byQuarter: Record<Side, number[]>;
}

export function boxScore(g: Game): BoxScore {
  const team = { home: emptyBox(), away: emptyBox() };
  const lines = new Map<string, PlayerLine>();
  const line = (p: Player, side: Side) => {
    let l = lines.get(p.id);
    if (!l) {
      l = { player: p, side, passComp: 0, passAtt: 0, passYds: 0, passTD: 0, passInt: 0, rushAtt: 0, rushYds: 0, rushTD: 0, rec: 0, recYds: 0, recTD: 0, targets: 0 };
      lines.set(p.id, l);
    }
    return l;
  };
  const byQuarter: Record<Side, number[]> = { home: [0, 0, 0, 0, 0], away: [0, 0, 0, 0, 0] };
  const scoring: PlayLog[] = [];

  for (const e of g.log) {
    if (e.points) {
      byQuarter[e.points.side][Math.min(4, e.quarter - 1)] += e.points.pts;
      if (e.points.type !== 'XP' && e.points.type !== '2PT') scoring.push(e);
    }
    const t = team[e.offense];
    t.timeOfPossession += e.kind === 'kickoff' ? 0 : e.elapsed;
    if (e.penalty?.accepted) {
      const pt = team[e.penalty.on === 'off' ? e.offense : e.offense === 'home' ? 'away' : 'home'];
      pt.penalties++;
      pt.penaltyYards += Math.abs(e.yards) || e.penalty.yards;
    }
    if (e.firstDown) t.firstDowns++;
    const o = e.outcome;
    if (!o || e.kind === '2pt' || e.kind === 'penalty') continue;
    t.plays++;
    if (e.down === 3) {
      t.thirdAtt++;
      if (e.firstDown || e.touchdown) t.thirdConv++;
    }
    if (e.down === 4) {
      t.fourthAtt++;
      if (e.firstDown || e.touchdown) t.fourthConv++;
    }
    if (o.fumbleLost) t.fumblesLost++;
    const td = !!e.touchdown && e.points?.side === e.offense;
    if (o.type === 'run' || o.type === 'scramble') {
      t.rushAtt++;
      t.rushYards += o.yards;
      t.totalYards += o.yards;
      if (td) t.rushTD++;
      const c = o.carrier ?? o.passer;
      if (c) {
        const l = line(c, e.offense);
        l.rushAtt++;
        l.rushYds += o.yards;
        if (td) l.rushTD++;
      }
    } else if (o.type === 'sack') {
      t.sacks++;
      t.passYards += o.yards;
      t.totalYards += o.yards;
    } else if (o.type === 'pass') {
      t.att++;
      if (o.passer) {
        const l = line(o.passer, e.offense);
        l.passAtt++;
        if (o.complete) {
          l.passComp++;
          l.passYds += o.yards;
          if (td) l.passTD++;
        }
        if (o.intercepted) l.passInt++;
      }
      if (o.target) {
        const l = line(o.target, e.offense);
        l.targets++;
        if (o.complete) {
          l.rec++;
          l.recYds += o.yards;
          if (td) l.recTD++;
        }
      }
      if (o.intercepted) t.ints++;
      if (o.complete) {
        t.comp++;
        t.passYards += o.yards;
        t.totalYards += o.yards;
        if (td) t.passTD++;
      }
    }
  }
  team.home.points = g.sides.home.score;
  team.away.points = g.sides.away.score;
  return { team, players: [...lines.values()], scoring, byQuarter };
}

export function playerSummary(l: PlayerLine): string {
  const parts: string[] = [];
  if (l.passAtt) parts.push(`${l.passComp}/${l.passAtt}, ${l.passYds} yds, ${l.passTD} TD, ${l.passInt} INT`);
  if (l.rushAtt) parts.push(`${l.rushAtt} car, ${l.rushYds} yds${l.rushTD ? `, ${l.rushTD} TD` : ''}`);
  if (l.rec) parts.push(`${l.rec} rec, ${l.recYds} yds${l.recTD ? `, ${l.recTD} TD` : ''}`);
  return `${shortName(l.player)}: ${parts.join('; ')}`;
}
