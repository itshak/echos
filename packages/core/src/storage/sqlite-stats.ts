import type Database from 'better-sqlite3';
import type { Logger } from 'pino';
import type { PreparedStatements } from './sqlite-schema.js';

export interface StatsOps {
  getTopTagsWithCounts(limit: number): { tag: string; count: number }[];
  renameTag(from: string, to: string): number;
  mergeTags(tags: string[], into: string): number;
  getAgentVoice(): string | null;
  setAgentVoice(instruction: string): void;
  getContentTypeCounts(): Record<string, number>;
  getStatusCounts(): Record<string, number>;
  getDistinctTagCount(): number;
  getLinkCount(): number;
  getWeeklyCreationCounts(weeks: number): { week: string; count: number }[];
  getCategoryFrequencies(limit: number): { category: string; count: number }[];
}

export function createStatsOps(
  db: Database.Database,
  stmts: PreparedStatements,
  _logger: Logger,
): StatsOps {
  return {
    getTopTagsWithCounts(limit: number): { tag: string; count: number }[] {
      return stmts.getTopTagsWithCounts.all(limit) as { tag: string; count: number }[];
    },

    renameTag(from: string, to: string): number {
      const now = new Date().toISOString();
      const info = stmts.renameTag.run(from, to, now, from) as Database.RunResult;
      return info.changes;
    },

    mergeTags(tags: string[], into: string): number {
      return db.transaction((): number => {
        const now = new Date().toISOString();
        let totalUpdates = 0;
        for (const from of tags) {
          if (from === into) continue;
          const info = stmts.renameTag.run(from, into, now, from) as Database.RunResult;
          totalUpdates += info.changes;
        }
        return totalUpdates;
      })();
    },

    getAgentVoice(): string | null {
      const row = stmts.getPreference.get('agent_voice') as { value: string } | undefined;
      return row?.value ?? null;
    },

    setAgentVoice(instruction: string): void {
      stmts.setPreference.run('agent_voice', instruction, new Date().toISOString());
    },

    getContentTypeCounts(): Record<string, number> {
      const rows = db
        .prepare(
          `SELECT type, COUNT(*) AS count FROM notes
           WHERE status IS NULL OR status != 'deleted'
           GROUP BY type`,
        )
        .all() as { type: string; count: number }[];
      const result: Record<string, number> = {};
      for (const row of rows) {
        result[row.type] = row.count;
      }
      return result;
    },

    getStatusCounts(): Record<string, number> {
      const row = db
        .prepare(
          `SELECT
            SUM(CASE WHEN status = 'saved'    THEN 1 ELSE 0 END) AS saved,
            SUM(CASE WHEN status = 'read'     THEN 1 ELSE 0 END) AS read,
            SUM(CASE WHEN status = 'archived' THEN 1 ELSE 0 END) AS archived,
            SUM(CASE WHEN status IS NULL      THEN 1 ELSE 0 END) AS unset
           FROM notes WHERE status IS NULL OR status != 'deleted'`,
        )
        .get() as {
        saved: number | null;
        read: number | null;
        archived: number | null;
        unset: number | null;
      };
      return {
        saved: row.saved ?? 0,
        read: row.read ?? 0,
        archived: row.archived ?? 0,
        unset: row.unset ?? 0,
      };
    },

    getDistinctTagCount(): number {
      const row = db
        .prepare(
          `WITH RECURSIVE
            all_tags(tag, rest) AS (
              SELECT
                CASE WHEN instr(tags || ',', ',') > 0
                     THEN substr(tags || ',', 1, instr(tags || ',', ',') - 1)
                     ELSE tags END,
                CASE WHEN instr(tags || ',', ',') > 0
                     THEN substr(tags || ',', instr(tags || ',', ',') + 1)
                     ELSE '' END
              FROM notes WHERE tags != '' AND (status IS NULL OR status != 'deleted')
              UNION ALL
              SELECT
                CASE WHEN instr(rest, ',') > 0
                     THEN substr(rest, 1, instr(rest, ',') - 1)
                     ELSE rest END,
                CASE WHEN instr(rest, ',') > 0
                     THEN substr(rest, instr(rest, ',') + 1)
                     ELSE '' END
              FROM all_tags WHERE rest != ''
            )
          SELECT COUNT(DISTINCT tag) AS distinctTags FROM all_tags WHERE tag != ''`,
        )
        .get() as { distinctTags: number };
      return row.distinctTags ?? 0;
    },

    getLinkCount(): number {
      const row = db
        .prepare(
          `SELECT SUM(
            CASE
              WHEN links IS NULL OR links = '' THEN 0
              ELSE LENGTH(links) - LENGTH(REPLACE(links, ',', '')) + 1
            END
           ) AS linkCount
           FROM notes WHERE status IS NULL OR status != 'deleted'`,
        )
        .get() as { linkCount: number | null };
      return row.linkCount ?? 0;
    },

    getWeeklyCreationCounts(weeks: number): { week: string; count: number }[] {
      const cutoff = new Date(Date.now() - weeks * 7 * 24 * 60 * 60 * 1000).toISOString();
      return db
        .prepare(
          `SELECT strftime('%Y-W%W', created) AS week, COUNT(*) AS count
           FROM notes
           WHERE created >= ? AND (status IS NULL OR status != 'deleted')
           GROUP BY week
           ORDER BY week ASC`,
        )
        .all(cutoff) as { week: string; count: number }[];
    },

    getCategoryFrequencies(limit: number): { category: string; count: number }[] {
      return db
        .prepare(
          `SELECT category, COUNT(*) AS count
           FROM notes
           WHERE category != '' AND (status IS NULL OR status != 'deleted')
           GROUP BY category
           ORDER BY count DESC, category ASC
           LIMIT ?`,
        )
        .all(limit) as { category: string; count: number }[];
    },
  };
}
