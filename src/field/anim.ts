// Turns an engine result into movement. The engine has already decided what
// happens; this only depicts it. Coordinates are relative to the line of
// scrimmage (y = 0), offense moving toward +y.
import type { PlayLog } from '../engine/game';
import type { Player } from '../engine/types';
import { CONCEPTS } from '../engine/playbook';
import { HALF_W, routePath, type Pt } from './geometry';
import type { DefDot, OffDot, Scene } from './scene';

export interface Key { t: number; x: number; y: number }

export interface Track {
  id: string;
  side: 'off' | 'def';
  num: number;
  role: string;
  name: string;
  keys: Key[];
}

export type BallSeg =
  | { t0: number; t1: number; kind: 'carried'; dot: string }
  | { t0: number; t1: number; kind: 'flight'; from: Pt; to: Pt; arc: number }
  | { t0: number; t1: number; kind: 'rest'; at: Pt };

export interface Marker {
  t: number;
  x: number;
  y: number;
  kind: 'flag' | 'pop';
}

export interface Anim {
  duration: number;
  tracks: Track[];
  ball: BallSeg[];
  markers: Marker[];
  /** Where the ball ends up (for the camera). */
  endBall: Pt;
  /** Extra things to draw: uprights etc. */
  uprights?: boolean;
}

// ---------------------------------------------------------------- helpers

export const SNAP = 0.5;
const SPEED = 7.4;

export function seeded(seed: number): () => number {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x297a2d39) >>> 0;
    return ((s ^ (s >>> 13)) >>> 0) / 4294967296;
  };
}

export const clampX = (x: number, margin = 1) => Math.max(-HALF_W + margin, Math.min(HALF_W - margin, x));
const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);

export class TB {
  keys: Key[];
  constructor(public id: string, x: number, y: number) {
    this.keys = [{ t: 0, x, y }];
  }
  get last(): Key {
    return this.keys[this.keys.length - 1];
  }
  hold(t: number) {
    if (t > this.last.t + 1e-4) this.keys.push({ t, x: this.last.x, y: this.last.y });
  }
  to(t: number, x: number, y: number) {
    this.keys.push({ t: Math.max(t, this.last.t + 0.02), x: clampX(x, 0.3), y });
  }
  /** Run through points at a speed, starting at t0 (waits in place until then). Returns the finish time. */
  path(t0: number, pts: Pt[], speed = SPEED): number {
    this.hold(t0);
    for (const p of pts) {
      const d = dist(this.last, p);
      this.to(this.last.t + Math.max(0.05, d / speed), p.x, p.y);
    }
    return this.last.t;
  }
  at(t: number): Pt {
    return posAt(this.keys, t);
  }
  /** Like path(), but speeds up so a long run never takes more than maxDur seconds. */
  quick(t0: number, pts: Pt[], speed = SPEED, maxDur = 6.5): number {
    let len = 0;
    let prev: Pt = this.last;
    for (const p of pts) {
      len += dist(prev, p);
      prev = p;
    }
    return this.path(t0, pts, Math.max(speed, len / maxDur));
  }
}

export function posAt(keys: Key[], t: number): Pt {
  if (t <= keys[0].t) return { x: keys[0].x, y: keys[0].y };
  const n = keys.length;
  if (t >= keys[n - 1].t) return { x: keys[n - 1].x, y: keys[n - 1].y };
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (keys[mid].t <= t) lo = mid;
    else hi = mid;
  }
  const a = keys[lo];
  const b = keys[hi];
  const u = (t - a.t) / (b.t - a.t);
  return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
}

