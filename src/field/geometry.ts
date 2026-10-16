// Field geometry: where everyone lines up, and the shapes of routes, runs and coverages.
//
// Play coordinates: x is yards across the field (0 = middle, +x = screen right),
// y is yards from the line of scrimmage (0 = LOS, +y = toward the end zone the
// offense is attacking). The offense always moves "up" the screen.
import { COVERAGES, FORMATIONS, FRONTS, pressuresFor, receiverSlotFor, slotsIn, type ReceiverSlot } from '../engine/playbook';
import type { Concept, Coverage, DefCall, Formation, Front, Pressure } from '../engine/types';

export interface Pt {
  x: number;
  y: number;
}

export const HALF_W = 26.67;
export const FIELD_W = 53.33;

export type OffSlot = ReceiverSlot | 'QB' | 'LT' | 'LG' | 'C' | 'RG' | 'RT';
export type DefRole = 'DL' | 'EDGE' | 'LB' | 'CB' | 'S';

export interface OffSpot {
  slot: OffSlot;
  x: number;
  y: number;
}

const OL_SLOTS: [OffSlot, number][] = [['LT', -4.8], ['LG', -2.4], ['C', 0], ['RG', 2.4], ['RT', 4.8]];
export const isReceiverSlot = (s: OffSlot): s is ReceiverSlot => /^(WR|TE)\d$|^(RB|FB)$/.test(s);

/** Where the offense lines up. Strong side is to the right. */
export function offenseLayout(f: Formation): OffSpot[] {
  const form = FORMATIONS[f];
  const spots: OffSpot[] = OL_SLOTS.map(([slot, x]) => ({ slot, x, y: -0.6 }));
  const add = (slot: OffSlot, x: number, y: number) => spots.push({ slot, x, y });
  const gun = form.shotgun;
  const pistol = f === 'pistol';
  add('QB', 0, gun ? (pistol ? -3.6 : -5.2) : -1.4);

  switch (f) {
    case 'singleback':
      add('RB', 0, -6.8); add('TE1', 7.2, -0.6); add('TE2', -7.2, -0.6); add('WR1', -20, -0.4); add('WR2', 20, -0.4);
      break;
    case 'iform':
      add('FB', 0, -4.2); add('RB', 0, -7); add('TE1', 7.2, -0.6); add('WR1', -20, -0.4); add('WR2', 20, -0.4);
      break;
    case 'shotgun':
      add('RB', 2.9, -5.2); add('TE1', 7.2, -0.6); add('WR1', -20, -0.4); add('WR2', 20, -0.4); add('WR3', -11.5, -1.3);
      break;
    case 'pistol':
      add('RB', 0, -6.8); add('TE1', 7.2, -0.6); add('WR1', -20, -0.4); add('WR2', 20, -0.4); add('WR3', -11.5, -1.3);
      break;
    case 'empty':
      add('TE1', 7.2, -0.6); add('WR1', -20, -0.4); add('WR2', 20, -0.4); add('WR3', -11.5, -1.3); add('WR4', 12.5, -1.3);
      break;
    case 'trips':
      add('RB', -2.9, -5.2); add('TE1', -7.2, -0.6); add('WR1', 20, -0.4); add('WR2', 14.2, -1.3); add('WR3', 8.6, -1.3);
      break;
    case 'bunch':
      add('RB', -2.9, -5.2); add('TE1', -7.2, -0.6); add('WR1', 13, -0.4); add('WR2', 15.4, -1.6); add('WR3', 13, -2.8);
      break;
    case 'heavy':
      add('RB', 0, -6.8); add('TE1', 7.2, -0.6); add('TE2', -7.2, -0.6); add('TE3', 9.8, -1.8); add('WR1', -20, -0.4);
      break;
    case 'goalline':
      add('FB', 0, -3.4); add('RB', 0, -6); add('TE1', 7.2, -0.6); add('TE2', -7.2, -0.6); add('TE3', 9.8, -1.8);
      break;
  }
  return spots;
}

// ---------------------------------------------------------------- routes

