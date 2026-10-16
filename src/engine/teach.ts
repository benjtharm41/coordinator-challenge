// Plain-English teaching text: call descriptions and "why it worked / failed".
import { COVERAGE_MATRIX } from './matchup';
import { CONCEPTS, COVERAGES, FORMATIONS, FRONTS, PRESSURES } from './playbook';
import type { ScrimmageOutcome } from './resolve';
import type { Concept, Coverage, DefCall, Formation, Front, OffCall, Pressure } from './types';

const ALL_COVERAGES = Object.keys(COVERAGES) as Coverage[];
const ALL_CONCEPTS = Object.keys(CONCEPTS) as Concept[];

/** Plain-English definitions of the coverages, used in descriptions. */
export const COVERAGE_PLAIN: Record<Coverage, string> = {
  c0: 'every defender guards one receiver, nobody deep, everyone else blitzes',
  c1: 'man-to-man with one safety deep in the middle',
  c2: 'two safeties split the deep field, five defenders guard short zones',
  c2m: 'tight man-to-man underneath with two deep safeties behind',
  c3: 'three defenders split the deep field into thirds, four guard short zones',
  c4: 'four defenders each guard a deep quarter of the field',
  c6: 'half the field plays Cover 4, the other half plays Cover 2',
};

export const FRONT_PLAIN: Record<Front, string> = {
  '43': 'Four linemen, three linebackers, four defensive backs. Balanced and solid against the run.',
  '34': 'Three linemen, four linebackers, four defensive backs. Flexible, good at disguising blitzes.',
  nickel: 'A fifth defensive back replaces a linebacker. The standard answer to three receivers.',
  dime: 'Six defensive backs. Great against passes, weak against runs.',
  goalline: 'Extra linemen and linebackers packed in tight. Built to stop short runs.',
};

export const FORMATION_PLAIN: Record<Formation, string> = {
  singleback: 'QB under center, one running back behind him, two tight ends. Balanced: run or pass.',
  iform: 'A fullback lines up in front of the running back. Built for power running.',
  shotgun: 'QB stands 5 yards back. Easier to see the field and pass; the most common NFL formation.',
  pistol: 'QB 4 yards back with the running back right behind him. Good for running and play-action.',
  empty: 'No running back: five receivers spread out. Pure passing, but the QB has fewer blockers.',
  trips: 'Three receivers bunched on one side. Overloads that side of the defense.',
  bunch: 'Three receivers stacked close together. Creates traffic that frees receivers against man coverage.',
  heavy: 'Three tight ends and only one receiver. Lots of blockers for running.',
  goalline: 'Every big body on the field. Used at the 1-2 yard line to push the ball in.',
};

/** Very short formation tags for buttons. */
export const FORMATION_SHORT: Record<Formation, string> = {
  singleback: 'Balanced run or pass', iform: 'Power running', shotgun: 'Passing; most common', pistol: 'Runs + play-action',
  empty: '5 receivers, all pass', trips: '3 receivers one side', bunch: 'Beats man coverage', heavy: '3 tight ends, run', goalline: 'Push it in from the 1',
};

const covName = (c: Coverage) => COVERAGES[c].name;

/** Coverages a concept does best and worst against, from the advantage matrix. */
export function conceptMatchups(c: Concept): { strong: Coverage[]; weak: Coverage[] } {
  const row = COVERAGE_MATRIX[c];
  const sorted = [...ALL_COVERAGES].sort((a, b) => row[b] - row[a]);
  const strong = sorted.filter((k) => row[k] >= 0.5).slice(0, 2);
  const weak = sorted.filter((k) => row[k] <= -0.5).reverse().slice(0, 2);
  return { strong, weak };
}

