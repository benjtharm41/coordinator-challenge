// The playbook: formations, concepts, defensive fronts, coverages, pressures.
import type { Concept, Coverage, Formation, Front, PassConcept, Pressure, RunConcept } from './types';

export interface FormationDef {
  id: Formation;
  name: string;
  personnel: string;
  wr: number;
  te: number;
  rb: number;
  fb: number;
  shotgun: boolean;
  /** Blockers available for the run game (OL + TE + FB). */
  blockers: number;
  concepts: Concept[];
}

export const FORMATIONS: Record<Formation, FormationDef> = {
  singleback: {
    id: 'singleback', name: 'Singleback', personnel: '12', wr: 2, te: 2, rb: 1, fb: 0, shotgun: false, blockers: 7,
    concepts: ['inside_zone', 'outside_zone', 'power', 'counter', 'duo', 'draw', 'toss', 'qb_sneak',
      'slant_flat', 'stick', 'mesh', 'smash', 'flood', 'curl_flat', 'dagger', 'y_cross', 'rb_screen', 'pa_shot'],
  },
  iform: {
    id: 'iform', name: 'I-Form', personnel: '21', wr: 2, te: 1, rb: 1, fb: 1, shotgun: false, blockers: 7,
    concepts: ['inside_zone', 'outside_zone', 'power', 'counter', 'duo', 'draw', 'toss', 'qb_sneak',
      'slant_flat', 'smash', 'flood', 'curl_flat', 'y_cross', 'rb_screen', 'pa_shot'],
  },
  shotgun: {
    id: 'shotgun', name: 'Shotgun', personnel: '11', wr: 3, te: 1, rb: 1, fb: 0, shotgun: true, blockers: 6,
    concepts: ['inside_zone', 'counter', 'draw', 'rpo',
      'slant_flat', 'stick', 'mesh', 'smash', 'flood', 'four_verts', 'curl_flat', 'dagger', 'y_cross',
      'rb_screen', 'wr_screen', 'pa_shot', 'hail_mary'],
  },
  pistol: {
    id: 'pistol', name: 'Pistol', personnel: '11', wr: 3, te: 1, rb: 1, fb: 0, shotgun: true, blockers: 6,
    concepts: ['inside_zone', 'outside_zone', 'power', 'counter', 'draw', 'rpo',
      'slant_flat', 'stick', 'flood', 'curl_flat', 'dagger', 'y_cross', 'rb_screen', 'pa_shot'],
  },
  empty: {
    id: 'empty', name: 'Empty', personnel: '10', wr: 4, te: 1, rb: 0, fb: 0, shotgun: true, blockers: 5,
    concepts: ['draw', 'slant_flat', 'stick', 'mesh', 'smash', 'four_verts', 'dagger', 'y_cross', 'wr_screen', 'hail_mary'],
  },
  trips: {
    id: 'trips', name: 'Trips', personnel: '11', wr: 3, te: 1, rb: 1, fb: 0, shotgun: true, blockers: 6,
    concepts: ['inside_zone', 'outside_zone', 'draw', 'rpo',
      'slant_flat', 'stick', 'mesh', 'smash', 'flood', 'four_verts', 'curl_flat', 'dagger', 'y_cross',
      'rb_screen', 'wr_screen', 'hail_mary'],
  },
  bunch: {
    id: 'bunch', name: 'Bunch', personnel: '11', wr: 3, te: 1, rb: 1, fb: 0, shotgun: true, blockers: 6,
    concepts: ['inside_zone', 'outside_zone', 'counter', 'stick', 'mesh', 'smash', 'flood', 'curl_flat', 'dagger', 'wr_screen'],
  },
  heavy: {
    id: 'heavy', name: 'Heavy / Jumbo', personnel: '13', wr: 1, te: 3, rb: 1, fb: 0, shotgun: false, blockers: 8,
    concepts: ['inside_zone', 'outside_zone', 'power', 'counter', 'duo', 'toss', 'qb_sneak', 'flood', 'curl_flat', 'pa_shot'],
  },
  goalline: {
    id: 'goalline', name: 'Goal Line', personnel: '23', wr: 0, te: 3, rb: 1, fb: 1, shotgun: false, blockers: 9,
    concepts: ['inside_zone', 'power', 'duo', 'toss', 'qb_sneak', 'flood', 'pa_shot'],
  },
};