/** Route shapes as offsets from the receiver's start. `depth` is the y (from the LOS) where the catch happens. */
export function routePath(name: string, start: Pt, depth: number): Pt[] {
  const inside = start.x > 0.5 ? -1 : start.x < -0.5 ? 1 : -1;
  const outside = -inside;
  const sx = start.x;
  const P = (dx: number, y: number): Pt => ({ x: clamp(sx + dx, -HALF_W + 1.5, HALF_W - 1.5), y });
  const y0 = start.y;
  const up = (f: number) => y0 + (depth - y0) * f;
  switch (name) {
    case 'slant': return [P(0, up(0.3)), P(inside * 4, depth)];
    case 'flat': return [P(outside * 3, Math.max(y0, 0) - 0.5), P(outside * 9, depth)];
    case 'fade': return [P(outside * 0.8, up(0.5)), P(outside * 2, depth)];
    case 'hitch': return [P(0, depth + 0.5), P(inside * 0.4, depth - 0.8)];
    case 'corner': return [P(0, up(0.62)), P(outside * 7, depth)];
    case 'seam': return [P(inside * 0.4, up(0.5)), P(inside * 1, depth)];
    case 'go': return [P(outside * 0.3, up(0.5)), P(outside * 0.6, depth)];
    case 'curl': return [P(0, depth + 2), P(inside * 1.2, depth)];
    case 'hook': return [P(0, depth + 1.2), P(0, depth)];
    case 'dig': return [P(0, depth), P(inside * 9, depth)];
    case 'post': return [P(0, up(0.6)), P(inside * 8, depth)];
    case 'out': return [P(0, depth), P(outside * 8, depth)];
    case 'sail': return [P(0, depth - 3), P(outside * 8, depth)];
    case 'stick': return [P(inside * 0.3, depth)];
    case 'leak': return [P(outside * 1, Math.max(0.5, y0 + 1)), P(outside * 7, depth)];
    case 'wheel': return [P(outside * 4, 0.8), P(outside * 8, 4), P(outside * 10, depth)];
    case 'checkdown': return [P(outside * 1.5, Math.max(depth - 1.5, y0 + 2)), P(outside * 2.5, depth)];
    case 'shallow cross': return [P(inside * 2, depth - 0.6), P(inside * 14, depth)];
    case 'deep cross': return [P(inside * 3, depth - 3), P(inside * 21, depth)];
    case 'deep over': return [P(0, depth - 4), P(inside * 12, depth)];
    case 'screen': return [P(outside * 4.5, y0 + 0.3), P(outside * 8.5, depth)];
    case 'bubble screen': return [P(outside * 1.5, depth)];
    case 'tunnel screen': return [P(inside * 2.5, depth)];
    case 'bubble': return [P(outside * 1.5, depth)];
    case 'hail mary': return [P(inside * 1.5, up(0.7)), P(inside * 2, depth)];
    default: return [P(0, depth)];
  }
}

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));

export interface RouteSpec {
  slot: OffSlot;
  route: string;
  depth: number;
  path: Pt[];
}

/** Routes for a pass concept in a formation. Receivers without a called route run a clear-out; backs and tight ends stay in to block. */
export function passRoutes(concept: Concept, formation: Formation, spots: OffSpot[]): { routes: RouteSpec[]; blockers: OffSlot[] } {
  const form = FORMATIONS[formation];
  const defn = CONCEPT_PASS_TARGETS(concept);
  const routes: RouteSpec[] = [];
  const used = new Set<OffSlot>();
  const at = (s: OffSlot) => spots.find((p) => p.slot === s);
  for (const t of defn) {
    const slot = receiverSlotFor(form, t.slot);
    const spot = at(slot);
    if (!spot || used.has(slot)) continue;
    used.add(slot);
    routes.push({ slot, route: t.route, depth: t.depth, path: [{ x: spot.x, y: spot.y }, ...routePath(t.route, spot, t.depth)] });
  }
  const blockers: OffSlot[] = [];
  for (const s of spots) {
    if (!isReceiverSlot(s.slot) || used.has(s.slot)) continue;
    if (s.slot.startsWith('WR')) {
      used.add(s.slot);
      routes.push({ slot: s.slot, route: 'clear', depth: 14, path: [{ x: s.x, y: s.y }, ...routePath('go', s, 14)] });
    } else blockers.push(s.slot);
  }
  return { routes, blockers };
}

