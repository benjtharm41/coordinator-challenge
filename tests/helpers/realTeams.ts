// Loads the generated real-team files from disk (for tests and scripts; the browser fetches them instead).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Team } from '../../src/engine/types';

export const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public', 'data');

export const hasRealData = () => existsSync(join(DATA_DIR, 'manifest.json'));

export function loadRealTeams(): Team[] {
  const dir = join(DATA_DIR, 'teams');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Team);
}
