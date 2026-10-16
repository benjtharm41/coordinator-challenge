// Picks and builds the right animation for each play-by-play entry.
import type { Game, PlayLog } from '../engine/game';
import type { DefCall, OffCall, Side } from '../engine/types';
import { other } from '../engine/types';
import { buildScrimmageAnim, type Anim } from './anim';
import { buildKickAnim, buildKickoffAnim, buildPuntAnim, buildQuietAnim } from './anim-special';
import { buildScene, type Scene } from './scene';

export interface Shot {
  anim: Anim;
  /** The team whose point of view the field is drawn from (offense moves up). */
  offense: Side;
  /** Line of scrimmage, in yards from the offense's own goal line. */
  losAbs: number;
  /** First-down line, same units (undefined when not relevant). */
  firstDownAbs?: number;
  /** The play this shot depicts. */
  entry: PlayLog;
  /** The lined-up scene (routes, zones) for scrimmage plays. */
  scene?: Scene;
}

export const DEFAULT_DEF: DefCall = { front: 'nickel', coverage: 'c3', pressure: 'base' };

export function hasAnimation(e: PlayLog): boolean {
  return ['run', 'pass', 'sack', 'scramble', '2pt', 'kickoff', 'punt', 'fg', 'xp', 'kneel', 'spike', 'penalty'].includes(e.kind);
}

export function shotFor(game: Game, entry: PlayLog): Shot | null {
  if (!hasAnimation(entry)) return null;
  const off = game.sides[entry.offense];
  const def = game.sides[other(entry.offense)];
  const losAbs = 100 - entry.yardline;
  const base = { offense: entry.offense, losAbs, entry } as const;
  const firstDownAbs = entry.down > 0 ? Math.min(100, losAbs + entry.distance) : undefined;

  switch (entry.kind) {
    case 'kickoff':
      return { ...base, anim: buildKickoffAnim(off.team, def.team, entry) };
    case 'punt':
      return { ...base, anim: buildPuntAnim(off.team, def.team, entry) };
    case 'fg':
      return { ...base, anim: buildKickAnim(off.team, def.team, entry, !!entry.points, /BLOCKED/.test(entry.text), entry.yardline) };
    case 'xp':
      return { ...base, anim: buildKickAnim(off.team, def.team, entry, !!entry.points, /BLOCKED/.test(entry.text), entry.yardline) };
    case 'kneel':
    case 'spike': {
      const call: OffCall = { formation: entry.kind === 'kneel' ? 'singleback' : 'shotgun', concept: 'inside_zone' };
      const scene = buildScene(off.team, def.team, call, DEFAULT_DEF);
      return { ...base, firstDownAbs, scene, anim: buildQuietAnim(scene, entry) };
    }
    case 'penalty': {
      const call = entry.offCall ?? { formation: 'shotgun', concept: 'slant_flat' };
      const scene = buildScene(off.team, def.team, call, entry.defCall ?? DEFAULT_DEF);
      return { ...base, firstDownAbs, scene, anim: buildQuietAnim(scene, entry) };
    }
    default: {
      if (!entry.outcome || !entry.offCall || !entry.defCall) return null;
      const scene = buildScene(off.team, def.team, entry.offCall, entry.defCall, { runDir: entry.id % 2 ? 1 : -1 });
      return { ...base, firstDownAbs, scene, anim: buildScrimmageAnim(scene, entry) };
    }
  }
}
