// The live field: draws lined-up scenes and plays animations on a canvas.
import type { Team } from '../engine/types';
import { ballAt, posAt, type Anim } from './anim';
import type { Shot } from './director';
import { drawBall, drawDot, drawField, drawFlag, drawOverlay, pickLook, type DrawDot, type Look, type Transform } from './draw';
import { FIELD_W } from './geometry';
import type { Scene } from './scene';

export interface OverlayChoice {
  /** Show my side's routes/zones. */
  mine: 'off' | 'def' | null;
  /** Also show the opponent's (after the snap). */
  reveal: boolean;
  labels: boolean;
}

interface StaticScene {
  scene: Scene;
  losAbs: number;
  firstDownAbs?: number;
}

export class FieldView {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private w = 300;
  private h = 260;
  private dpr = 1;
  private ppy = 6;
  private bottom = 0;
  private targetBottom = 0;
  private look: Look = { off: '#e31837', def: '#00338d', offAbbr: 'OFF', defAbbr: 'DEF' };
  private losAbs = 35;
  private firstDownAbs: number | undefined;
  private scene: Scene | undefined;
  private overlay: OverlayChoice = { mine: null, reveal: false, labels: false };
  private shot: Shot | undefined;
  private t = 0;
  private playing = false;
  private raf = 0;
  private last = 0;
  private speed = 1;
  private onDone: (() => void) | undefined;
  private frameDots: DrawDot[] = [];
  private ball: { x: number; y: number; z: number } | undefined;
  private uprights = true;
  private observer: ResizeObserver;
  private offenseTeam: Team | undefined;
  private defenseTeam: Team | undefined;
  private carrierId: string | undefined;

