// Animations for kickoffs, punts, kicks, kneels, spikes and penalties.
import type { PlayLog } from '../engine/game';
import type { Player, Team } from '../engine/types';
import { clampX, finishAnim, seeded, SNAP, TB, type Anim, type BallSeg, type Marker, type Meta } from './anim';
import type { Pt } from './geometry';
import type { Scene } from './scene';
import { buildLineup } from '../engine/ratings';

/** A pool of players for special-teams units, skill players first. */
function units(team: Team, kicker: boolean): Player[] {
  const byId = new Map(team.players.map((p) => [p.id, p]));
  const take = (k: keyof Team['depth']) => team.depth[k].map((id) => byId.get(id)!).filter(Boolean);
  const order: Player[] = [];
  if (kicker) order.push(...take('K'));
  for (const k of ['CB', 'S', 'LB', 'WR', 'RB', 'TE', 'EDGE', 'DL', 'OL'] as const) order.push(...take(k).slice(k === 'OL' ? 0 : 0));
  const seen = new Set<string>();
  return order.filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)));
}

type Setup = { tracks: Map<string, TB>; meta: Meta };
function setup(): Setup {
  return { tracks: new Map(), meta: new Map() };
}
function addDot(s: Setup, id: string, side: 'off' | 'def', p: Player, role: string, x: number, y: number): TB {
  const tb = new TB(id, x, y);
  s.tracks.set(id, tb);
  s.meta.set(id, { side, num: p.num, role, name: p.name });
  return tb;
}

/** Offense = the kicking team. Positions are relative to where the ball is kicked or snapped. */
export function buildKickoffAnim(kicking: Team, receiving: Team, entry: PlayLog): Anim {
  const k = entry.kick!;
  const s = setup();
  const rnd = seeded(entry.id * 31 + 5);
  const kp = units(kicking, true);
  const rp = units(receiving, false);
  const kicker = kp[0];
  const balls: BallSeg[] = [];
  const kickerDot = addDot(s, 'O-K', 'off', kicker, 'K', 0, -0.6);
  const line: TB[] = [];
  for (let i = 0; i < 10; i++) {
    const x = -22 + (i + (i >= 5 ? 1 : 0)) * (44 / 10);
    line.push(addDot(s, `O-${i}`, 'off', kp[1 + i] ?? kicker, 'cov', x, -0.4 - (i % 2) * 0.3));
  }
  const retLine: TB[] = [];
  for (let i = 0; i < 5; i++) retLine.push(addDot(s, `D-${i}`, 'def', rp[2 + i] ?? rp[0], 'wedge', -16 + i * 8, 24 + (i % 2) * 1.2));
  for (let i = 0; i < 4; i++) retLine.push(addDot(s, `D-${5 + i}`, 'def', rp[7 + i] ?? rp[0], 'mid', -12 + i * 8, 38 + (i % 2) * 1.5));
  const catchY = Math.min(k.kickDistance, 62);
  const retA = addDot(s, 'D-R1', 'def', k.returner ?? rp[0], 'R', 3, catchY - 5);
  addDot(s, 'D-R2', 'def', rp[1] ?? rp[0], 'R', -4, catchY - 2);
  const flyT = 2.0;
  const t0 = 0.6;
  const catchT = t0 + flyT;
  const catchPt: Pt = k.touchback ? { x: 0, y: catchY + 6 } : { x: 3, y: catchY };
  // Kicker approaches and kicks; the line races downfield.
  kickerDot.path(0.2, [{ x: 0, y: 1 }], 5);
  balls.push({ t0: 0, t1: t0, kind: 'carried', dot: kickerDot.id });
  balls.push({ t0, t1: catchT, kind: 'flight', from: { x: 0, y: 0 }, to: catchPt, arc: 12 });
  line.forEach((l) => {
    const to = { x: l.last.x * 0.7 + (rnd() - 0.5) * 3, y: Math.min(catchY - 4, 38) };
    l.path(t0 - 0.2, [to], 9);
  });
  let final = catchPt;
  let end = catchT + 0.7;
  retA.path(0.5, [{ x: catchPt.x, y: catchPt.y - 0.5 }], 8);
  retA.hold(catchT);
  if (k.touchdown || (!k.touchback && !k.muffed && k.kickDistance > 0 && k.returnYards > 0)) {
    const finalY = k.touchdown ? -35 : (k.kickingTeamBall ? 100 - k.newYardline : k.newYardline) - 35;
    final = { x: clampX(catchPt.x + (rnd() - 0.5) * 12, 1), y: finalY };
    balls.push({ t0: catchT, t1: catchT + 12, kind: 'carried', dot: retA.id });
    const mid = { x: clampX(catchPt.x + (final.x - catchPt.x) * 0.4, 1), y: catchPt.y + (finalY - catchPt.y) * 0.5 };
    end = retA.quick(catchT, [mid, final], 7.4, 7) + 0.1;
    for (const l of line) {
      const near = { x: l.last.x + (final.x - l.last.x) * 0.7, y: Math.max(finalY + 3, Math.min(l.last.y, catchPt.y)) };
      l.path(l.last.t, [near], 7);
      l.hold(end);
      l.to(end, final.x + (rnd() - 0.5) * 3, final.y + 1 + rnd() * 2);
    }
  } else if (k.muffed) {
    balls.push({ t0: catchT, t1: catchT + 0.5, kind: 'flight', from: catchPt, to: { x: catchPt.x + 2, y: catchPt.y + 1.5 }, arc: 1 });
    balls.push({ t0: catchT + 0.5, t1: catchT + 12, kind: 'rest', at: { x: catchPt.x + 2, y: catchPt.y + 1.5 } });
    final = { x: catchPt.x + 2, y: catchPt.y + 1.5 };
  } else {
    balls.push({ t0: catchT, t1: catchT + 12, kind: 'carried', dot: retA.id });
    if (k.kickingTeamBall) final = { x: 0, y: k.newYardline ? 100 - k.newYardline - 35 : catchY };
  }
  const duration = end + 0.6;
  for (const t of s.tracks.values()) t.hold(duration);
  return finishAnim(s.tracks, s.meta, balls, duration, final);
}

