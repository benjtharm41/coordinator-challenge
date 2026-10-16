// Core data types shared by the engine, the AI, and the UI.

export type Pos = 'QB' | 'RB' | 'FB' | 'WR' | 'TE' | 'OL' | 'DL' | 'EDGE' | 'LB' | 'CB' | 'S' | 'K' | 'P';

/** Position-specific sub-ratings, all on the 40-99 scale. */
export interface PlayerRatings {
  acc?: number; // QB short/intermediate accuracy
  deep?: number; // QB deep ball
  dec?: number; // QB decision making (avoids interceptions)
  pocket?: number; // QB pocket presence (avoids sacks)
  mob?: number; // QB mobility (scrambles)
  rush?: number; // RB rushing / DL+EDGE+LB pass rush
  catch?: number; // hands
  route?: number; // separation
  yac?: number; // yards after catch / elusiveness
  pblk?: number; // pass blocking
  rblk?: number; // run blocking
  run?: number; // run defense / tackling
  cover?: number; // coverage
  ball?: number; // ball skills (interceptions)
  kacc?: number; // kicker accuracy
  leg?: number; // kicker/punter leg strength
}

export interface Player {
  id: string;
  name: string;
  pos: Pos;
  num: number;
  ovr: number;
  r: PlayerRatings;
  /** Injury designation if any (Questionable / Doubtful / Out / IR). */
  injury?: string;
}

export interface TeamInfo {
  abbr: string;
  name: string;
  nick: string;
  conf: string;
  division: string;
  color: string;
  color2: string;
  headCoach: string;
}

/** Depth chart: player ids in order, per slot group. */
export interface DepthChart {
  QB: string[];
  RB: string[];
  FB: string[];
  WR: string[];
  TE: string[];
  OL: string[];
  DL: string[];
  EDGE: string[];
  LB: string[];
  CB: string[];
  S: string[];
  K: string[];
  P: string[];
}

export interface OffenseTendencies {
  /** Team's pass-rate-over-expected, in log-odds added to the league model. */
  proe: number;
  shotgun: number;
  playAction: number;
  noHuddle: number;
  motion: number;
  /** Relative preference for deep shots (1 = league average). */
  deepShot: number;
  /** Relative preference for screens (1 = league average). */
  screen: number;
}

export interface DefenseTendencies {
  baseFront: '43' | '34';
  blitz: number;
  coverage: Record<Coverage, number>;
}

export interface Tendencies {
  off: OffenseTendencies;
  def: DefenseTendencies;
}

export interface Team {
  info: TeamInfo;
  players: Player[];
  depth: DepthChart;
  tendencies: Tendencies;
  /** Where the data came from, shown in the UI. */
  source: 'placeholder' | 'nflverse';
}

// ---------- Play calls ----------

export type Formation = 'singleback' | 'iform' | 'shotgun' | 'pistol' | 'empty' | 'trips' | 'bunch' | 'heavy' | 'goalline';

export type RunConcept = 'inside_zone' | 'outside_zone' | 'power' | 'counter' | 'duo' | 'draw' | 'toss' | 'qb_sneak' | 'rpo';
export type PassConcept =
  | 'slant_flat'
  | 'stick'
  | 'mesh'
  | 'smash'
  | 'flood'
  | 'four_verts'
  | 'curl_flat'
  | 'dagger'
  | 'y_cross'
  | 'rb_screen'
  | 'wr_screen'
  | 'pa_shot'
  | 'hail_mary';
export type Concept = RunConcept | PassConcept;

export type Tempo = 'normal' | 'hurry' | 'milk';

export interface OffCall {
  formation: Formation;
  concept: Concept;
}

export type Front = '43' | '34' | 'nickel' | 'dime' | 'goalline';
export type Coverage = 'c0' | 'c1' | 'c2' | 'c2m' | 'c3' | 'c4' | 'c6';
export type Pressure = 'base' | 'lb_blitz' | 'db_blitz' | 'zone_blitz' | 'all_out';

export interface DefCall {
  front: Front;
  coverage: Coverage;
  pressure: Pressure;
}

/** What the offense decides to do on a snap. */
export type OffChoice =
  | { type: 'play'; call: OffCall; tempo: Tempo }
  | { type: 'punt' }
  | { type: 'fg' }
  | { type: 'spike' }
  | { type: 'kneel' };

export type Side = 'home' | 'away';
export const other = (s: Side): Side => (s === 'home' ? 'away' : 'home');