import { CONCEPTS } from '../engine/playbook';
function CONCEPT_PASS_TARGETS(c: Concept) {
  const d = CONCEPTS[c];
  if (c === 'rpo') return [{ slot: 'WR1' as const, route: 'slant', depth: 5, weight: 1, oob: 0 }, { slot: 'WR3' as const, route: 'bubble', depth: -1, weight: 1, oob: 0 }];
  return d.pass?.targets ?? [];
}

/** How many yards the QB drops back from where he lines up (a positive number). */
export function dropDepth(concept: Concept, formation: Formation): number {
  const d = CONCEPTS[concept];
  const gun = FORMATIONS[formation].shotgun;
  const kind = d.pass?.drop ?? 'quick';
  const base = { screen: 0, quick: 0.5, medium: 1.5, long: 2.5 }[kind];
  return gun ? 0.3 + base * 0.8 : 2.4 + base * 1.8;
}

// ---------------------------------------------------------------- runs

export interface RunSpec {
  carrier: OffSlot;
  /** Ball handoff spot (x, y) and the path the carrier takes to (and past) the line. */
  path: Pt[];
  pitch?: boolean;
  /** Pulling linemen paths. */
  pulls: { slot: OffSlot; path: Pt[] }[];
}

/** Base running path (before the actual yardage is applied). `dir` is +1 (right) or -1 (left). */
export function runShape(concept: Concept, formation: Formation, spots: OffSpot[], dir: 1 | -1 = 1): RunSpec {
  const at = (s: OffSlot) => spots.find((p) => p.slot === s);
  const qb = at('QB')!;
  const rbSpot = at('RB') ?? at('FB') ?? qb;
  const carrierSlot: OffSlot = concept === 'qb_sneak' ? 'QB' : (at('RB') ? 'RB' : at('FB') ? 'FB' : 'QB');
  const start = concept === 'qb_sneak' ? qb : rbSpot;
  const sx = start.x;
  const S = (x: number, y: number): Pt => ({ x, y });
  void formation;
  switch (concept) {
    case 'inside_zone': return { carrier: carrierSlot, path: [S(sx, start.y), S(sx * 0.4 + dir * 1.2, -1.5), S(dir * 2.4, 0.5)], pulls: [] };
    case 'duo': return { carrier: carrierSlot, path: [S(sx, start.y), S(dir * 0.6, -1.5), S(dir * 1.2, 0.5)], pulls: [] };
    case 'draw': return { carrier: carrierSlot, path: [S(sx, start.y), S(sx + dir * 0.5, start.y + 0.6), S(dir * 2, -1), S(dir * 2.4, 0.5)], pulls: [] };
    case 'rpo': return { carrier: carrierSlot, path: [S(sx, start.y), S(dir * 1, -1.5), S(dir * 2, 0.5)], pulls: [] };
    case 'power':
      return { carrier: carrierSlot, path: [S(sx, start.y), S(dir * 2.4, -2.2), S(dir * 3.6, 0.5)], pulls: [{ slot: dir > 0 ? 'LG' : 'RG', path: [S(dir > 0 ? -2.4 : 2.4, -0.6), S(dir * 1, -1.6), S(dir * 4.2, 0.4)] }] };
    case 'counter': {
      const pulls: { slot: OffSlot; path: Pt[] }[] = [
        { slot: dir > 0 ? 'LG' : 'RG', path: [S(dir > 0 ? -2.4 : 2.4, -0.6), S(dir * 1.5, -2), S(dir * 4, 0.4)] },
        { slot: dir > 0 ? 'LT' : 'RT', path: [S(dir > 0 ? -4.8 : 4.8, -0.6), S(0, -2), S(dir * 3.6, 0.3)] },
      ];
      return { carrier: carrierSlot, path: [S(sx, start.y), S(-dir * 1.8, start.y + 0.2), S(dir * 1.5, -1.8), S(dir * 3.6, 0.5)], pulls };
    }
    case 'outside_zone': return { carrier: carrierSlot, path: [S(sx, start.y), S(dir * 5.5, -1.8), S(dir * 9, -0.8), S(dir * 10.5, 0.8)], pulls: [] };
    case 'toss': return { carrier: carrierSlot, pitch: true, path: [S(sx, start.y), S(dir * 6, -3.5), S(dir * 10, -1.4), S(dir * 11.5, 0.6)], pulls: [] };
    case 'qb_sneak': return { carrier: 'QB', path: [S(qb.x, qb.y), S(0, -0.2)], pulls: [] };
    default: return { carrier: carrierSlot, path: [S(sx, start.y), S(0, 0)], pulls: [] };
  }
}

