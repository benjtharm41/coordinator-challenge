// Canvas drawing shared by the live field and the play diagrams.
import { COVERAGES } from '../engine/playbook';
import { FIELD_W, HALF_W, type Pt } from './geometry';
import type { Scene } from './scene';

/** Maps field yards to canvas pixels. Field y is "absolute": yards from the offense's own goal line. */
export interface Transform {
  w: number;
  h: number;
  ppy: number;
  /** Field y shown at the bottom edge of the canvas. */
  bottom: number;
}

export const sx = (tf: Transform, x: number) => tf.w / 2 + x * tf.ppy;
export const sy = (tf: Transform, absY: number) => tf.h - (absY - tf.bottom) * tf.ppy;

export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [128, 128, 128];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
export const colorDist = (a: string, b: string) => {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  return Math.hypot(r1 - r2, g1 - g2, b1 - b2);
};
export const luminance = (hex: string) => {
  const [r, g, b] = hexToRgb(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
};
export const alpha = (hex: string, a: number) => {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
};

export interface Look {
  off: string;
  def: string;
  offAbbr: string;
  defAbbr: string;
}

/** Picks dot colors that stay readable against each other and the grass. */
export function pickLook(off: { color: string; color2: string; abbr: string }, def: { color: string; color2: string; abbr: string }): Look {
  let d = def.color;
  if (colorDist(off.color, d) < 90) d = def.color2;
  if (colorDist(off.color, d) < 90) d = luminance(off.color) > 0.5 ? '#111827' : '#f3f4f6';
  return { off: off.color, def: d, offAbbr: off.abbr, defAbbr: def.abbr };
}

export interface FieldOptions {
  look: Look;
  /** Draw yard numbers and end-zone names (live field only). */
  detail: boolean;
  losAbs?: number;
  firstDownAbs?: number;
  uprights?: boolean;
}

export function drawField(ctx: CanvasRenderingContext2D, tf: Transform, o: FieldOptions) {
  const { w, h } = tf;
  ctx.fillStyle = '#143a1f';
  ctx.fillRect(0, 0, w, h);
  const left = sx(tf, -HALF_W);
  const right = sx(tf, HALF_W);
  const top = tf.bottom + h / tf.ppy;
  // Stripes every 5 yards.
  for (let a = Math.floor(tf.bottom / 5) * 5; a < top; a += 5) {
    const y1 = sy(tf, a + 5);
    const y2 = sy(tf, a);
    if (a >= 0 && a < 100) {
      ctx.fillStyle = Math.floor(a / 5) % 2 ? '#2b7a3b' : '#2f8140';
      ctx.fillRect(left, y1, right - left, y2 - y1 + 0.5);
    }
  }
  // End zones.
  const ez = (from: number, to: number, color: string, text: string) => {
    if (to < tf.bottom || from > top) return;
    const y1 = sy(tf, to);
    const y2 = sy(tf, from);
    ctx.fillStyle = alpha(color, 0.78);
    ctx.fillRect(left, y1, right - left, y2 - y1);
    if (o.detail) {
      ctx.save();
      ctx.translate((left + right) / 2, (y1 + y2) / 2);
      ctx.font = `800 ${Math.min(0.2 * (right - left), 0.85 * (y2 - y1))}px -apple-system, Segoe UI, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = luminance(color) > 0.55 ? 'rgba(0,0,0,0.35)' : 'rgba(255,255,255,0.4)';
      ctx.fillText(text, 0, 0);
      ctx.restore();
    }
  };
  ez(-10, 0, o.look.off, o.look.offAbbr);
  ez(100, 110, o.look.def, o.look.defAbbr);

  // Lines.
  ctx.lineCap = 'butt';
  for (let a = Math.ceil(tf.bottom); a <= top; a++) {
    if (a < 0 || a > 100) continue;
    const y = sy(tf, a);
    const major = a % 10 === 0;
    const five = a % 5 === 0;
    if (five || a === 0 || a === 100) {
      ctx.strokeStyle = a === 0 || a === 100 ? 'rgba(255,255,255,0.95)' : `rgba(255,255,255,${major ? 0.6 : 0.4})`;
      ctx.lineWidth = a === 0 || a === 100 ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(right, y);
      ctx.stroke();
    } else if (o.detail) {
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const hx of [-3.1, 3.1, -HALF_W + 0.6, HALF_W - 0.6]) {
        const hxp = sx(tf, hx);
        ctx.moveTo(hxp - tf.ppy * 0.3, y);
        ctx.lineTo(hxp + tf.ppy * 0.3, y);
      }
      ctx.stroke();
    }
  }
  // Yard numbers.
  if (o.detail) {
    ctx.fillStyle = 'rgba(255,255,255,0.4)';
    ctx.font = `700 ${Math.max(10, tf.ppy * 2.3)}px -apple-system, Segoe UI, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let a = 10; a <= 90; a += 10) {
      const y = sy(tf, a + 0);
      if (y < -10 || y > h + 10) continue;
      const label = String(Math.min(a, 100 - a));
      ctx.fillText(label, sx(tf, -14.7), y);
      ctx.fillText(label, sx(tf, 14.7), y);
    }
  }
  // Sidelines.
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(left, 0);
  ctx.lineTo(left, h);
  ctx.moveTo(right, 0);
  ctx.lineTo(right, h);
  ctx.stroke();
  // Line of scrimmage and first-down line.
  if (o.losAbs !== undefined) {
    ctx.strokeStyle = 'rgba(59,130,246,0.95)';
    ctx.lineWidth = 2.5;
    const y = sy(tf, o.losAbs);
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();
  }
  if (o.firstDownAbs !== undefined && o.firstDownAbs <= 100) {
    ctx.strokeStyle = 'rgba(250,204,21,0.95)';
    ctx.lineWidth = 2.5;
    const y = sy(tf, o.firstDownAbs);
    ctx.beginPath();
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
    ctx.stroke();
  }
  if (o.uprights !== false && o.detail) {
    // Goalposts at the back of the far end zone.
    const y = sy(tf, 110);
    if (y > -20 && y < h + 20) {
      ctx.strokeStyle = '#facc15';
      ctx.lineWidth = Math.max(2, tf.ppy * 0.35);
      ctx.beginPath();
      ctx.moveTo(sx(tf, -3.1), y);
      ctx.lineTo(sx(tf, -3.1), y + tf.ppy * 5);
      ctx.moveTo(sx(tf, 3.1), y);
      ctx.lineTo(sx(tf, 3.1), y + tf.ppy * 5);
      ctx.moveTo(sx(tf, -3.1), y + tf.ppy * 5);
      ctx.lineTo(sx(tf, 3.1), y + tf.ppy * 5);
      ctx.stroke();
    }
  }
}

// ---------------------------------------------------------------- overlays

function arrow(ctx: CanvasRenderingContext2D, from: Pt, to: Pt, head: number) {
  const a = Math.atan2(to.y - from.y, to.x - from.x);
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - head * Math.cos(a - 0.5), to.y - head * Math.sin(a - 0.5));
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - head * Math.cos(a + 0.5), to.y - head * Math.sin(a + 0.5));
  ctx.stroke();
}

