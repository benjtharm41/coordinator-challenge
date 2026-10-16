// Turns a depth chart into the unit ratings the resolver uses.
import type { Player, PlayerRatings, Team } from './types';

export interface Lineup {
  QB: Player;
  RB: Player;
  RB2: Player;
  FB?: Player;
  WR: Player[]; // WR1..WR4
  TE: Player[]; // TE1..TE2
  OL: Player[];
  DL: Player[]; // interior
  EDGE: Player[];
  LB: Player[];
  CB: Player[];
  S: Player[];
  K: Player;
  P: Player;
}

export interface UnitRatings {
  qbAcc: number;
  qbDeep: number;
  qbDec: number;
  qbPocket: number;
  qbMob: number;
  rbRush: number;
  passBlock: number;
  runBlock: number;
  passRush: number;
  runDef: number;
  coverage: number;
  ballSkills: number;
  tackling: number;
  kAcc: number;
  kLeg: number;
  pLeg: number;
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 65);
const get = (p: Player | undefined, k: keyof PlayerRatings, fallback = 60) => (p ? p.r[k] ?? p.ovr : fallback);
const healthy = (p: Player | undefined) => !!p && !(p.injury && /out|ir|doubtful/i.test(p.injury));

export function buildLineup(team: Team): Lineup {
  const byId = new Map(team.players.map((p) => [p.id, p]));
  const take = (ids: string[], n: number): Player[] => {
    const list = ids.map((id) => byId.get(id)).filter(healthy) as Player[];
    return list.slice(0, n);
  };
  const one = (ids: string[], backup?: string[]): Player => take(ids, 1)[0] ?? take(backup ?? [], 1)[0] ?? team.players[0];
  const rbs = take(team.depth.RB, 2);
  return {
    QB: one(team.depth.QB),
    RB: rbs[0] ?? one(team.depth.WR),
    RB2: rbs[1] ?? rbs[0] ?? one(team.depth.WR),
    FB: take(team.depth.FB, 1)[0],
    WR: take(team.depth.WR, 4),
    TE: take(team.depth.TE, 2),
    OL: take(team.depth.OL, 5),
    DL: take(team.depth.DL, 2),
    EDGE: take(team.depth.EDGE, 2),
    LB: take(team.depth.LB, 3),
    CB: take(team.depth.CB, 3),
    S: take(team.depth.S, 2),
    K: one(team.depth.K, team.depth.P),
    P: one(team.depth.P, team.depth.K),
  };
}

export function unitRatings(l: Lineup): UnitRatings {
  const ol = l.OL;
  const rushers = [...l.EDGE, ...l.DL];
  return {
    qbAcc: get(l.QB, 'acc'),
    qbDeep: get(l.QB, 'deep'),
    qbDec: get(l.QB, 'dec'),
    qbPocket: get(l.QB, 'pocket'),
    qbMob: get(l.QB, 'mob'),
    rbRush: get(l.RB, 'rush'),
    passBlock: avg(ol.map((p) => get(p, 'pblk'))),
    runBlock: avg([...ol.map((p) => get(p, 'rblk')), get(l.TE[0], 'rblk', 60) * 0.9 + 6]),
    // Edge rushers matter most for the pass rush.
    passRush: avg([...l.EDGE.map((p) => get(p, 'rush')), ...l.EDGE.map((p) => get(p, 'rush')), ...l.DL.map((p) => get(p, 'rush'))]),
    runDef: avg([...rushers.map((p) => get(p, 'run')), ...l.LB.map((p) => get(p, 'run'))]),
    coverage: avg([...l.CB.map((p) => get(p, 'cover')), ...l.CB.slice(0, 2).map((p) => get(p, 'cover')), ...l.S.map((p) => get(p, 'cover')), get(l.LB[0], 'cover')]),
    ballSkills: avg([...l.CB, ...l.S].map((p) => get(p, 'ball'))),
    tackling: avg([...l.LB, ...l.S].map((p) => get(p, 'run'))),
    kAcc: get(l.K, 'kacc'),
    kLeg: get(l.K, 'leg'),
    pLeg: get(l.P, 'leg'),
  };
}
