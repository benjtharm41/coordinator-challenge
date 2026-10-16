// Placeholder rosters for Phase 1: real team names, colors and head coaches,
// made-up players. Phase 3 replaces these with real nflverse data.
import teamsJson from './data/teams.json';
import { clamp, Rng } from './rng';
import type { Coverage, DepthChart, Player, PlayerRatings, Pos, Team, TeamInfo } from './types';

export const TEAM_INFO: TeamInfo[] = teamsJson as TeamInfo[];

const FIRST = ['James', 'Marcus', 'Tyler', 'Jalen', 'Chris', 'DeShawn', 'Mike', 'Brandon', 'Josh', 'Kyle', 'Darius', 'Andre', 'Cole', 'Trey',
  'Malik', 'Jordan', 'Devin', 'Caleb', 'Isaiah', 'Ryan', 'Derek', 'Xavier', 'Luke', 'Nate', 'Terrell', 'Bryce', 'Jamal', 'Owen', 'Zach',
  'Quinn', 'Elijah', 'Cam', 'Dante', 'Reggie', 'Hunter', 'Evan', 'Tre', 'Garrett', 'Omar', 'Sam', 'Jace', 'Kendall', 'Logan', 'Myles',
  'Damon', 'Aaron', 'Tony', 'Corey', 'Ty', 'Will', 'Jaylen', 'Keenan', 'Austin', 'Brett', 'Mason', 'Rashad', 'Colby', 'Jerome', 'Drew', 'Victor'];
const LAST = ['Johnson', 'Williams', 'Brown', 'Jackson', 'Davis', 'Miller', 'Wilson', 'Moore', 'Taylor', 'Thomas', 'Harris', 'Martin',
  'Thompson', 'Robinson', 'Clark', 'Lewis', 'Walker', 'Hall', 'Allen', 'Young', 'King', 'Wright', 'Scott', 'Green', 'Baker', 'Adams',
  'Nelson', 'Carter', 'Mitchell', 'Roberts', 'Turner', 'Phillips', 'Campbell', 'Parker', 'Evans', 'Edwards', 'Collins', 'Stewart',
  'Morris', 'Rogers', 'Reed', 'Cook', 'Morgan', 'Bell', 'Murphy', 'Bailey', 'Cooper', 'Richardson', 'Cox', 'Howard', 'Ward', 'Peterson',
  'Gray', 'James', 'Watson', 'Brooks', 'Kelly', 'Sanders', 'Price', 'Bennett', 'Wood', 'Barnes', 'Ross', 'Henderson', 'Coleman',
  'Jenkins', 'Perry', 'Powell', 'Long', 'Patterson', 'Hughes', 'Washington', 'Butler', 'Simmons', 'Foster', 'Bryant', 'Alexander',
  'Russell', 'Griffin', 'Hayes', 'Myers', 'Ford', 'Hamilton', 'Graham', 'Sullivan', 'Wallace', 'Woods', 'Cole', 'West', 'Owens',
  'Reynolds', 'Fisher', 'Ellis', 'Harrison', 'Gibson', 'Mcdonald', 'Cruz', 'Marshall', 'Gordon', 'Stone', 'Hunt', 'Knight', 'Dixon'];

const ROSTER: [Pos, number][] = [
  ['QB', 2], ['RB', 3], ['FB', 1], ['WR', 5], ['TE', 3], ['OL', 7], ['DL', 4], ['EDGE', 4], ['LB', 4], ['CB', 5], ['S', 4], ['K', 1], ['P', 1],
];

const NUMBERS: Record<Pos, number[][]> = {
  QB: [[1, 19]], RB: [[20, 39]], FB: [[40, 49]], WR: [[10, 19], [80, 89]], TE: [[80, 89], [40, 49]], OL: [[60, 79]],
  DL: [[90, 99], [60, 69]], EDGE: [[90, 99], [50, 59]], LB: [[40, 59]], CB: [[20, 39], [0, 9]], S: [[20, 49]], K: [[1, 19]], P: [[1, 19]],
};

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function subRatings(rng: Rng, pos: Pos, ovr: number): PlayerRatings {
  const v = (spread = 6) => Math.round(clamp(rng.normal(ovr, spread), 40, 99));
  switch (pos) {
    case 'QB': return { acc: v(), deep: v(7), dec: v(7), pocket: v(7), mob: v(12) };
    case 'RB': return { rush: v(), catch: v(10), route: v(10), yac: v(), pblk: v(10) };
    case 'FB': return { rblk: v(), pblk: v(), catch: v(10), rush: v(10) };
    case 'WR': return { route: v(), catch: v(), yac: v(8), rblk: v(10) };
    case 'TE': return { route: v(8), catch: v(), yac: v(8), rblk: v(8), pblk: v(8) };
    case 'OL': return { pblk: v(5), rblk: v(5) };
    case 'DL': return { rush: v(8), run: v(5) };
    case 'EDGE': return { rush: v(5), run: v(8) };
    case 'LB': return { run: v(5), cover: v(8), rush: v(10) };
    case 'CB': return { cover: v(5), ball: v(8), run: v(10) };
    case 'S': return { cover: v(6), ball: v(8), run: v(7) };
    case 'K': return { kacc: v(6), leg: v(8) };
    case 'P': return { leg: v(6) };
  }
}