  constructor(private host: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'field-canvas';
    this.host.append(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    this.observer = new ResizeObserver(() => this.resize());
    this.observer.observe(this.host);
    this.resize();
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.observer.disconnect();
    this.canvas.remove();
  }

  private resize() {
    const r = this.host.getBoundingClientRect();
    if (!r.width || !r.height) return;
    this.dpr = Math.min(3, window.devicePixelRatio || 1);
    this.w = r.width;
    this.h = r.height;
    this.canvas.width = Math.round(this.w * this.dpr);
    this.canvas.height = Math.round(this.h * this.dpr);
    this.canvas.style.width = `${this.w}px`;
    this.canvas.style.height = `${this.h}px`;
    this.ppy = this.w / (FIELD_W + 1.6);
    this.fixCamera(true);
    this.draw();
  }

  private get visible() {
    return this.h / this.ppy;
  }

  private fixCamera(snap: boolean) {
    const preBottom = this.losAbs - 9.5;
    this.targetBottom = Math.max(-10, Math.min(110 - this.visible, preBottom));
    if (snap) this.bottom = this.targetBottom;
  }

  setSpeed(s: number) {
    this.speed = s;
  }

  /** Set which teams are on the field (offense moves up). */
  setTeams(offense: Team, defense: Team) {
    this.offenseTeam = offense;
    this.defenseTeam = defense;
    this.look = pickLook(
      { color: offense.info.color, color2: offense.info.color2, abbr: offense.info.abbr },
      { color: defense.info.color, color2: defense.info.color2, abbr: defense.info.abbr },
    );
  }

  /** Show a lined-up scene (before the snap). */
  showScene(s: StaticScene, overlay: OverlayChoice, snapCamera = false, ghost?: 'off' | 'def') {
    this.stop();
    this.shot = undefined;
    this.scene = s.scene;
    this.losAbs = s.losAbs;
    this.firstDownAbs = s.firstDownAbs;
    this.overlay = overlay;
    this.frameDots = [
      ...s.scene.def.map((d) => ({ x: d.x, y: d.y, num: d.num, side: 'def' as const, ghost: ghost === 'def' })),
      ...s.scene.off.map((d) => ({ x: d.x, y: d.y, num: d.num, side: 'off' as const, ghost: ghost === 'off' })),
    ];
    this.ball = { x: 0, y: -0.4, z: 0.3 };
    this.uprights = true;
    this.carrierId = undefined;
    this.fixCamera(snapCamera);
    this.kick();
  }

  /** Show only the field (kickoffs etc.) at a spot with no players. */
  showEmpty(losAbs: number, firstDownAbs?: number) {
    this.stop();
    this.shot = undefined;
    this.scene = undefined;
    this.frameDots = [];
    this.ball = { x: 0, y: 0, z: 0.3 };
    this.losAbs = losAbs;
    this.firstDownAbs = firstDownAbs;
    this.fixCamera(true);
    this.kick();
  }

  play(shot: Shot, overlay: OverlayChoice, speed: number, onDone: () => void) {
    this.stop();
    this.shot = shot;
    this.scene = shot.scene;
    this.losAbs = shot.losAbs;
    this.firstDownAbs = shot.firstDownAbs;
    this.overlay = overlay;
    this.speed = speed;
    this.onDone = onDone;
    this.t = 0;
    this.uprights = !!shot.anim.uprights || shot.entry.kind === 'fg' || shot.entry.kind === 'xp';
    this.fixCamera(false);
    this.bottom = this.targetBottom;
    this.playing = true;
    this.last = performance.now();
    this.frame();
  }

  isPlaying() {
    return this.playing;
  }

  /** Development helper: pause and show the frame at time t. */
  seek(t: number) {
    if (!this.shot) return;
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.t = t;
    this.renderAt(t, 0.5);
  }

  get duration() {
    return this.shot?.anim.duration ?? 0;
  }

  skip() {
    if (!this.shot || (!this.playing && !this.onDone)) return;
    this.t = this.shot.anim.duration;
    this.renderAt(this.t, 1);
    this.finish();
  }

  stop() {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.onDone = undefined;
  }

  private finish() {
    this.playing = false;
    const cb = this.onDone;
    this.onDone = undefined;
    cb?.();
  }

  private frame = () => {
    if (!this.playing || !this.shot) return;
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.t += dt * this.speed;
    const dur = this.shot.anim.duration;
    if (this.t >= dur) {
      this.t = dur;
      this.renderAt(this.t, dt);
      this.finish();
      return;
    }
    this.renderAt(this.t, dt);
    this.raf = requestAnimationFrame(this.frame);
  };

  private renderAt(t: number, dt: number) {
    const a: Anim = this.shot!.anim;
    const dots: DrawDot[] = [];
    const ball = ballAt(a, t);
    const seg = a.ball.find((s, i) => t >= s.t0 && (i === a.ball.length - 1 || t < a.ball[i + 1].t0));
    this.carrierId = seg && seg.kind === 'carried' ? seg.dot : undefined;
    for (const tr of a.tracks) {
      const p = posAt(tr.keys, t);
      dots.push({ x: p.x, y: p.y, num: tr.num, side: tr.side, highlight: tr.id === this.carrierId });
    }
    dots.sort((x, y) => (x.side === y.side ? 0 : x.side === 'def' ? -1 : 1));
    this.frameDots = dots;
    this.ball = ball;
    // Camera follows the ball.
    const abs = this.losAbs + ball.y;
    const vis = this.visible;
    let want = this.targetBottom;
    if (abs > want + vis - 8) want = abs - vis + 8;
    if (abs < want + 4) want = abs - 4;
    want = Math.max(-10, Math.min(110 - vis, want));
    const k = 1 - Math.pow(0.001, dt || 0.016);
    this.bottom += (want - this.bottom) * Math.min(1, k * 2.2);
    this.draw();
  }

  private kick() {
    cancelAnimationFrame(this.raf);
    const step = () => {
      const diff = this.targetBottom - this.bottom;
      if (Math.abs(diff) > 0.02) {
        this.bottom += diff * 0.18;
        this.draw();
        this.raf = requestAnimationFrame(step);
      } else {
        this.bottom = this.targetBottom;
        this.draw();
      }
    };
    step();
  }

  private draw() {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const tf: Transform = { w: this.w, h: this.h, ppy: this.ppy, bottom: this.bottom };
    drawField(ctx, tf, { look: this.look, detail: true, losAbs: this.losAbs, firstDownAbs: this.firstDownAbs, uprights: this.uprights });
    if (this.scene && this.overlay.mine) {
      const started = this.playing || (this.shot && this.t > 0);
      const mineOff = this.overlay.mine === 'off';
      const reveal = this.overlay.reveal && !!started;
      ctx.save();
      drawOverlay(ctx, tf, this.scene, this.losAbs, {
        offense: mineOff || reveal, defense: !mineOff || reveal,
        offAlpha: mineOff ? 1 : 0.6, defAlpha: mineOff ? 0.6 : 1, labels: this.overlay.labels, look: this.look,
      });
      ctx.restore();
    }
    for (const d of this.frameDots) drawDot(ctx, tf, this.losAbs, d, this.look);
    if (this.ball) drawBall(ctx, tf, this.losAbs, this.ball);
    if (this.shot) {
      for (const m of this.shot.anim.markers) {
        if (this.t >= m.t) {
          if (m.kind === 'flag') drawFlag(ctx, tf, this.losAbs, m);
        }
      }
    }
  }

  /** Called when the page becomes visible again. */
  refresh() {
    this.resize();
  }

  get teams() {
    return { off: this.offenseTeam, def: this.defenseTeam };
  }
}
