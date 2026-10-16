// Loads the team data built by pipeline/build_data.py. Falls back to placeholder
// players if the files can't be loaded (for example, the very first visit offline).
import { placeholderTeam, TEAM_INFO } from '../engine/placeholder';
import type { Team, TeamInfo } from '../engine/types';

export interface Headline {
  label: string;
  name: string;
  ovr: number;
  injury?: string | null;
}

export interface TeamPreview extends TeamInfo {
  headline: Headline[];
  grades: { qb: number; ol: number; pass: number; rush: number; cover: number };
  injuries: { name: string; pos: string; status: string }[];
  baseFront: '43' | '34';
}

export interface Manifest {
  generatedAt: string;
  season: number;
  week: number;
  sources: { pbp: number[]; coveragePlays: number };
  teams: TeamPreview[];
}

const base = () => `${import.meta.env.BASE_URL}data/`;
const teamCache = new Map<string, Team>();
let manifestPromise: Promise<Manifest | null> | undefined;

async function getJson<T>(path: string): Promise<T> {
  const r = await fetch(base() + path, { cache: 'no-cache' });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return (await r.json()) as T;
}

export function loadManifest(): Promise<Manifest | null> {
  manifestPromise ??= getJson<Manifest>('manifest.json').catch(() => null);
  return manifestPromise;
}

export function placeholderPreviews(): TeamPreview[] {
  return TEAM_INFO.map((t) => ({ ...t, headline: [], grades: { qb: 70, ol: 70, pass: 70, rush: 70, cover: 70 }, injuries: [], baseFront: '43' }));
}

/** A full team: real players if available, otherwise placeholders. */
export async function loadTeam(abbr: string): Promise<Team> {
  const hit = teamCache.get(abbr);
  if (hit) return hit;
  let team: Team;
  try {
    team = await getJson<Team>(`teams/${abbr}.json`);
  } catch {
    const info = TEAM_INFO.find((t) => t.abbr === abbr)!;
    team = placeholderTeam(info);
  }
  teamCache.set(abbr, team);
  return team;
}

export function describeFreshness(m: Manifest): string {
  const d = new Date(m.generatedAt);
  const when = isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `Real NFL data (nflverse): ${m.season} season through week ${m.week}${when ? `, updated ${when}` : ''}`;
}