export function buildPuntAnim(punting: Team, receiving: Team, entry: PlayLog): Anim {
  const k = entry.kick!;
  const s = setup();
  const rnd = seeded(entry.id * 17 + 3);
  const l = buildLineup(punting);
  const rp = units(receiving, false);
  const balls: BallSeg[] = [];
  const ol = l.OL;
  const punter = l.P;
  const spots: [string, Player, number, number][] = [
    ['LT', ol[0], -4.8, -0.6], ['LG', ol[1], -2.4, -0.6], ['C', ol[2], 0, -0.6], ['RG', ol[3], 2.4, -0.6], ['RT', ol[4], 4.8, -0.6],
    ['TE1', l.TE[0] ?? ol[0], 7.2, -0.6], ['TE2', l.TE[1] ?? l.TE[0] ?? ol[0], -7.2, -0.6], ['G1', l.WR[0], -21, -0.4], ['G2', l.WR[1] ?? l.WR[0], 21, -0.4],
    ['PP', l.RB, 0, -4], ['P', punter, 0, -14.5],
  ];
  for (const [slot, p, x, y] of spots) addDot(s, `O-${slot}`, 'off', p, slot, x, y);
  const landY = k.touchback ? 62 : Math.max(8, k.kickDistance);
  const retSpot = { x: 0, y: Math.min(landY + (k.fairCatch ? 0 : 6), 60) };
  for (let i = 0; i < 6; i++) addDot(s, `D-${i}`, 'def', rp[i + 2] ?? rp[0], 'rush', -9 + i * 3.6, 1.2);
  addDot(s, 'D-6', 'def', rp[8] ?? rp[0], 'wall', -20, 3);
  addDot(s, 'D-7', 'def', rp[9] ?? rp[0], 'wall', 20, 3);
  addDot(s, 'D-8', 'def', rp[10] ?? rp[0], 'wall', -8, 14);
  addDot(s, 'D-9', 'def', rp[11] ?? rp[0], 'wall', 8, 14);
  const retDot = addDot(s, 'D-R', 'def', k.returner ?? rp[0], 'R', retSpot.x, retSpot.y + 4);
  const snapT = 0.5;
  const kickT = 1.25;
  balls.push({ t0: 0, t1: snapT, kind: 'carried', dot: 'O-C' });
  balls.push({ t0: snapT, t1: kickT - 0.15, kind: 'flight', from: { x: 0, y: -0.2 }, to: { x: 0, y: -14 }, arc: 0.6 });
  balls.push({ t0: kickT - 0.15, t1: kickT, kind: 'carried', dot: 'O-P' });
  const hang = 2.6;
  const catchT = kickT + hang;
  let end = catchT + 0.6;
  let final: Pt = { x: 0, y: landY };
  if (k.blocked) {
    const to = { x: rnd() < 0.5 ? -6 : 6, y: 1 };
    balls.splice(2, 1);
    balls.push({ t0: kickT - 0.15, t1: kickT + 0.4, kind: 'flight', from: { x: 0, y: -14 }, to: { x: 0, y: -10 }, arc: 1 });
    balls.push({ t0: kickT + 0.4, t1: kickT + 0.9, kind: 'flight', from: { x: 0, y: -10 }, to, arc: 1 });
    balls.push({ t0: kickT + 0.9, t1: 99, kind: 'rest', at: to });
    end = kickT + 1.6;
    final = to;
    for (let i = 0; i < 6; i++) s.tracks.get(`D-${i}`)!.path(snapT + 0.1, [{ x: -9 + i * 3.6, y: -9 }], 8);
  } else {
    balls.push({ t0: kickT, t1: catchT, kind: 'flight', from: { x: 0, y: -14 }, to: { x: 0, y: landY }, arc: 14 });
    for (let i = 0; i < 6; i++) s.tracks.get(`D-${i}`)!.path(snapT + 0.1, [{ x: -9 + i * 3.6, y: -5 }], 6);
    for (const g of ['O-G1', 'O-G2']) s.tracks.get(g)!.path(snapT + 0.1, [{ x: s.tracks.get(g)!.last.x * 0.5, y: Math.min(landY - 3, 40) }], 9);
    retDot.path(0.4, [{ x: 0, y: Math.min(landY, 64) }], 7);
    retDot.hold(catchT);
    if (k.touchback) {
      balls.pop();
      balls.push({ t0: kickT, t1: catchT, kind: 'flight', from: { x: 0, y: -14 }, to: { x: 0, y: 66 }, arc: 14 });
      balls.push({ t0: catchT, t1: 99, kind: 'rest', at: { x: 0, y: 66 } });
      final = { x: 0, y: 66 };
    } else if (k.muffed) {
      balls.push({ t0: catchT, t1: catchT + 0.5, kind: 'flight', from: { x: 0, y: landY }, to: { x: 1.5, y: landY + 1.5 }, arc: 1 });
      balls.push({ t0: catchT + 0.5, t1: 99, kind: 'rest', at: { x: 1.5, y: landY + 1.5 } });
      final = { x: 1.5, y: landY + 1.5 };
    } else {
      balls.push({ t0: catchT, t1: 99, kind: 'carried', dot: 'D-R' });
      if (!k.fairCatch) {
        // Spot after the return, relative to the punting team's line of scrimmage.
        const spotRel = k.touchdown ? -(100 - entry.yardline) : k.newYardline - (100 - entry.yardline);
        final = { x: clampX((rnd() - 0.5) * 16, 1), y: spotRel };
        const mid = { x: clampX(final.x * 0.4, 1), y: landY + (spotRel - landY) * 0.5 };
        end = retDot.quick(catchT, [mid, final], 7.2, 7) + 0.1;
        for (let i = 0; i < 2; i++) {
          const g = s.tracks.get(`O-G${i + 1}`)!;
          g.hold(catchT - 0.1);
          g.to(end, final.x + (i ? 1.5 : -1.5), final.y + 1.2);
        }
      } else final = { x: 0, y: landY };
    }
  }
  const duration = end + 0.6;
  for (const t of s.tracks.values()) t.hold(duration);
  return finishAnim(s.tracks, s.meta, balls, duration, final);
}