/** Concepts that beat or struggle against a coverage. */
export function coverageMatchups(cov: Coverage): { beatenBy: Concept[]; stops: Concept[] } {
  const usable = ALL_CONCEPTS.filter((c) => c !== 'hail_mary' && c !== 'qb_sneak');
  const sorted = [...usable].sort((a, b) => COVERAGE_MATRIX[b][cov] - COVERAGE_MATRIX[a][cov]);
  return {
    beatenBy: sorted.filter((c) => COVERAGE_MATRIX[c][cov] >= 0.8).slice(0, 3),
    stops: sorted.filter((c) => COVERAGE_MATRIX[c][cov] <= -0.8).reverse().slice(0, 3),
  };
}

export function describeConcept(c: Concept): string {
  const def = CONCEPTS[c];
  const { strong, weak } = conceptMatchups(c);
  let s = `${def.name}: ${def.blurb}`;
  if (def.pass?.drop === 'screen' || c === 'draw') s += ' Great against blitzes.';
  if (def.pass?.drop === 'long') s += ' Slow to develop, so blitzes hurt it.';
  if (def.kind === 'run' && c !== 'qb_sneak') s += ' Best when the defense has few players near the line.';
  if (strong.length) s += ` Strong vs ${strong.map(covName).join(' and ')}.`;
  if (weak.length) s += ` Weak vs ${weak.map(covName).join(' and ')}.`;
  return s;
}

const conceptNames = (cs: Concept[]) => cs.map((c) => CONCEPTS[c].name).join(', ');

export function describeCoverage(c: Coverage): string {
  const { beatenBy, stops } = coverageMatchups(c);
  let s = `${covName(c)}: ${COVERAGE_PLAIN[c][0].toUpperCase()}${COVERAGE_PLAIN[c].slice(1)}.`;
  if (COVERAGES[c].deep <= 1) s += ' Puts an extra defender near the line to stop runs.';
  else s += ' Fewer defenders near the line, so runs can work.';
  if (stops.length) s += ` Strong vs ${conceptNames(stops)}.`;
  if (beatenBy.length) s += ` Beaten by ${conceptNames(beatenBy)}.`;
  return s;
}

export function describePressure(p: Pressure): string {
  const d = PRESSURES[p];
  const extra =
    p === 'base'
      ? ' Safe: more defenders in coverage, but the QB has time.'
      : p === 'all_out'
        ? ' Gets to the QB fast and stuffs runs, but one missed tackle can be a touchdown. Screens and quick passes punish it.'
        : p === 'zone_blitz'
          ? ' Confuses the QB and causes interceptions on quick throws.'
          : ' Hurries the QB and beats slow plays, but screens and quick passes punish it.';
  return `${d.name}: ${d.blurb}${extra}`;
}

export function describeFront(f: Front): string {
  return `${FRONTS[f].name}: ${FRONT_PLAIN[f]}`;
}

export function describeFormation(f: Formation): string {
  const d = FORMATIONS[f];
  return `${d.name} (${d.wr} WR, ${d.te} TE, ${d.rb + d.fb} RB): ${FORMATION_PLAIN[f]}`;
}