export type Slot = 'WR1' | 'WR2' | 'WR3' | 'TE' | 'RB';

export interface RouteTarget {
  slot: Slot;
  route: string;
  depth: number;
  weight: number;
  /** Chance a catch on this route ends out of bounds (stops the clock late). */
  oob: number;
}

export interface RunDef {
  /** Typical gain on a non-stuffed carry before a breakaway. */
  mean: number;
  sd: number;
  /** Base chance of a tackle at or behind the line. */
  stuff: number;
  /** Base chance of a breakaway run. */
  breakaway: number;
  oob: number;
  inside: boolean;
}

export interface PassDef {
  targets: RouteTarget[];
  drop: 'screen' | 'quick' | 'medium' | 'long';
  playAction?: boolean;
}

export interface ConceptDef {
  id: Concept;
  name: string;
  kind: 'run' | 'pass';
  blurb: string;
  run?: RunDef;
  pass?: PassDef;
}

const run = (id: RunConcept, name: string, blurb: string, r: RunDef): ConceptDef => ({ id, name, kind: 'run', blurb, run: r });
const pass = (id: PassConcept, name: string, blurb: string, p: PassDef): ConceptDef => ({ id, name, kind: 'pass', blurb, pass: p });
const t = (slot: Slot, route: string, depth: number, weight: number, oob = 0.05): RouteTarget => ({ slot, route, depth, weight, oob });