export function ballAt(anim: Anim, t: number): { x: number; y: number; z: number } {
  const segs = anim.ball;
  let seg = segs[0];
  for (const s of segs) {
    if (t >= s.t0) seg = s;
    else break;
  }
  if (!seg) return { x: 0, y: 0, z: 0 };
  if (seg.kind === 'rest') return { ...seg.at, z: 0 };
  if (seg.kind === 'carried') {
    const tr = anim.tracks.find((k) => k.id === seg.dot);
    const p = tr ? posAt(tr.keys, t) : { x: 0, y: 0 };
    return { x: p.x + 0.35, y: p.y + 0.25, z: 0.3 };
  }
  const u = Math.max(0, Math.min(1, (t - seg.t0) / Math.max(0.01, seg.t1 - seg.t0)));
  return { x: seg.from.x + (seg.to.x - seg.from.x) * u, y: seg.from.y + (seg.to.y - seg.from.y) * u, z: 4 * seg.arc * u * (1 - u) + 0.3 };
}

export type Meta = Map<string, { side: 'off' | 'def'; num: number; role: string; name: string }>;

export function metaFromScene(scene: Scene): Meta {
  const meta: Meta = new Map();
  for (const d of scene.off) meta.set(d.id, { side: 'off', num: d.num, role: d.slot, name: d.player.name });
  for (const d of scene.def) meta.set(d.id, { side: 'def', num: d.num, role: d.role, name: d.player.name });
  return meta;
}

export function finishAnim(tracks: Map<string, TB>, meta: Meta, ball: BallSeg[], duration: number, endBall: Pt, extra: Partial<Anim> = {}): Anim {
  const out: Track[] = [];
  for (const [id, tb] of tracks) {
    const m = meta.get(id);
    out.push({ id, side: m?.side ?? 'off', num: m?.num ?? 0, role: m?.role ?? '', name: m?.name ?? '', keys: tb.keys });
  }
  return { duration, tracks: out, ball, markers: [], endBall, ...extra };
}


// ---------------------------------------------------------------- scrimmage plays

type D = DefDot;

function putPlayer(dot: { player: Player; num: number }, p: Player) {
  dot.player = p;
  dot.num = p.num;
}

/** The defender dot for a player, swapping them in for a similar player if they weren't lined up. */
function defenderDot(scene: Scene, p: Player | undefined, near: Pt): D | undefined {
  if (!p) return undefined;
  const found = scene.def.find((d) => d.player.id === p.id);
  if (found) return found;
  const role = p.pos === 'CB' || p.pos === 'S' ? ['CB', 'S'] : p.pos === 'LB' ? ['LB'] : ['DL', 'EDGE', 'LB'];
  const pool = scene.def.filter((d) => role.includes(d.role));
  const pick = (pool.length ? pool : scene.def).slice().sort((a, b) => dist(a, near) - dist(b, near))[0];
  if (pick) putPlayer(pick, p);
  return pick;
}

function offenseDot(scene: Scene, p: Player | undefined, slotHint?: string): OffDot | undefined {
  if (!p) return undefined;
  const found = scene.off.find((d) => d.player.id === p.id);
  if (found) return found;
  const pick = scene.off.find((d) => d.slot === slotHint) ?? scene.off.find((d) => /^(RB|FB)$/.test(d.slot)) ?? scene.off[0];
  putPlayer(pick, p);
  return pick;
}

