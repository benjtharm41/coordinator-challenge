// A "scene" is one snap's worth of lined-up players plus the shapes of both calls.
import { CONCEPTS } from '../engine/playbook';
import { buildLineup } from '../engine/ratings';
import type { DefCall, DepthChart, OffCall, Player, Team } from '../engine/types';
import {
  defenseLayout, dropDepth, offenseLayout, passRoutes, runShape, type Assign, type DefRole, type OffSlot, type OffSpot, type Pt, type RouteSpec, type RunSpec,
} from './geometry';

export interface OffDot {
  id: string;
  slot: OffSlot;
  x: number;
  y: number;
  num: number;
  player: Player;
}

export interface DefDot {
  id: string;
  role: DefRole;
  x: number;
  y: number;
  num: number;
  player: Player;
  assign: Assign;
}

export interface Scene {
  offTeam: Team;
  defTeam: Team;
  offCall: OffCall;
  defCall: DefCall;
  off: OffDot[];
  def: DefDot[];
  routes: RouteSpec[];
  blockers: OffSlot[];
  run?: RunSpec;
  /** How far the QB drops (y, negative). */
  qbDrop: number;
}

const unavailable = (p: Player) => !!p.injury && /out|ir|doubtful/i.test(p.injury);

/** Players at a position, best first, skipping anyone who can't play. */
function bench(team: Team, key: keyof DepthChart): Player[] {
  const byId = new Map(team.players.map((p) => [p.id, p]));
  return team.depth[key].map((id) => byId.get(id)).filter((p): p is Player => !!p && !unavailable(p));
}

export function offensePlayers(team: Team, spots: OffSpot[]): OffDot[] {
  const l = buildLineup(team);
  const qbs = bench(team, 'QB');
  const wr = l.WR;
  const te = l.TE;
  const ol = l.OL;
  const pick = (slot: OffSlot): Player => {
    switch (slot) {
      case 'QB': return l.QB ?? qbs[0];
      case 'RB': return l.RB;
      case 'FB': return l.FB ?? l.RB2;
      case 'WR1': case 'WR2': case 'WR3': case 'WR4': return wr[Number(slot[2]) - 1] ?? wr[0];
      case 'TE1': case 'TE2': case 'TE3': return te[Number(slot[2]) - 1] ?? te[0] ?? wr[0];
      case 'LT': return ol[0]; case 'LG': return ol[1]; case 'C': return ol[2]; case 'RG': return ol[3]; case 'RT': return ol[4];
    }
  };
  return spots.map((s) => {
    const player = pick(s.slot) ?? team.players[0];
    return { id: `O-${s.slot}`, slot: s.slot, x: s.x, y: s.y, num: player.num, player };
  });
}

export function defensePlayers(team: Team, spots: ReturnType<typeof defenseLayout>): DefDot[] {
  const pools: Record<DefRole, Player[]> = {
    DL: bench(team, 'DL'), EDGE: bench(team, 'EDGE'), LB: bench(team, 'LB'), CB: bench(team, 'CB'), S: bench(team, 'S'),
  };
  const used = new Set<string>();
  const next = (role: DefRole): Player => {
    const order: DefRole[] = role === 'DL' ? ['DL', 'EDGE', 'LB'] : role === 'EDGE' ? ['EDGE', 'DL', 'LB'] : role === 'LB' ? ['LB', 'EDGE', 'S'] : role === 'CB' ? ['CB', 'S'] : ['S', 'CB'];
    for (const r of order) {
      const p = pools[r].find((x) => !used.has(x.id));
      if (p) {
        used.add(p.id);
        return p;
      }
    }
    return team.players[0];
  };
  return spots.map((s) => {
    const player = next(s.role);
    return { id: s.id, role: s.role, x: s.x, y: s.y, num: player.num, player, assign: s.assign };
  });
}

/** Mirror a scene left-to-right (used for variety). */
function mirror<T extends { x: number }>(xs: T[]): T[] {
  return xs.map((p) => ({ ...p, x: -p.x }));
}
const mirrorPts = (p: Pt[]): Pt[] => p.map((q) => ({ x: -q.x, y: q.y }));
const mirrorAssign = (a: Assign): Assign =>
  a.kind === 'rush' ? { ...a, target: { x: -a.target.x, y: a.target.y } } : a.kind === 'zone' ? { ...a, cx: -a.cx } : a;
const swapOL: Partial<Record<OffSlot, OffSlot>> = { LT: 'RT', RT: 'LT', LG: 'RG', RG: 'LG' };

export interface SceneOptions {
  /** Flip the strong side to the left. */
  flip?: boolean;
  /** Which way the run goes. */
  runDir?: 1 | -1;
}

export function buildScene(offTeam: Team, defTeam: Team, offCall: OffCall, defCall: DefCall, opts: SceneOptions = {}): Scene {
  const spots = offenseLayout(offCall.formation);
  const concept = CONCEPTS[offCall.concept];
  const isRun = concept.kind === 'run' && offCall.concept !== 'rpo';
  let routes: RouteSpec[] = [];
  let blockers: OffSlot[] = [];
  if (!isRun) {
    const r = passRoutes(offCall.concept, offCall.formation, spots);
    routes = r.routes;
    blockers = r.blockers;
  }
  const dir = opts.runDir ?? 1;
  const run = concept.kind === 'run' ? runShape(offCall.concept, offCall.formation, spots, dir) : undefined;
  const off = offensePlayers(offTeam, spots);
  const def = defensePlayers(defTeam, defenseLayout(defCall, spots));
  const scene: Scene = {
    offTeam, defTeam, offCall, defCall, off, def, routes, blockers, run,
    qbDrop: concept.kind === 'pass' ? dropDepth(offCall.concept, offCall.formation) : 0,
  };
  if (opts.flip) {
    scene.off = mirror(off).map((d) => {
      const slot = swapOL[d.slot] ?? d.slot;
      return { ...d, slot, id: `O-${slot}` };
    });
    scene.def = mirror(def).map((d) => ({ ...d, assign: mirrorAssign(d.assign) }));
    scene.routes = routes.map((r) => ({ ...r, path: mirrorPts(r.path) }));
    if (run) scene.run = { ...run, path: mirrorPts(run.path), pulls: run.pulls.map((p) => ({ slot: swapOL[p.slot] ?? p.slot, path: mirrorPts(p.path) })) };
  }
  return scene;
}