export const CONCEPTS: Record<Concept, ConceptDef> = {
  inside_zone: run('inside_zone', 'Inside Zone', 'Downhill zone run between the tackles.', { mean: 3.6, sd: 2.4, stuff: 0.165, breakaway: 0.085, oob: 0.03, inside: true }),
  outside_zone: run('outside_zone', 'Outside Zone', 'Stretch the front sideline-to-sideline, cut back.', { mean: 3.6, sd: 2.8, stuff: 0.19, breakaway: 0.105, oob: 0.14, inside: false }),
  power: run('power', 'Power', 'Pulling guard leads through the B-gap.', { mean: 3.7, sd: 2.3, stuff: 0.16, breakaway: 0.08, oob: 0.04, inside: true }),
  counter: run('counter', 'Counter', 'Misdirection with two pullers; boom or bust.', { mean: 3.8, sd: 2.9, stuff: 0.2, breakaway: 0.115, oob: 0.06, inside: true }),
  duo: run('duo', 'Duo', 'Double teams at the point, RB reads the linebacker.', { mean: 3.6, sd: 2.3, stuff: 0.16, breakaway: 0.08, oob: 0.03, inside: true }),
  draw: run('draw', 'Draw', 'Show pass, then hand off behind the rush.', { mean: 3.7, sd: 3.0, stuff: 0.18, breakaway: 0.1, oob: 0.03, inside: true }),
  toss: run('toss', 'Toss', 'Quick pitch to the edge.', { mean: 3.6, sd: 3.0, stuff: 0.22, breakaway: 0.12, oob: 0.2, inside: false }),
  qb_sneak: run('qb_sneak', 'QB Sneak', 'QB pushes behind the center for a yard.', { mean: 1.4, sd: 1.0, stuff: 0.13, breakaway: 0.01, oob: 0, inside: true }),
  rpo: run('rpo', 'RPO', 'Run-pass option: QB reads the box and hands off or throws quick.', { mean: 3.7, sd: 2.5, stuff: 0.16, breakaway: 0.09, oob: 0.04, inside: true }),

  slant_flat: pass('slant_flat', 'Slant-Flat', 'Quick slant with a flat route underneath.', {
    drop: 'quick', targets: [t('WR1', 'slant', 6, 0.4), t('RB', 'flat', 1, 0.25, 0.25), t('WR2', 'slant', 6, 0.35)],
  }),
  stick: pass('stick', 'Stick', 'TE sits at 6 yards, flat and fade outside.', {
    drop: 'quick', targets: [t('TE', 'stick', 6, 0.5), t('WR3', 'flat', 2, 0.3, 0.25), t('WR1', 'fade', 14, 0.2, 0.2)],
  }),
  mesh: pass('mesh', 'Mesh', 'Two shallow crossers rub past each other.', {
    drop: 'quick', targets: [t('WR3', 'shallow cross', 4, 0.35, 0.08), t('TE', 'shallow cross', 4, 0.3, 0.08), t('WR1', 'corner', 13, 0.15, 0.3), t('RB', 'wheel', 6, 0.2, 0.3)],
  }),
  smash: pass('smash', 'Smash', 'Hitch underneath, corner route over the top.', {
    drop: 'medium', targets: [t('WR1', 'hitch', 5, 0.4, 0.1), t('WR3', 'corner', 15, 0.4, 0.4), t('TE', 'seam', 11, 0.2)],
  }),
  flood: pass('flood', 'Flood', 'Three levels to one sideline: go, out, flat.', {
    drop: 'medium', targets: [t('WR2', 'sail', 13, 0.4, 0.35), t('TE', 'flat', 3, 0.4, 0.3), t('WR1', 'go', 20, 0.2, 0.2)],
  }),
  four_verts: pass('four_verts', 'Four Verticals', 'Four receivers stretch the defense deep.', {
    drop: 'long', targets: [t('WR3', 'seam', 16, 0.3), t('WR1', 'go', 22, 0.22, 0.15), t('WR2', 'go', 20, 0.18, 0.15), t('RB', 'checkdown', 3, 0.3)],
  }),
  curl_flat: pass('curl_flat', 'Curl-Flat', 'Outside curl at 10 with a flat route underneath.', {
    drop: 'medium', targets: [t('WR1', 'curl', 10, 0.5, 0.06), t('RB', 'flat', 2, 0.3, 0.3), t('TE', 'hook', 8, 0.2)],
  }),
  dagger: pass('dagger', 'Dagger', 'Seam clears the middle for a deep dig.', {
    drop: 'long', targets: [t('WR1', 'dig', 14, 0.45), t('WR3', 'seam', 18, 0.25), t('RB', 'checkdown', 3, 0.3)],
  }),
  y_cross: pass('y_cross', 'Y-Cross', 'TE runs a deep crossing route across the field.', {
    drop: 'medium', targets: [t('TE', 'deep cross', 12, 0.45, 0.15), t('WR1', 'post', 18, 0.2), t('RB', 'flat', 2, 0.3, 0.3)],
  }),
  rb_screen: pass('rb_screen', 'RB Screen', 'Let the rush in, dump it to the back behind linemen.', {
    drop: 'screen', targets: [t('RB', 'screen', -2, 1, 0.12)],
  }),
  wr_screen: pass('wr_screen', 'WR Screen', 'Quick throw to a receiver behind blockers.', {
    drop: 'screen', targets: [t('WR3', 'bubble screen', -1, 0.6, 0.2), t('WR1', 'tunnel screen', 0, 0.4, 0.1)],
  }),
  pa_shot: pass('pa_shot', 'Play-Action Shot', 'Fake the run, take a deep shot.', {
    drop: 'long', playAction: true, targets: [t('WR1', 'post', 21, 0.45), t('WR2', 'deep over', 16, 0.3), t('TE', 'leak', 4, 0.25, 0.2)],
  }),
  hail_mary: pass('hail_mary', 'Hail Mary', 'Everyone to the end zone. Last play only.', {
    drop: 'long', targets: [t('WR1', 'hail mary', 45, 0.4), t('WR2', 'hail mary', 45, 0.35), t('WR3', 'hail mary', 45, 0.25)],
  }),
};

