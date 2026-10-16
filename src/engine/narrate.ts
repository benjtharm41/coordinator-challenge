// One-line play descriptions, e.g. "J. Smith 12-yard catch on Dagger vs Cover 3".
import { CONCEPTS, COVERAGES, FRONTS, PRESSURES } from './playbook';
import type { ScrimmageOutcome } from './resolve';
import type { DefCall, OffCall, Player, Side } from './types';

export const shortName = (p?: Player) => {
  if (!p) return 'Unknown';
  const parts = p.name.split(' ');
  return parts.length > 1 ? `${parts[0][0]}. ${parts.slice(1).join(' ')}` : p.name;
};

export function defCallName(d: DefCall): string {
  const pr = d.pressure === 'base' ? '' : `, ${PRESSURES[d.pressure].name}`;
  return `${FRONTS[d.front].name} ${COVERAGES[d.coverage].name}${pr}`;
}

const yardsPhrase = (y: number) => (y === 0 ? 'no gain' : y < 0 ? `a loss of ${-y}` : `${y} yard${y === 1 ? '' : 's'}`);

export function describePlay(out: ScrimmageOutcome, off: OffCall, def: DefCall, _sides?: Record<Side, unknown>): string {
  const concept = CONCEPTS[off.concept].name + (out.rpo ? ` (${out.rpo === 'run' ? 'handoff' : 'throw'})` : '');
  const vs = `${concept} vs ${COVERAGES[def.coverage].name}${def.pressure === 'base' ? '' : ' ' + PRESSURES[def.pressure].name}`;
  let text: string;
  switch (out.type) {
    case 'none':
      return '';
    case 'run': {
      const who = shortName(out.carrier);
      if (out.yards >= 20) text = `${who} breaks free for ${out.yards} yards!`;
      else text = `${who} runs for ${yardsPhrase(out.yards)}.`;
      break;
    }
    case 'scramble':
      text = `${shortName(out.passer)} scrambles for ${yardsPhrase(out.yards)}.`;
      break;
    case 'sack':
      text = `${shortName(out.passer)} SACKED by ${shortName(out.defender)} for ${yardsPhrase(out.yards)}.`;
      break;
    case 'pass':
      if (out.intercepted) {
        text = `${shortName(out.passer)} INTERCEPTED by ${shortName(out.defender)}${out.touchback ? ' in the end zone. Touchback' : out.returnYards ? `, returned ${out.returnYards}` : ''}.`;
      } else if (out.complete) {
        const target = shortName(out.target);
        if (off.concept === 'hail_mary') text = `HAIL MARY... CAUGHT by ${target}!`;
        else if (out.yards >= 25) text = `${shortName(out.passer)} goes deep to ${target}: ${out.yards}-yard catch!`;
        else text = `${target} ${out.yards === 0 ? 'catch for no gain' : out.yards < 0 ? `catch for a loss of ${-out.yards}` : `${out.yards}-yard catch`}.`;
      } else {
        text = `${shortName(out.passer)} incomplete to ${shortName(out.target)} (${out.route}).`;
      }
      break;
  }
  if (out.fumbleLost) text += ` FUMBLE! Recovered by ${shortName(out.defender)}.`;
  return `${text} [${vs}]`;
}