// ---------------------------------------------------------------- defense

export type Assign =
  | { kind: 'rush'; target: Pt }
  | { kind: 'zone'; cx: number; cy: number; rx: number; ry: number; label: string; deep: boolean }
  | { kind: 'man'; recv: OffSlot }
  | { kind: 'spy' };

export interface DefSpot {
  id: string;
  role: DefRole;
  x: number;
  y: number;
  assign: Assign;
}

const frontSpots = (front: Front): { role: DefRole; x: number; y: number }[] => {
  switch (front) {
    case '43':
      return [{ role: 'EDGE', x: -6.9, y: 1.2 }, { role: 'DL', x: -1.6, y: 1 }, { role: 'DL', x: 1.6, y: 1 }, { role: 'EDGE', x: 6.9, y: 1.2 },
        { role: 'LB', x: -6.6, y: 4.6 }, { role: 'LB', x: 0, y: 4.6 }, { role: 'LB', x: 6.6, y: 4.6 }];
    case '34':
      return [{ role: 'DL', x: -4.8, y: 1 }, { role: 'DL', x: 0, y: 1 }, { role: 'DL', x: 4.8, y: 1 },
        { role: 'EDGE', x: -8.6, y: 1.6 }, { role: 'EDGE', x: 8.6, y: 1.6 }, { role: 'LB', x: -2.9, y: 4.4 }, { role: 'LB', x: 2.9, y: 4.4 }];
    case 'nickel':
      return [{ role: 'EDGE', x: -6.9, y: 1.2 }, { role: 'DL', x: -1.6, y: 1 }, { role: 'DL', x: 1.6, y: 1 }, { role: 'EDGE', x: 6.9, y: 1.2 },
        { role: 'LB', x: -3.2, y: 4.6 }, { role: 'LB', x: 3.2, y: 4.6 }];
    case 'dime':
      return [{ role: 'EDGE', x: -6.9, y: 1.2 }, { role: 'DL', x: -1.6, y: 1 }, { role: 'DL', x: 1.6, y: 1 }, { role: 'EDGE', x: 6.9, y: 1.2 }, { role: 'LB', x: 0, y: 4.6 }];
    case 'goalline':
      return [{ role: 'EDGE', x: -4.8, y: 0.9 }, { role: 'DL', x: -2.4, y: 0.9 }, { role: 'DL', x: 0, y: 0.9 }, { role: 'DL', x: 2.4, y: 0.9 }, { role: 'EDGE', x: 4.8, y: 0.9 },
        { role: 'LB', x: -3, y: 2.9 }, { role: 'LB', x: 0, y: 2.9 }, { role: 'LB', x: 3, y: 2.9 }];
  }
};

interface DeepZone { cx: number; cy: number; rx: number; ry: number; label: string; pref: 'CB' | 'S' }
interface ShortZone { cx: number; cy: number; rx: number; ry: number; label: string }