function polyline(ctx: CanvasRenderingContext2D, pts: Pt[]) {
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.stroke();
}

export interface OverlayFlags {
  offense: boolean;
  defense: boolean;
  /** 0-1 strength. */
  offAlpha?: number;
  defAlpha?: number;
  labels?: boolean;
  /** Multiplies line thickness (diagrams are drawn small and need bolder lines). */
  thick?: number;
  look: Look;
}

/** Routes, run paths, zones and blitz arrows for a scene. `losAbs` positions the play on the field. */
export function drawOverlay(ctx: CanvasRenderingContext2D, tf: Transform, scene: Scene, losAbs: number, f: OverlayFlags) {
  const P = (p: Pt): Pt => ({ x: sx(tf, p.x), y: sy(tf, losAbs + p.y) });
  const lw = Math.max(1.4, tf.ppy * 0.32) * (f.thick ?? 1);
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (f.defense) {
    const a = f.defAlpha ?? 1;
    const zoneColor = f.look.def;
    for (const d of scene.def) {
      const as = d.assign;
      if (as.kind === 'zone') {
        const c = P({ x: as.cx, y: as.cy });
        ctx.fillStyle = alpha(as.deep ? '#fbbf24' : '#f9a8d4', 0.16 * a);
        ctx.strokeStyle = alpha(as.deep ? '#fbbf24' : '#f9a8d4', 0.7 * a);
        ctx.lineWidth = Math.max(1, lw * 0.6);
        ctx.setLineDash([lw * 2, lw * 1.5]);
        ctx.beginPath();
        ctx.ellipse(c.x, c.y, as.rx * tf.ppy, as.ry * tf.ppy, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.setLineDash([]);
        if (f.labels) {
          ctx.fillStyle = `rgba(255,255,255,${0.85 * a})`;
          ctx.font = `600 ${Math.max(8, tf.ppy * 1.7)}px -apple-system, Segoe UI, sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(as.label, c.x, c.y);
        }
        // Line from the defender to the zone.
        const s = P({ x: d.x, y: d.y });
        ctx.strokeStyle = alpha('#fde68a', 0.55 * a);
        ctx.lineWidth = Math.max(1, lw * 0.5);
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(c.x, c.y);
        ctx.stroke();
      } else if (as.kind === 'man') {
        const rec = scene.off.find((o) => o.slot === as.recv);
        if (rec) {
          const s = P({ x: d.x, y: d.y });
          const e = P({ x: rec.x, y: rec.y });
          ctx.strokeStyle = alpha('#93c5fd', 0.85 * a);
          ctx.lineWidth = Math.max(1, lw * 0.6);
          ctx.setLineDash([lw * 1.4, lw * 1.4]);
          ctx.beginPath();
          ctx.moveTo(s.x, s.y);
          ctx.lineTo(e.x, e.y);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      } else if (as.kind === 'rush') {
        const s = P({ x: d.x, y: d.y });
        const e = P(as.target);
        ctx.strokeStyle = alpha('#f87171', 0.95 * a);
        ctx.lineWidth = lw;
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(e.x, e.y);
        ctx.stroke();
        arrow(ctx, s, e, tf.ppy * 1.1);
      } else {
        const s = P({ x: d.x, y: d.y });
        ctx.strokeStyle = alpha('#fde68a', 0.8 * a);
        ctx.lineWidth = Math.max(1, lw * 0.5);
        ctx.beginPath();
        ctx.arc(s.x, s.y, tf.ppy * 1.6, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    void zoneColor;
  }
  if (f.offense) {
    const a = f.offAlpha ?? 1;
    for (const r of scene.routes) {
      const pts = r.path.map(P);
      const clear = r.route === 'clear';
      ctx.strokeStyle = clear ? `rgba(255,255,255,${0.45 * a})` : `rgba(255,255,255,${0.95 * a})`;
      ctx.lineWidth = clear ? Math.max(1, lw * 0.6) : lw;
      polyline(ctx, pts);
      if (pts.length >= 2) arrow(ctx, pts[pts.length - 2], pts[pts.length - 1], tf.ppy * 1.1);
    }
    for (const slot of scene.blockers) {
      const d = scene.off.find((o) => o.slot === slot);
      if (!d) continue;
      const s = P({ x: d.x, y: d.y });
      ctx.strokeStyle = `rgba(255,255,255,${0.7 * a})`;
      ctx.lineWidth = lw;
      const dx = tf.ppy * 1.1;
      ctx.beginPath();
      ctx.moveTo(s.x, s.y - tf.ppy * 1.3);
      ctx.lineTo(s.x, s.y - tf.ppy * 2.2);
      ctx.moveTo(s.x - dx, s.y - tf.ppy * 2.2);
      ctx.lineTo(s.x + dx, s.y - tf.ppy * 2.2);
      ctx.stroke();
    }
    if (scene.run) {
      const pts = scene.run.path.map((p, i) => (i === 0 ? P(p) : P({ x: p.x, y: p.y + 2.5 * (i === scene.run!.path.length - 1 ? 1 : 0) })));
      ctx.strokeStyle = `rgba(250,204,21,${0.98 * a})`;
      ctx.lineWidth = lw * 1.25;
      if (scene.run.pitch) {
        ctx.setLineDash([lw * 1.6, lw * 1.2]);
        polyline(ctx, pts.slice(0, 2));
        ctx.setLineDash([]);
        polyline(ctx, pts.slice(1));
      } else polyline(ctx, pts);
      arrow(ctx, pts[pts.length - 2], pts[pts.length - 1], tf.ppy * 1.3);
      ctx.strokeStyle = `rgba(255,255,255,${0.75 * a})`;
      ctx.lineWidth = lw * 0.9;
      for (const pull of scene.run.pulls) {
        const pp = pull.path.map(P);
        polyline(ctx, pp);
        arrow(ctx, pp[pp.length - 2], pp[pp.length - 1], tf.ppy * 1.1);
      }
      // Offensive line blocks up the field.
      for (const d of scene.off) {
        if (!['LT', 'LG', 'C', 'RG', 'RT'].includes(d.slot) || scene.run.pulls.some((p) => p.slot === d.slot)) continue;
        const s = P({ x: d.x, y: d.y });
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(s.x, s.y - tf.ppy * 1.7);
        ctx.stroke();
      }
    }
  }
  ctx.restore();
}

// ---------------------------------------------------------------- dots and ball

export interface DrawDot {
  x: number;
  y: number;
  num: number;
  side: 'off' | 'def';
  highlight?: boolean;
  /** Drawn faded: a placeholder alignment that isn't the real one yet. */
  ghost?: boolean;
}

export function drawDot(ctx: CanvasRenderingContext2D, tf: Transform, losAbs: number, d: DrawDot, look: Look, showNumber = true) {
  const r = Math.max(6.2, Math.min(13, tf.ppy * 1.08));
  const x = sx(tf, d.x);
  const y = sy(tf, losAbs + d.y);
  const fill = d.side === 'off' ? look.off : look.def;
  ctx.save();
  if (d.ghost) ctx.globalAlpha = 0.42;
  ctx.beginPath();
  ctx.arc(x + 1, y + 1.5, r, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.28)';
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = d.highlight ? 2.4 : 1.6;
  ctx.strokeStyle = d.highlight ? '#facc15' : d.side === 'off' ? '#ffffff' : 'rgba(0,0,0,0.85)';
  ctx.stroke();
  if (d.side === 'def' && luminance(fill) > 0.75) {
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.stroke();
  }
  if (showNumber) {
    ctx.fillStyle = luminance(fill) > 0.6 ? '#0b0b0b' : '#ffffff';
    ctx.font = `700 ${Math.round(r * 1.0)}px -apple-system, Segoe UI, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(d.num), x, y + 0.5);
  }
  ctx.restore();
}

export function drawBall(ctx: CanvasRenderingContext2D, tf: Transform, losAbs: number, b: { x: number; y: number; z: number }) {
  const x = sx(tf, b.x);
  const gy = sy(tf, losAbs + b.y);
  const lift = b.z * tf.ppy * 0.5;
  ctx.beginPath();
  ctx.ellipse(x, gy + 1, tf.ppy * 0.5, tf.ppy * 0.28, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(x, gy - lift, tf.ppy * 0.55 + b.z * 0.25, tf.ppy * 0.33 + b.z * 0.15, -0.5, 0, Math.PI * 2);
  ctx.fillStyle = '#8b4513';
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
}

export function drawFlag(ctx: CanvasRenderingContext2D, tf: Transform, losAbs: number, m: { x: number; y: number }) {
  const x = sx(tf, m.x);
  const y = sy(tf, losAbs + m.y);
  ctx.fillStyle = '#facc15';
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + tf.ppy * 2.2, y - tf.ppy * 0.8);
  ctx.lineTo(x, y - tf.ppy * 1.7);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#78350f';
  ctx.lineWidth = 1;
  ctx.stroke();
}

export { COVERAGES, FIELD_W };