/** Short "why it worked / why it failed" based on the matchup and the result. */
export function explainPlay(out: ScrimmageOutcome, off: OffCall, def: DefCall, userOnOffense: boolean, down: number, distance: number): string {
  const m = out.matchup;
  const concept = CONCEPTS[off.concept];
  const cname = concept.name;
  const cov = covName(def.coverage);
  const good = out.type === 'sack' || out.intercepted || out.fumbleLost ? false : out.yards >= (down === 1 ? 0.4 * distance : down === 2 ? 0.6 * distance : distance);
  const reasons: { w: number; text: string }[] = [];
  const add = (w: number, text: string) => reasons.push({ w, text });

  const p = m.parts;
  if (Math.abs(p.coverage) >= 0.5) {
    add(Math.abs(p.coverage), p.coverage > 0
      ? `${cname} is designed to beat ${cov} (${COVERAGE_PLAIN[def.coverage]}).`
      : `${cov} is a good answer to ${cname}: it takes away what the play is trying to do.`);
  }
  if (Math.abs(p.pressure) >= 0.5) {
    const blitz = PRESSURES[def.pressure].name;
    if (def.pressure === 'base') {
      add(Math.abs(p.pressure), concept.pass?.drop === 'screen' ? 'No blitz came, so the screen had nobody to let through: screens work best against a blitz.' : 'The defense played it safe with a base rush.');
    } else {
      add(Math.abs(p.pressure), p.pressure > 0
        ? `The defense sent a ${blitz}, and ${cname} got the ball out before the rush arrived.`
        : `The defense sent a ${blitz}, and ${cname} took too long to develop.`);
    }
  }
  if (Math.abs(p.box) >= 0.5 && concept.kind === 'run') {
    add(Math.abs(p.box), p.box > 0
      ? `The defense had only ${m.box} players near the line against ${Math.floor(m.blockers)} blockers. A light box is good for running.`
      : `The defense packed ${m.box} players near the line against ${Math.floor(m.blockers)} blockers. Too many to run against.`);
  }
  if (Math.abs(p.personnel) >= 0.6 && concept.kind === 'pass') {
    add(Math.abs(p.personnel), p.personnel > 0
      ? `The offense's ${FORMATIONS[off.formation].wr}-receiver set forced bigger, slower defenders to cover receivers.`
      : `The offense's big formation let the defense put extra defensive backs on its few receivers.`);
  }
  if (Math.abs(p.situation) >= 0.5) {
    let t: string;
    if (concept.pass?.playAction) t = p.situation > 0 ? 'The defense expected a run, so the play-action fake froze them.' : `Nobody believes a run fake on ${ordinal(down)} & ${distance}, so the fake didn't fool anyone.`;
    else if (off.concept === 'qb_sneak') t = p.situation > 0 ? 'A QB sneak is the most reliable way to get 1 yard.' : 'A QB sneak only works when you need a yard or less.';
    else if (p.situation > 0) t = 'The defense was expecting a pass, which opened the door for this call.';
    else t = `Everyone knew a ${concept.kind} was coming on ${ordinal(down)} & ${distance}, so the defense sat on it.`;
    add(Math.abs(p.situation), t);
  }

  reasons.sort((a, b) => b.w - a.w);
  const top = reasons.slice(0, 2).map((r) => r.text);
  const callQuality = m.adv >= 1 ? 'good' : m.adv <= -1 ? 'bad' : 'even';

  // Verdict from the user's side of the ball.
  let verdict: string;
  if (out.type === 'sack') verdict = userOnOffense ? 'Sacked: the pass rush got home before anyone was open.' : 'Sack! Your pass rush got home before anyone was open.';
  else if (out.intercepted) verdict = userOnOffense ? 'Intercepted: the throw went into coverage.' : 'Interception! Your coverage was waiting for that throw.';
  else if (out.fumbleLost) verdict = userOnOffense ? 'Fumble: the ball came loose. That one is mostly bad luck.' : 'Fumble recovery! Mostly luck, but you\'ll take it.';
  else if (userOnOffense) {
    if (good) verdict = callQuality === 'bad' ? 'It worked even though the matchup favored the defense: good players and a little luck.' : 'It worked.';
    else verdict = callQuality === 'good' ? 'Good call, but it didn\'t work this time: execution and luck matter too.' : 'It didn\'t work.';
  } else if (good) {
    verdict = callQuality === 'bad' ? 'Their play worked, even though your call was a good one: execution and luck matter too.' : 'Their play beat your call.';
  } else {
    verdict = callQuality === 'good' ? 'You got the stop even though their play was a good answer to your call.' : 'Your defense won this one.';
  }
  if (!top.length && callQuality === 'even') top.push('An even matchup: neither call had a clear edge, so the players decided it.');
  return `${verdict} ${top.join(' ')}`.trim();
}

const ordinal = (n: number) => (n === 1 ? '1st' : n === 2 ? '2nd' : n === 3 ? '3rd' : `${n}th`);