const coverageZones = (cov: Coverage): { deep: DeepZone[]; short: ShortZone[]; manShort: boolean } => {
  switch (cov) {
    case 'c0': return { deep: [], short: [], manShort: true };
    case 'c1': return { deep: [{ cx: 0, cy: 16, rx: 13, ry: 7, label: 'Deep middle', pref: 'S' }], short: [], manShort: true };
    case 'c2': return {
      deep: [{ cx: -13.3, cy: 16, rx: 13, ry: 7, label: 'Deep half', pref: 'S' }, { cx: 13.3, cy: 16, rx: 13, ry: 7, label: 'Deep half', pref: 'S' }],
      short: [{ cx: -20, cy: 6, rx: 6.5, ry: 4.5, label: 'Flat' }, { cx: -9, cy: 9, rx: 5.5, ry: 4 , label: 'Hook' }, { cx: 0, cy: 9, rx: 5.5, ry: 4, label: 'Hook' }, { cx: 9, cy: 9, rx: 5.5, ry: 4, label: 'Hook' }, { cx: 20, cy: 6, rx: 6.5, ry: 4.5, label: 'Flat' }],
      manShort: false,
    };
    case 'c2m': return {
      deep: [{ cx: -13.3, cy: 16, rx: 13, ry: 7, label: 'Deep half', pref: 'S' }, { cx: 13.3, cy: 16, rx: 13, ry: 7, label: 'Deep half', pref: 'S' }],
      short: [], manShort: true,
    };
    case 'c3': return {
      deep: [{ cx: -17.5, cy: 16, rx: 9, ry: 7, label: 'Deep third', pref: 'CB' }, { cx: 0, cy: 17, rx: 9, ry: 7, label: 'Deep third', pref: 'S' }, { cx: 17.5, cy: 16, rx: 9, ry: 7, label: 'Deep third', pref: 'CB' }],
      short: [{ cx: -14, cy: 7, rx: 7, ry: 4.5, label: 'Curl-flat' }, { cx: -4.5, cy: 9, rx: 5, ry: 4, label: 'Hook' }, { cx: 4.5, cy: 9, rx: 5, ry: 4, label: 'Hook' }, { cx: 14, cy: 7, rx: 7, ry: 4.5, label: 'Curl-flat' }],
      manShort: false,
    };
    case 'c4': return {
      deep: [{ cx: -20, cy: 15, rx: 6.5, ry: 7, label: 'Deep quarter', pref: 'CB' }, { cx: -6.7, cy: 16, rx: 6.5, ry: 7, label: 'Deep quarter', pref: 'S' }, { cx: 6.7, cy: 16, rx: 6.5, ry: 7, label: 'Deep quarter', pref: 'S' }, { cx: 20, cy: 15, rx: 6.5, ry: 7, label: 'Deep quarter', pref: 'CB' }],
      short: [{ cx: -8, cy: 8, rx: 5.5, ry: 4, label: 'Hook' }, { cx: 0, cy: 8, rx: 5.5, ry: 4, label: 'Hook' }, { cx: 8, cy: 8, rx: 5.5, ry: 4, label: 'Hook' }],
      manShort: false,
    };
    case 'c6': return {
      deep: [{ cx: -13.3, cy: 16, rx: 13, ry: 7, label: 'Deep half', pref: 'S' }, { cx: 8.5, cy: 16, rx: 6.5, ry: 7, label: 'Deep quarter', pref: 'S' }, { cx: 20, cy: 15, rx: 6.5, ry: 7, label: 'Deep quarter', pref: 'CB' }],
      short: [{ cx: -20, cy: 6, rx: 6.5, ry: 4.5, label: 'Flat' }, { cx: -7, cy: 9, rx: 5.5, ry: 4, label: 'Hook' }, { cx: 3, cy: 9, rx: 5.5, ry: 4, label: 'Hook' }],
      manShort: false,
    };
  }
};

