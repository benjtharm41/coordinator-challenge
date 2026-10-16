// X's-and-O's play diagrams, drawn once and cached as small images.
import type { DefCall, Formation, OffCall } from '../engine/types';
import { allPlaceholderTeams } from '../engine/placeholder';
import { alpha, drawOverlay, sx, sy, type Look, type Transform } from './draw';
import { buildScene, type Scene } from './scene';

const cache = new Map<string, string>();
const LOOK: Look = { off: '#ffffff', def: '#f87171', offAbbr: '', defAbbr: '' };
const W_YARDS = 52;
const LOS = 50;

interface DiagramSize {
  w: number;
  top: number;
  bottomYards: number;
}

const SIZES: Record<'play' | 'defense' | 'formation', DiagramSize> = {
  play: { w: 180, top: 26, bottomYards: 9.5 },
  defense: { w: 180, top: 24, bottomYards: 8 },
  formation: { w: 120, top: 12, bottomYards: 9 },
};

function teams() {
  const t = allPlaceholderTeams();
  return { a: t[0], b: t[1] };
}

function render(kind: keyof typeof SIZES, scene: Scene, opts: { offense: boolean; defense: boolean; offFaint?: boolean }): string {
  const size = SIZES[kind];
  const ppy = size.w / W_YARDS;
  const yards = size.top + size.bottomYards;
  const hCss = Math.round(yards * ppy);
  const dpr = 2;
  const c = document.createElement('canvas');
  c.width = size.w * dpr;
  c.height = hCss * dpr;
  const ctx = c.getContext('2d')!;
  ctx.scale(dpr, dpr);
  const tf: Transform = { w: size.w, h: hCss, ppy, bottom: LOS - size.bottomYards };

  // Chalkboard background.
  ctx.fillStyle = '#17331f';
  ctx.fillRect(0, 0, size.w, hCss);
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  for (let a = Math.ceil(tf.bottom / 5) * 5; a < tf.bottom + yards; a += 5) {
    ctx.beginPath();
    ctx.moveTo(0, sy(tf, a));
    ctx.lineTo(size.w, sy(tf, a));
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(96,165,250,0.85)';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(0, sy(tf, LOS));
  ctx.lineTo(size.w, sy(tf, LOS));
  ctx.stroke();

  drawOverlay(ctx, tf, scene, LOS, { offense: opts.offense, defense: opts.defense, look: LOOK, thick: 1.5 });

  const r = Math.max(3.4, ppy * 1.15);
  // Offense: O's (QB filled).
  for (const d of scene.off) {
    const x = sx(tf, d.x);
    const y = sy(tf, LOS + d.y);
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.lineWidth = 1.3;
    ctx.strokeStyle = opts.offFaint ? 'rgba(255,255,255,0.45)' : '#ffffff';
    if (d.slot === 'QB') {
      ctx.fillStyle = opts.offFaint ? 'rgba(255,255,255,0.45)' : '#ffffff';
      ctx.fill();
    } else {
      ctx.fillStyle = 'rgba(23,51,31,0.9)';
      ctx.fill();
      ctx.stroke();
    }
  }
  // Defense: X's.
  if (opts.defense) {
    ctx.strokeStyle = '#fb7185';
    ctx.lineWidth = 1.5;
    ctx.lineCap = 'round';
    for (const d of scene.def) {
      const x = sx(tf, d.x);
      const y = sy(tf, LOS + d.y);
      ctx.beginPath();
      ctx.moveTo(x - r * 0.85, y - r * 0.85);
      ctx.lineTo(x + r * 0.85, y + r * 0.85);
      ctx.moveTo(x + r * 0.85, y - r * 0.85);
      ctx.lineTo(x - r * 0.85, y + r * 0.85);
      ctx.stroke();
    }
  }
  void alpha;
  return c.toDataURL('image/png');
}

/** The play diagram for an offensive call. */
export function offenseDiagram(call: OffCall): string {
  const key = `o:${call.formation}:${call.concept}`;
  let url = cache.get(key);
  if (!url) {
    const { a, b } = teams();
    const scene = buildScene(a, b, call, { front: 'nickel', coverage: 'c3', pressure: 'base' });
    url = render('play', scene, { offense: true, defense: false });
    cache.set(key, url);
  }
  return url;
}

/** Just the players lined up in a formation. */
export function formationDiagram(formation: Formation): string {
  const key = `f:${formation}`;
  let url = cache.get(key);
  if (!url) {
    const { a, b } = teams();
    const scene = buildScene(a, b, { formation, concept: formation === 'goalline' || formation === 'heavy' ? 'inside_zone' : 'slant_flat' }, { front: 'nickel', coverage: 'c3', pressure: 'base' });
    scene.routes = [];
    scene.run = undefined;
    scene.blockers = [];
    url = render('formation', scene, { offense: true, defense: false });
    cache.set(key, url);
  }
  return url;
}

/** A defensive call drawn against the offense's actual formation. */
export function defenseDiagram(call: DefCall, against: Formation): string {
  const key = `d:${call.front}:${call.coverage}:${call.pressure}:${against}`;
  let url = cache.get(key);
  if (!url) {
    const { a, b } = teams();
    const scene = buildScene(a, b, { formation: against, concept: against === 'goalline' || against === 'heavy' ? 'inside_zone' : 'slant_flat' }, call);
    scene.routes = [];
    scene.run = undefined;
    scene.blockers = [];
    url = render('defense', scene, { offense: false, defense: true, offFaint: true });
    cache.set(key, url);
  }
  return url;
}