export interface FrontDef {
  id: Front;
  name: string;
  dl: number;
  lb: number;
  db: number;
  /** Defenders in the box before safeties roll down. */
  box: number;
}

export const FRONTS: Record<Front, FrontDef> = {
  '43': { id: '43', name: '4-3 Base', dl: 4, lb: 3, db: 4, box: 7 },
  '34': { id: '34', name: '3-4 Base', dl: 3, lb: 4, db: 4, box: 7 },
  nickel: { id: 'nickel', name: 'Nickel', dl: 4, lb: 2, db: 5, box: 6 },
  dime: { id: 'dime', name: 'Dime', dl: 4, lb: 1, db: 6, box: 5 },
  goalline: { id: 'goalline', name: 'Goal Line', dl: 5, lb: 3, db: 3, box: 9 },
};

export interface CoverageDef {
  id: Coverage;
  name: string;
  man: boolean;
  /** Safeties deep: 0, 1 or 2 (single-high puts an extra defender in the box). */
  deep: number;
  blurb: string;
}

export const COVERAGES: Record<Coverage, CoverageDef> = {
  c0: { id: 'c0', name: 'Cover 0', man: true, deep: 0, blurb: 'All-out man, no deep help. Must blitz.' },
  c1: { id: 'c1', name: 'Cover 1', man: true, deep: 1, blurb: 'Man coverage with one deep safety.' },
  c2: { id: 'c2', name: 'Cover 2', man: false, deep: 2, blurb: 'Two deep safeties, five underneath zones.' },
  c2m: { id: 'c2m', name: 'Cover 2-Man', man: true, deep: 2, blurb: 'Tight man underneath, two deep safeties.' },
  c3: { id: 'c3', name: 'Cover 3', man: false, deep: 1, blurb: 'Three deep, four underneath. Safety in the box.' },
  c4: { id: 'c4', name: 'Cover 4', man: false, deep: 2, blurb: 'Quarters: four deep defenders take away shots.' },
  c6: { id: 'c6', name: 'Cover 6', man: false, deep: 2, blurb: 'Quarters to one side, Cover 2 to the other.' },
};

export interface PressureDef {
  id: Pressure;
  name: string;
  rushers: number;
  blurb: string;
}

export const PRESSURES: Record<Pressure, PressureDef> = {
  base: { id: 'base', name: 'Base Rush', rushers: 4, blurb: 'Rush four, drop seven.' },
  lb_blitz: { id: 'lb_blitz', name: 'LB Blitz', rushers: 5, blurb: 'Send a linebacker through the A-gap.' },
  db_blitz: { id: 'db_blitz', name: 'DB Blitz', rushers: 5, blurb: 'Slot corner or safety off the edge.' },
  zone_blitz: { id: 'zone_blitz', name: 'Zone Blitz', rushers: 5, blurb: 'Five rush, a lineman drops into a passing lane.' },
  all_out: { id: 'all_out', name: 'All-Out Blitz', rushers: 7, blurb: 'Send everyone. Huge risk, huge reward.' },
};

/** Which pressures are allowed with a coverage. */
export function pressuresFor(coverage: Coverage): Pressure[] {
  switch (coverage) {
    case 'c0':
      return ['lb_blitz', 'db_blitz', 'all_out'];
    case 'c1':
      return ['base', 'lb_blitz', 'db_blitz', 'all_out'];
    case 'c3':
    case 'c2':
    case 'c4':
      return ['base', 'lb_blitz', 'db_blitz', 'zone_blitz'];
    default:
      return ['base', 'lb_blitz', 'db_blitz'];
  }
}

export const isValidDefCall = (c: { coverage: Coverage; pressure: Pressure }) => pressuresFor(c.coverage).includes(c.pressure);

export const conceptsFor = (f: Formation): Concept[] => FORMATIONS[f].concepts;