const OFF_POS = new Set<Pos>(['QB', 'RB', 'FB', 'WR', 'TE', 'OL']);

export function placeholderTeam(info: TeamInfo): Team {
  const rng = new Rng(hash(info.abbr) || 1);
  const offStrength = clamp(rng.normal(70, 4.5), 60, 80);
  const defStrength = clamp(rng.normal(70, 4.5), 60, 80);
  const used = new Set<number>();
  const players: Player[] = [];
  const depth: DepthChart = { QB: [], RB: [], FB: [], WR: [], TE: [], OL: [], DL: [], EDGE: [], LB: [], CB: [], S: [], K: [], P: [] };

  for (const [pos, count] of ROSTER) {
    for (let i = 0; i < count; i++) {
      // Starters near team strength, backups lower. QBs vary the most.
      const strength = OFF_POS.has(pos) ? offStrength : pos === 'K' || pos === 'P' ? 68 : defStrength;
      const starterSlots = pos === 'OL' ? 5 : pos === 'WR' ? 3 : pos === 'CB' ? 3 : pos === 'DL' || pos === 'EDGE' || pos === 'S' ? 2 : pos === 'LB' ? 3 : 1;
      const drop = i < starterSlots ? 0 : 7 + (i - starterSlots) * 3;
      const spread = pos === 'QB' ? 7 : 5;
      const ovr = Math.round(clamp(rng.normal(strength - drop + (i === 0 ? 2 : 0), spread), 45, 97));
      let num = 0;
      for (let tries = 0; tries < 50; tries++) {
        const [lo, hi] = rng.pick(NUMBERS[pos]);
        num = rng.int(lo, hi);
        if (!used.has(num)) break;
      }
      used.add(num);
      const p: Player = {
        id: `${info.abbr}-${pos}-${i}`,
        name: `${rng.pick(FIRST)} ${rng.pick(LAST)}`,
        pos, num, ovr, r: subRatings(rng, pos, ovr),
      };
      players.push(p);
      depth[pos].push(p.id);
    }
  }
  // Depth chart order = best first.
  const byId = new Map(players.map((p) => [p.id, p]));
  for (const k of Object.keys(depth) as Pos[]) depth[k].sort((a, b) => byId.get(b)!.ovr - byId.get(a)!.ovr);

  const coverage: Record<Coverage, number> = {
    c0: 0.04 * rng.range(0.5, 1.6), c1: 0.22 * rng.range(0.7, 1.4), c2: 0.13 * rng.range(0.6, 1.5), c2m: 0.05 * rng.range(0.4, 1.8),
    c3: 0.31 * rng.range(0.7, 1.3), c4: 0.16 * rng.range(0.6, 1.5), c6: 0.09 * rng.range(0.5, 1.6),
  };
  return {
    info,
    players,
    depth,
    source: 'placeholder',
    tendencies: {
      off: {
        proe: rng.normal(0, 0.18), shotgun: clamp(rng.normal(0.65, 0.12), 0.35, 0.9), playAction: clamp(rng.normal(1, 0.25), 0.5, 1.6),
        noHuddle: clamp(rng.normal(0.09, 0.05), 0.01, 0.3), motion: clamp(rng.normal(0.45, 0.12), 0.15, 0.75),
        deepShot: clamp(rng.normal(1, 0.15), 0.6, 1.4), screen: clamp(rng.normal(1, 0.2), 0.5, 1.6),
      },
      def: { baseFront: rng.chance(0.5) ? '34' : '43', blitz: clamp(rng.normal(0.24, 0.06), 0.1, 0.42), coverage },
    },
  };
}

let cache: Team[] | undefined;
export function allPlaceholderTeams(): Team[] {
  cache ??= TEAM_INFO.map(placeholderTeam);
  return cache;
}