export function buildScrimmageAnim(scene: Scene, entry: PlayLog): Anim {
  const o = entry.outcome!;
  const rnd = seeded(entry.id * 7919 + 13);
  const tracks = new Map<string, TB>();
  for (const d of scene.off) tracks.set(d.id, new TB(d.id, d.x, d.y));
  for (const d of scene.def) tracks.set(d.id, new TB(d.id, d.x, d.y));
  const T = (id: string) => tracks.get(id)!;
  const slot = (s: string) => scene.off.find((d) => d.slot === s);
  const qbDot = slot('QB')!;
  const center = slot('C')!;
  const gun = qbDot.y < -2.5;
  const ballSegs: BallSeg[] = [];
  const markers: Marker[] = [];
  const concept = CONCEPTS[scene.offCall.concept];
  const yardsToGoal = entry.yardline;
  const isPass = o.type === 'pass' || o.type === 'sack' || o.type === 'scramble' || (scene.offCall.concept === 'rpo' && o.rpo === 'pass');
  const dropKind = concept.pass?.drop ?? 'quick';
  const dropTime = { screen: 1.0, quick: 1.15, medium: 1.6, long: 2.0 }[dropKind];

  // Snap.
  ballSegs.push({ t0: 0, t1: SNAP, kind: 'carried', dot: center.id });
  if (gun) {
    ballSegs.push({ t0: SNAP, t1: SNAP + 0.3, kind: 'flight', from: { x: 0, y: center.y + 0.3 }, to: { x: qbDot.x, y: qbDot.y }, arc: 0.5 });
  }
  const qbHas = SNAP + (gun ? 0.3 : 0.08);

  // Offensive line sets (pass) or fires out (run).
  const blockers = scene.off.filter((d) => ['LT', 'LG', 'C', 'RG', 'RT'].includes(d.slot));
  const runDir: 1 | -1 = scene.run && scene.run.path.length ? (scene.run.path[scene.run.path.length - 1].x >= 0 ? 1 : -1) : 1;

  let tEnd = 2.5;
  let final: Pt = { x: 0, y: 0 };
  let tackler: D | undefined;
  let tCatch = 0;
  let throwT = 0;
  let catchPt: Pt = { x: 0, y: 0 };
  const carrierId: { id: string } = { id: qbDot.id };
  let defTouch: D | undefined; // defender who makes the play on the ball

  if (!isPass) {
    // ------------------------------------------------ run
    const run = scene.run!;
    const carrierDot = o.carrier ? offenseDot(scene, o.carrier, run.carrier) ?? slot(run.carrier)! : slot(run.carrier)!;
    carrierId.id = carrierDot.id;
    const base = run.path;
    const yards = o.yards;
    const sneak = scene.offCall.concept === 'qb_sneak';
    const pts: Pt[] = [];
    for (const p of base.slice(1)) if (p.y < yards - 0.4 && p.y <= 0.8) pts.push(p);
    const lastBase = base[base.length - 1];
    let fx = lastBase.x + (rnd() - 0.5) * (yards >= 10 ? 7 : 2.5);
    if (o.outOfBounds && yards > 3) fx = Math.sign(lastBase.x || runDir) * (HALF_W - 1.1);
    fx = clampX(fx, 1);
    if (yards >= 9) {
      const mid = { x: lastBase.x + (fx - lastBase.x) * 0.35, y: Math.max(1.5, yards * 0.45) };
      pts.push(mid);
    }
    final = { x: fx, y: yards };
    pts.push(final);
    const delay = scene.offCall.concept === 'draw' ? 0.9 : 0.15;
    const speed = sneak ? 3.5 : 6.6;
    const tRun0 = SNAP + delay;
    const tEndRun = T(carrierDot.id).quick(tRun0, pts, speed);
    tEnd = Math.max(tEndRun, SNAP + 1.05) + 0.1;

    // Handoff / pitch.
    if (sneak) {
      ballSegs.push({ t0: gun ? SNAP + 0.3 : SNAP, t1: tEnd + 5, kind: 'carried', dot: qbDot.id });
    } else {
      const tH = SNAP + (run.pitch ? 0.5 : gun ? 0.85 : 0.6);
      ballSegs.push({ t0: gun ? SNAP + 0.3 : SNAP, t1: tH, kind: 'carried', dot: qbDot.id });
      const toPos = T(carrierDot.id).at(tH + 0.12);
      ballSegs.push({ t0: tH, t1: tH + 0.12, kind: 'flight', from: T(qbDot.id).at(tH), to: toPos, arc: run.pitch ? 1.2 : 0.2 });
      ballSegs.push({ t0: tH + 0.12, t1: tEnd + 5, kind: 'carried', dot: carrierDot.id });
      if (!(qbDot.id === carrierDot.id)) T(qbDot.id).path(SNAP + 0.1, [{ x: qbDot.x - runDir * (gun ? 0.3 : 1), y: qbDot.y - (gun ? 0 : 0.8) }], 3);
    }
    // Line fires out; defenders engaged react to the result.
    const push = yards >= 3 ? 1.1 : yards <= 0 ? -0.8 : 0.3;
    for (const b of blockers) T(b.id).path(SNAP + 0.05, [{ x: b.x + runDir * 0.5, y: b.y + 1.1 }], 4);
    for (const pull of run.pulls) {
      const d = slot(pull.slot);
      if (d) T(d.id).path(SNAP + 0.05, pull.path.slice(1), 7);
    }
    for (const d of scene.def) {
      if (d.assign.kind === 'rush') T(d.id).path(SNAP + 0.1, [{ x: d.x + runDir * 0.4, y: d.y + push }], 4);
    }
    // Others block downfield.
    for (const d of scene.off) {
      if (/^(WR|TE)/.test(d.slot) && !blockers.includes(d)) {
        const tr = T(d.id);
        if (d.slot.startsWith('WR')) tr.path(SNAP + 0.2, [{ x: d.x + (d.x > 0 ? -1.2 : 1.2), y: Math.min(7, Math.max(2, yards * 0.5 + 2)) }], 5);
        else tr.path(SNAP + 0.1, [{ x: d.x + runDir * 1, y: d.y + 1 }], 4);
      }
    }
    tackler = defenderDot(scene, o.defender, final);
    defTouch = tackler;
    catchPt = final;
  } else {
    // ------------------------------------------------ pass
    const qbT = T(qbDot.id);
    const qbEnd = { x: gun ? 0 : 0.4, y: qbDot.y - scene.qbDrop };
    const dropEnd = qbT.path(qbHas, [qbEnd], 4.8);
    let tArrive = 0;
    for (const b of blockers) T(b.id).path(SNAP + 0.05, [{ x: b.x, y: b.y - 0.9 }], 4);
    // Receivers run their routes; the target's route ends where the ball was actually caught.
    const targetDot = o.target ? offenseDot(scene, o.target) : undefined;
    for (const r of scene.routes) {
      const dot = slot(r.slot);
      if (!dot) continue;
      const isTarget = targetDot && dot.id === targetDot.id;
      let pts = r.path.slice(1);
      if (isTarget && o.airYards !== undefined && o.route && o.type === 'pass') {
        pts = routePath(o.route, { x: dot.x, y: dot.y }, o.airYards);
      }
      const tFin = T(dot.id).path(SNAP + 0.12, pts, SPEED);
      if (isTarget) tArrive = tFin;
    }
    for (const s of scene.blockers) {
      const d = slot(s);
      if (!d) continue;
      if (targetDot && d.id === targetDot.id && o.type === 'pass') {
        const pts = routePath(o.route ?? 'flat', { x: d.x, y: d.y }, o.airYards ?? 3);
        tArrive = T(d.id).path(SNAP + 0.12, pts, SPEED);
      } else T(d.id).path(SNAP + 0.1, [{ x: d.x, y: d.y - 0.5 }], 3);
    }
    if (targetDot && !tArrive) {
      // Target wasn't in the route list (e.g. an RPO read): send them on a short route.
      const pts = routePath(o.route ?? 'slant', { x: targetDot.x, y: targetDot.y }, o.airYards ?? 5);
      tArrive = T(targetDot.id).path(SNAP + 0.12, pts, SPEED);
    }

    if (o.type === 'sack') {
      const sackSpot = { x: clampX(qbEnd.x + (rnd() - 0.5) * 2, 1), y: Math.min(o.yards, qbEnd.y + 0.5) };
      const tSack = Math.max(dropEnd + 0.15, SNAP + 1.7 + rnd() * 0.8);
      qbT.path(dropEnd, [sackSpot], 3);
      qbT.hold(tSack);
      ballSegs.push({ t0: SNAP + (gun ? 0.3 : 0), t1: tSack + 5, kind: 'carried', dot: qbDot.id });
      final = sackSpot;
      tEnd = tSack + 0.2;
      tackler = defenderDot(scene, o.defender, sackSpot);
      defTouch = tackler;
      carrierId.id = qbDot.id;
      catchPt = sackSpot;
      throwT = tSack;
    } else if (o.type === 'scramble') {
      const side = rnd() < 0.5 ? -1 : 1;
      const fx = clampX(qbEnd.x + side * (2 + rnd() * 6), 1);
      const yards = o.yards;
      const mid = { x: qbEnd.x + side * 1.5, y: Math.max(0.5, yards * 0.35) };
      const tScr = Math.max(dropEnd, SNAP + 1.5);
      const pts = yards > 1.5 ? [mid, { x: fx, y: yards }] : [{ x: fx, y: yards }];
      qbT.hold(tScr);
      tEnd = qbT.path(tScr, pts, 6.2) + 0.1;
      ballSegs.push({ t0: SNAP + (gun ? 0.3 : 0), t1: tEnd + 5, kind: 'carried', dot: qbDot.id });
      final = { x: fx, y: yards };
      tackler = defenderDot(scene, o.defender, final);
      defTouch = tackler;
      carrierId.id = qbDot.id;
      catchPt = final;
      throwT = tScr;
    } else {
      // A throw.
      const air = o.airYards ?? 5;
      const target = targetDot ?? slot('WR1')!;
      const tgtT = T(target.id);
      const cp = { x: tgtT.last.x, y: tgtT.last.y };
      catchPt = cp;
      const qbPos = { x: qbEnd.x, y: qbEnd.y };
      const flight = Math.max(0.4, dist(qbPos, cp) / 21);
      const minThrow = SNAP + dropTime;
      tCatch = Math.max(tArrive + 0.04, minThrow + flight);
      throwT = tCatch - flight;
      tgtT.hold(tCatch);
      ballSegs.push({ t0: SNAP + (gun ? 0.3 : 0), t1: throwT, kind: 'carried', dot: qbDot.id });
      ballSegs.push({ t0: throwT, t1: tCatch, kind: 'flight', from: qbPos, to: cp, arc: 1 + Math.min(10, Math.max(0, air) * 0.2) });
      void air;
      if (o.intercepted) {
        const dd = defenderDot(scene, o.defender, cp)!;
        tackler = dd;
        defTouch = dd;
        const dt = T(dd.id);
        // The defender breaks on the ball.
        const startPos = dt.last;
        dt.hold(Math.max(startPos.t, SNAP + 0.1));
        dt.to(tCatch, cp.x + 0.3, cp.y + 0.3);
        carrierId.id = dd.id;
        const ret = o.returnYards ?? 0;
        const goal = entry.touchdown && entry.points?.side !== entry.offense;
        final = o.touchback ? { x: cp.x, y: cp.y } : { x: clampX(cp.x + (rnd() - 0.5) * 8, 1), y: goal ? -(100 - yardsToGoal) : cp.y - ret };
        ballSegs.push({ t0: tCatch, t1: tCatch + 10, kind: 'carried', dot: dd.id });
        tEnd = o.touchback ? tCatch + 0.7 : dt.quick(tCatch, [final], 6.6) + 0.1;
        // Offense turns to chase; target stops.
        for (const d of scene.off) if (/^(WR|TE|RB)/.test(d.slot) && d.id !== target.id) T(d.id).path(tCatch, [{ x: (final.x + d.x) / 2, y: (final.y + d.y) / 2 }], 5);
      } else if (!o.complete) {
        defTouch = defenderDot(scene, o.defender, cp);
        tEnd = tCatch + 1.0;
        const land = { x: clampX(cp.x + (rnd() - 0.5) * 3, 1), y: cp.y + (rnd() - 0.4) * 2.2 };
        ballSegs.push({ t0: tCatch, t1: tCatch + 0.5, kind: 'flight', from: cp, to: land, arc: 0.6 });
        ballSegs.push({ t0: tCatch + 0.5, t1: tEnd + 5, kind: 'rest', at: land });
        final = land;
        carrierId.id = '';
      } else {
        // Caught: run after the catch.
        carrierId.id = target.id;
        const yards = o.yards;
        const goalLine = yards >= yardsToGoal;
        const yac = yards - cp.y;
        let fx = cp.x;
        if (o.outOfBounds) fx = (cp.x >= 0 ? 1 : -1) * (HALF_W - 1.2);
        else fx = clampX(cp.x + (rnd() - 0.5) * 3 * Math.min(1, yac / 6), 1);
        final = { x: fx, y: yards };
        ballSegs.push({ t0: tCatch, t1: tCatch + 10, kind: 'carried', dot: target.id });
        const pts: Pt[] = [];
        if (yac > 7) pts.push({ x: cp.x + (fx - cp.x) * 0.4, y: cp.y + yac * 0.45 });
        pts.push(final);
        tEnd = yac > 0.6 ? tgtT.quick(tCatch, pts, 6.6) + 0.1 : tCatch + 0.45;
        tackler = defenderDot(scene, o.defender, final);
        defTouch = goalLine ? undefined : tackler;
      }
    }
  }

  // ------------------------------------------------ defense
  const finalBall = { x: final.x, y: final.y };
  const carrierTrack = carrierId.id ? T(carrierId.id) : undefined;
  void carrierTrack;
  const isRunPlay = !isPass;
  for (const d of scene.def) {
    const tr = T(d.id);
    const a = d.assign;
    const isMain = defTouch && d.id === defTouch.id;
    if (a.kind === 'rush') {
      const blitz = d.role === 'LB' || d.role === 'CB' || d.role === 'S';
      if (isRunPlay) {
        // handled above for linemen; blitzers run to the ball
        if (blitz) tr.path(SNAP + 0.1, [{ x: d.x * 0.5, y: Math.max(-1, d.y - 3) }], 5);
      } else if (o.type === 'sack' && isMain) {
        tr.path(SNAP + 0.1, [{ x: (d.x + final.x) / 2, y: -1.2 }, { x: final.x + 0.5, y: final.y + 0.6 }], 6.5);
      } else {
        const f = blitz ? 0.62 : 0.4;
        const target = { x: d.x + (a.target.x - d.x) * f, y: d.y + (a.target.y - d.y) * f };
        const reach = o.type === 'sack' ? tEnd - 0.2 : Math.max(throwT, SNAP + 1.2);
        tr.path(SNAP + 0.1, [target], Math.max(1, dist(d, target) / Math.max(0.5, reach - SNAP - 0.1)));
      }
    } else if (a.kind === 'man') {
      const rec = scene.off.find((s) => s.slot === a.recv);
      if (!rec) continue;
      const rt = T(rec.id);
      const beaten = isPass && o.type === 'pass' && o.complete && o.target?.id === rec.player.id;
      const off = beaten ? 1.0 + Math.min(2.2, Math.max(0, (o.yac ?? 0) * 0.25)) : isPass ? 0.7 : 1.6;
      const until = isPass ? Math.max(tCatch, SNAP + 1.8) : SNAP + 1.0;
      for (let t = SNAP + 0.2; t <= until; t += 0.2) {
        const p = rt.at(t - 0.25);
        tr.to(t, p.x + (p.x > 0 ? -0.5 : 0.5), p.y - off);
      }
    } else if (a.kind === 'zone') {
      const reach = SNAP + 1.15;
      const z = { x: a.cx, y: a.cy };
      tr.path(SNAP + 0.12, [z], Math.max(1.5, dist(d, z) / (reach - SNAP - 0.12)));
      if (isPass && o.type !== 'sack' && o.type !== 'scramble') {
        const drift = { x: z.x + (catchPt.x - z.x) * 0.5, y: z.y + (catchPt.y - z.y) * 0.5 };
        tr.path(Math.max(throwT, tr.last.t), [drift], 4);
      }
    } else {
      tr.path(SNAP + 0.2, [{ x: d.x * 0.5, y: Math.max(4, d.y + 1) }], 3);
    }
    if (isMain && o.type !== 'sack') {
      const arriveBy = isPass && !o.complete && !o.intercepted ? tCatch : Math.max(tr.last.t, tEnd - 0.05);
      if (!(o.intercepted)) {
        tr.hold(Math.min(arriveBy, tEnd));
        tr.to(Math.min(Math.max(arriveBy, tr.last.t + 0.1), tEnd + 0.1), final.x + (final.x > 0 ? -0.6 : 0.6), final.y - 0.5);
      }
    }
  }

  // Everyone else closes in on the ball at the end.
  let rank = 0;
  for (const d of scene.def) {
    const tr = T(d.id);
    if (defTouch && d.id === defTouch.id) continue;
    if (o.type === 'pass' && o.intercepted) {
      const p = tr.last;
      const near = dist(p, finalBall) < 20;
      tr.path(Math.max(tr.last.t, tCatch), [near ? { x: finalBall.x + (rank % 2 ? 1.3 : -1.3), y: finalBall.y + 1 + rank * 0.1 } : { x: p.x, y: p.y }], 6);
      rank++;
      continue;
    }
    const p = tr.last;
    const dd = dist(p, finalBall);
    rank++;
    const ang = rank * 2.1;
    const rad = 0.9 + (rank % 4) * 0.5;
    const tgt = dd < 16 ? { x: finalBall.x + Math.cos(ang) * rad, y: finalBall.y + Math.sin(ang) * rad - 0.3 } : { x: p.x + (finalBall.x - p.x) * 0.3, y: p.y + (finalBall.y - p.y) * 0.3 };
    const t0 = Math.max(tr.last.t, isPass ? tCatch || tEnd - 0.8 : SNAP + 1.0);
    tr.hold(t0);
    tr.to(Math.max(tEnd, t0 + 0.2), tgt.x, tgt.y);
  }
  // Offense: blockers and others settle.
  for (const d of scene.off) {
    const tr = T(d.id);
    if (tr.last.t < tEnd) tr.hold(tEnd);
  }
  // A lost fumble: the ball pops loose and the defender falls on it.
  if (o.fumbleLost) {
    const to = { x: clampX(final.x + (rnd() - 0.5) * 3, 1), y: final.y + (rnd() - 0.2) * 1.5 };
    const last = ballSegs[ballSegs.length - 1];
    last.t1 = Math.min(last.t1, tEnd);
    ballSegs.push({ t0: tEnd, t1: tEnd + 0.45, kind: 'flight', from: final, to, arc: 0.9 });
    ballSegs.push({ t0: tEnd + 0.45, t1: tEnd + 10, kind: 'rest', at: to });
    markers.push({ t: tEnd, x: final.x, y: final.y, kind: 'pop' });
    tEnd += 0.5;
    if (defTouch) {
      const tr = T(defTouch.id);
      tr.to(tEnd, to.x, to.y);
    }
    final = to;
  }
  if (entry.penalty?.accepted && entry.kind !== 'penalty') markers.push({ t: tEnd + 0.1, x: 0, y: 0, kind: 'flag' });

  const duration = tEnd + 0.75;
  for (const tr of tracks.values()) tr.hold(duration);
  return finishAnim(tracks, metaFromScene(scene), ballSegs, duration, final, { markers });
}
