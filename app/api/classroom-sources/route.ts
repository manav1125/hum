import { promises as fs } from 'fs';
import path from 'path';

import { createLogger } from '@/lib/logger';
import { apiSuccess } from '@/lib/server/api-response';
import {
  CLASSROOMS_DIR,
  type ClassroomSource,
  type PersistedClassroomData,
} from '@/lib/server/classroom-storage';

const log = createLogger('ClassroomSourcesAPI');

export const dynamic = 'force-dynamic';

/**
 * First image reference inside a persisted classroom, as a same-origin
 * `/api/classroom-media/...` path. Matched textually rather than by walking
 * the scene schema so it survives schema evolution — the persisted JSON keeps
 * scenes in generation order, so the first match is the opening slide's art.
 * Absolute `mediaServingUrl` variants still match (the pattern is unanchored)
 * and the RELATIVE path is what gets returned, so consumers always fetch
 * through their own origin (the Cue gateway's cookie-gated shim included).
 */
const FIRST_IMAGE_RE =
  /\/api\/classroom-media\/[A-Za-z0-9_-]+\/media\/[A-Za-z0-9._-]+\.(?:png|jpe?g|webp|gif)/;

/**
 * GET /api/classroom-sources — classroom id → provenance, for classrooms that
 * declared one at generation time (see ClassroomSource), plus classroom id →
 * cover-image path for classrooms whose slides carry generated art. Built for
 * the Cue shell's Library cards ("from your chat on …" + real cover art);
 * classrooms without a source/cover are simply absent, so a consumer can only
 * ever draw provenance the creator actually stated. Server-local files only —
 * small N, read on demand.
 */
export async function GET() {
  const sources: Record<string, ClassroomSource> = {};
  const covers: Record<string, string> = {};
  try {
    const entries = await fs.readdir(CLASSROOMS_DIR).catch(() => [] as string[]);
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      try {
        const content = await fs.readFile(path.join(CLASSROOMS_DIR, entry), 'utf-8');
        const data = JSON.parse(content) as PersistedClassroomData;
        if (!data?.id) continue;
        if (data.source) sources[data.id] = data.source;
        const cover = FIRST_IMAGE_RE.exec(content)?.[0];
        if (cover) covers[data.id] = cover;
      } catch {
        // One malformed file must not empty the whole map.
      }
    }
  } catch (error) {
    log.warn('Classroom sources scan failed:', error);
  }
  return apiSuccess({ sources, covers });
}