/** Defensive alignment and assignments for a call against the offense's formation. */
export function defenseLayout(call: DefCall, offense: OffSpot[]): DefSpot[] {
  const cov = COVERAGES[call.coverage];
  const front = FRONTS[call.front];
  const covShape = coverageZones(call.coverage);
  const pressure = pressuresFor(call.coverage).includes(call.pressure) ? call.pressure : 'base';
  const man = cov.man;

  // 1. Linemen and linebackers.
  type D = { id: string; role: DefRole; x: number; y: number; assign?: Assign };
  const defs: D[] = frontSpots(call.front).map((s) => ({ ...s, id: '' }));

  // 2. Defensive backs, lined up over the receivers.
  const wrs = offense.filter((s) => s.slot.startsWith('WR')).sort((a, b) => a.x - b.x);
  const outside = [...wrs].sort((a, b) => Math.abs(b.x) - Math.abs(a.x));
  const nS = call.front === 'goalline' ? 1 : 2;
  const nCB = front.db - nS;
  const cbDepth = man && (call.coverage === 'c0' || call.coverage === 'c1' || call.coverage === 'c2m') ? 1.6 : call.coverage === 'c2' ? 5.6 : 6.4;
  const cbSpots: { x: number; y: number }[] = [];
  const leftW = wrs.filter((w) => w.x < -2);
  const rightW = wrs.filter((w) => w.x >= -2);
  const wide = (arr: Pt[], side: -1 | 1) => (arr.length ? (side < 0 ? arr[0] : arr[arr.length - 1]) : { x: side * 17, y: 0 });
  cbSpots.push({ x: wide(leftW, -1).x + 1, y: cbDepth });
  if (nCB >= 2) cbSpots.push({ x: wide(rightW, 1).x - 1, y: cbDepth });
  const slotRecv = outside.filter((w) => Math.abs(w.x) < 18);
  for (let i = 0; cbSpots.length < nCB; i++) {
    const w = slotRecv[i];
    cbSpots.push(w ? { x: w.x + (w.x > 0 ? -1.2 : 1.2), y: Math.max(3.2, cbDepth - 2.6) } : { x: i % 2 ? 9 : -9, y: 5 });
  }
  for (const c of cbSpots.slice(0, nCB)) defs.push({ id: '', role: 'CB', x: c.x, y: c.y });

  const safeties: { x: number; y: number }[] = [];
  switch (call.coverage) {
    case 'c0': safeties.push({ x: -5.5, y: 5.2 }, { x: 5.5, y: 5.2 }); break;
    case 'c1': safeties.push({ x: 0, y: 12.5 }, { x: 5.5, y: 5.6 }); break;
    case 'c2': case 'c2m': safeties.push({ x: -9.5, y: 11.5 }, { x: 9.5, y: 11.5 }); break;
    case 'c3': safeties.push({ x: 0, y: 12.5 }, { x: 8.5, y: 6.6 }); break;
    case 'c4': safeties.push({ x: -7.5, y: 9.6 }, { x: 7.5, y: 9.6 }); break;
    case 'c6': safeties.push({ x: -9, y: 11 }, { x: 8.5, y: 9.8 }); break;
  }
  for (const s of safeties.slice(0, nS)) defs.push({ id: '', role: 'S', x: s.x, y: s.y });
  defs.forEach((d, i) => (d.id = `D${i + 1}`));

  // 3. Rushers.
  const rushTarget: Pt = { x: 0, y: -4.5 };
  const rushers = new Set<string>();
  const line = defs.filter((d) => d.role === 'DL' || d.role === 'EDGE');
  const lbs = defs.filter((d) => d.role === 'LB').sort((a, b) => Math.abs(a.x) - Math.abs(b.x));
  const dbs = defs.filter((d) => d.role === 'CB' || d.role === 'S');
  line.forEach((d) => rushers.add(d.id));
  const rushAs = (d: D, pt: Pt = rushTarget) => {
    rushers.add(d.id);
    d.assign = { kind: 'rush', target: pt };
  };
  const dropper: D | undefined = pressure === 'zone_blitz' ? line.filter((d) => d.role === 'EDGE').sort((a, b) => b.x - a.x)[0] ?? line[line.length - 1] : undefined;
  if (dropper) {
    rushers.delete(dropper.id);
    dropper.assign = { kind: 'zone', cx: 6.5, cy: 6, rx: 5, ry: 3.6, label: 'Drop', deep: false };
  }
  if (pressure === 'lb_blitz' && lbs[0]) rushAs(lbs[0], { x: 0.8, y: -4.5 });
  if (pressure === 'zone_blitz') lbs.slice(-2).forEach((d, i) => rushAs(d, { x: i ? 2.5 : -2.5, y: -4.5 }));
  if (pressure === 'db_blitz') {
    const cb = defs.filter((d) => d.role === 'CB').sort((a, b) => Math.abs(a.x) - Math.abs(b.x))[0];
    const blitzer = (nCB > 2 ? cb : undefined) ?? dbs.filter((d) => d.role === 'S').sort((a, b) => b.x - a.x)[0] ?? dbs[0];
    if (blitzer) rushAs(blitzer, { x: (blitzer.x > 0 ? 1 : -1) * 2.2, y: -4.5 });
  }
  if (pressure === 'all_out') {
    lbs.forEach((d, i) => rushAs(d, { x: (i - 1) * 2.2, y: -4.5 }));
    const extra = dbs.filter((d) => !rushers.has(d.id)).sort((a, b) => Math.abs(a.x) - Math.abs(b.x));
    while (rushers.size < 7 && extra.length) {
      const d = extra.shift()!;
      rushAs(d, { x: d.x > 0 ? 2 : -2, y: -4.5 });
    }
  }
  for (const d of defs) if (rushers.has(d.id) && !d.assign) d.assign = { kind: 'rush', target: { x: Math.max(-3, Math.min(3, d.x * 0.35)), y: -4.5 } };

  // 4. Coverage for everyone not rushing.
  const free = defs.filter((d) => !d.assign);
  const takeClosest = (pred: (d: D) => boolean, x: number): D | undefined => {
    const c = free.filter(pred).sort((a, b) => Math.abs(a.x - x) - Math.abs(b.x - x))[0];
    if (c) free.splice(free.indexOf(c), 1);
    return c;
  };
  for (const z of covShape.deep) {
    const d = takeClosest((x) => x.role === z.pref, z.cx) ?? takeClosest((x) => x.role === 'CB' || x.role === 'S', z.cx);
    if (d) d.assign = { kind: 'zone', cx: z.cx, cy: z.cy, rx: z.rx, ry: z.ry, label: z.label, deep: true };
  }
  if (!covShape.manShort) {
    // Match remaining defenders to underneath zones, cornerbacks to the flats.
    const zones = [...covShape.short];
    const flats = zones.filter((z) => /flat/i.test(z.label));
    for (const z of flats) {
      const d = takeClosest((x) => x.role === 'CB', z.cx);
      if (d) {
        d.assign = { kind: 'zone', ...z, deep: false };
        zones.splice(zones.indexOf(z), 1);
      }
    }
    for (const z of zones) {
      const d = takeClosest(() => true, z.cx);
      if (d) d.assign = { kind: 'zone', ...z, deep: false };
    }
  }
  // Man coverage for the rest.
  const eligible = offense.filter((s) => isReceiverSlot(s.slot)).sort((a, b) => Math.abs(b.x) - Math.abs(a.x));
  const taken = new Set<string>();
  const order = [...free].sort((a, b) => (a.role === 'CB' ? 0 : a.role === 'S' ? 1 : 2) - (b.role === 'CB' ? 0 : b.role === 'S' ? 1 : 2) || Math.abs(b.x) - Math.abs(a.x));
  for (const d of order) {
    const pool = eligible.filter((r) => !taken.has(r.slot));
    const preferWR = d.role === 'CB' || d.role === 'S';
    const cand = pool.filter((r) => (preferWR ? r.slot.startsWith('WR') : !r.slot.startsWith('WR'))).concat(pool).sort((a, b) => Math.abs(a.x - d.x) - Math.abs(b.x - d.x));
    const pick = (preferWR ? pool.filter((r) => r.slot.startsWith('WR')) : pool.filter((r) => !r.slot.startsWith('WR'))).sort((a, b) => Math.abs(a.x - d.x) - Math.abs(b.x - d.x))[0] ?? cand[0];
    if (pick) {
      taken.add(pick.slot);
      d.assign = { kind: 'man', recv: pick.slot };
    } else d.assign = covShape.manShort || d.role === 'LB' ? { kind: 'spy' } : { kind: 'zone', cx: 0, cy: 7, rx: 5, ry: 3.6, label: 'Hook', deep: false };
  }
  return defs.map((d) => ({ id: d.id, role: d.role, x: d.x, y: d.y, assign: d.assign ?? { kind: 'spy' } }));
}

export { slotsIn };
export type { Pressure };