export function buildKickAnim(kicking: Team, defending: Team, entry: PlayLog, good: boolean, blocked: boolean, yardsToGoal: number): Anim {
  const s = setup();
  const rnd = seeded(entry.id * 13 + 1);
  const l = buildLineup(kicking);
  const dp = units(defending, false);
  const balls: BallSeg[] = [];
  const ol = l.OL;
  const spots: [string, Player, number, number][] = [
    ['LT', ol[0], -4.8, -0.6], ['LG', ol[1], -2.4, -0.6], ['C', ol[2], 0, -0.6], ['RG', ol[3], 2.4, -0.6], ['RT', ol[4], 4.8, -0.6],
    ['TE1', l.TE[0] ?? ol[0], 7.2, -0.6], ['TE2', l.TE[1] ?? l.TE[0] ?? ol[0], -7.2, -0.6], ['W1', l.TE[2] ?? l.RB, 9.6, -1.8], ['W2', l.RB2, -9.6, -1.8],
    ['H', l.P, 0, -7], ['K', l.K, 2.4, -8.6],
  ];
  for (const [slot, p, x, y] of spots) addDot(s, `O-${slot}`, 'off', p, slot, x, y);
  for (let i = 0; i < 11; i++) addDot(s, `D-${i}`, 'def', dp[i + 1] ?? dp[0], 'rush', -13 + i * 2.6, 1.1);
  const snapT = 0.5;
  const kickT = 1.35;
  balls.push({ t0: 0, t1: snapT, kind: 'carried', dot: 'O-C' });
  balls.push({ t0: snapT, t1: snapT + 0.4, kind: 'flight', from: { x: 0, y: -0.2 }, to: { x: 0, y: -7 }, arc: 0.5 });
  balls.push({ t0: snapT + 0.4, t1: kickT, kind: 'carried', dot: 'O-H' });
  const kdot = s.tracks.get('O-K')!;
  kdot.path(snapT + 0.2, [{ x: 0.8, y: -7.8 }], 4);
  const endZoneY = yardsToGoal + 10;
  let end = kickT + 1.7;
  let final: Pt;
  if (blocked) {
    final = { x: (rnd() - 0.5) * 8, y: 2 + rnd() * 2 };
    balls.push({ t0: kickT, t1: kickT + 0.4, kind: 'flight', from: { x: 0, y: -7 }, to: { x: 0, y: 1.5 }, arc: 1 });
    balls.push({ t0: kickT + 0.4, t1: kickT + 0.9, kind: 'flight', from: { x: 0, y: 1.5 }, to: final, arc: 1 });
    balls.push({ t0: kickT + 0.9, t1: 99, kind: 'rest', at: final });
    s.tracks.get('D-5')!.path(snapT + 0.1, [{ x: 0, y: 1.2 }, { x: 0.5, y: 1.8 }], 6);
    end = kickT + 1.4;
  } else {
    const dx = good ? (rnd() - 0.5) * 1.6 : (rnd() < 0.5 ? -1 : 1) * (4.2 + rnd() * 2);
    const ey = good ? endZoneY + 2 : rnd() < 0.3 ? Math.max(8, yardsToGoal - 4 - rnd() * 6) : endZoneY + 0.5;
    final = { x: dx, y: ey };
    balls.push({ t0: kickT, t1: kickT + 1.6, kind: 'flight', from: { x: 0, y: -7 }, to: final, arc: 12 + Math.min(10, yardsToGoal * 0.12) });
    balls.push({ t0: kickT + 1.6, t1: 99, kind: 'rest', at: final });
    kdot.path(kickT - 0.3, [{ x: 0.2, y: -6.5 }], 4);
    for (let i = 0; i < 11; i++) s.tracks.get(`D-${i}`)!.path(snapT + 0.15, [{ x: -13 + i * 2.6 + (i < 5 ? 1 : -1), y: 0.3 }], 3);
  }
  const duration = end + 0.5;
  for (const t of s.tracks.values()) t.hold(duration);
  return finishAnim(s.tracks, s.meta, balls, duration, final, { uprights: !blocked });
}

/** Kneel, spike, or a flag with the formation on the field (no play). */
export function buildQuietAnim(scene: Scene, entry: PlayLog): Anim {
  const tracks = new Map<string, TB>();
  const meta: Meta = new Map();
  for (const d of scene.off) {
    tracks.set(d.id, new TB(d.id, d.x, d.y));
    meta.set(d.id, { side: 'off', num: d.num, role: d.slot, name: d.player.name });
  }
  for (const d of scene.def) {
    tracks.set(d.id, new TB(d.id, d.x, d.y));
    meta.set(d.id, { side: 'def', num: d.num, role: d.role, name: d.player.name });
  }
  const qb = scene.off.find((d) => d.slot === 'QB')!;
  const c = scene.off.find((d) => d.slot === 'C')!;
  const balls: BallSeg[] = [{ t0: 0, t1: SNAP, kind: 'carried', dot: c.id }];
  const markers: Marker[] = [];
  let end = 1.6;
  let final: Pt = { x: 0, y: qb.y };
  const gun = qb.y < -2.5;
  if (gun) balls.push({ t0: SNAP, t1: SNAP + 0.3, kind: 'flight', from: { x: 0, y: c.y }, to: { x: qb.x, y: qb.y }, arc: 0.4 });
  const has = SNAP + (gun ? 0.3 : 0.05);
  if (entry.kind === 'kneel') {
    balls.push({ t0: has, t1: 99, kind: 'carried', dot: qb.id });
    tracks.get(qb.id)!.path(has, [{ x: 0, y: qb.y - 0.9 }], 3);
    for (const d of scene.def) tracks.get(d.id)!.path(SNAP, [{ x: d.x, y: d.y + 0.3 }], 2);
    final = { x: 0, y: qb.y - 0.9 };
    end = has + 1.2;
  } else if (entry.kind === 'spike') {
    balls.push({ t0: has, t1: has + 0.35, kind: 'carried', dot: qb.id });
    const to = { x: 0.5, y: qb.y + 3.5 };
    balls.push({ t0: has + 0.35, t1: has + 0.65, kind: 'flight', from: { x: 0, y: qb.y }, to, arc: 1.4 });
    balls.push({ t0: has + 0.65, t1: 99, kind: 'rest', at: to });
    final = to;
    end = has + 1.2;
  } else {
    // Penalty: the flagged player jumps, then a flag is thrown.
    balls.push({ t0: SNAP, t1: 99, kind: 'carried', dot: c.id });
    const pen = entry.penalty;
    const jumper = pen?.on === 'off' ? scene.off.find((d) => d.player.id === pen.player?.id) ?? scene.off.find((d) => d.slot === 'LT') : scene.def.find((d) => d.player.id === pen?.player?.id) ?? scene.def[0];
    if (jumper) {
      const tr = tracks.get(jumper.id)!;
      tr.path(0.55, [{ x: jumper.x, y: jumper.y + (pen?.on === 'off' ? 0.9 : 1.2) }], 6);
      markers.push({ t: 0.9, x: jumper.x, y: jumper.y + 1, kind: 'flag' });
    } else markers.push({ t: 0.9, x: 0, y: 0, kind: 'flag' });
    final = { x: 0, y: 0 };
    end = 1.9;
  }
  const duration = end + 0.4;
  for (const t of tracks.values()) t.hold(duration);
  return finishAnim(tracks, meta, balls, duration, final, { markers });
}

