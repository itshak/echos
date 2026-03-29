import type { Logger } from 'pino';
import type { MemoryEntry } from '@echos/shared';
import type { PreparedStatements } from './sqlite-schema.js';

export interface MemoryOps {
  upsertMemory(entry: MemoryEntry): void;
  getMemory(id: string): MemoryEntry | undefined;
  listAllMemories(): MemoryEntry[];
  listTopMemories(limit: number): MemoryEntry[];
  searchMemory(query: string): MemoryEntry[];
}

function rowToMemory(row: Record<string, unknown>): MemoryEntry {
  return {
    id: row['id'] as string,
    kind: row['kind'] as MemoryEntry['kind'],
    subject: row['subject'] as string,
    content: row['content'] as string,
    confidence: row['confidence'] as number,
    source: row['source'] as string,
    created: row['created'] as string,
    updated: row['updated'] as string,
  };
}

export function createMemoryOps(
  _db: unknown,
  stmts: PreparedStatements,
  _logger: Logger,
): MemoryOps {
  return {
    upsertMemory(entry: MemoryEntry): void {
      stmts.upsertMemory.run({
        id: entry.id,
        kind: entry.kind,
        subject: entry.subject,
        content: entry.content,
        confidence: entry.confidence,
        source: entry.source,
        created: entry.created,
        updated: entry.updated,
      });
    },

    getMemory(id: string): MemoryEntry | undefined {
      const row = stmts.getMemory.get(id) as Record<string, unknown> | undefined;
      if (!row) return undefined;
      return rowToMemory(row);
    },

    listAllMemories(): MemoryEntry[] {
      const rows = stmts.listAllMemories.all() as Record<string, unknown>[];
      return rows.map(rowToMemory);
    },

    listTopMemories(limit: number): MemoryEntry[] {
      const rows = stmts.listTopMemories.all(limit) as Record<string, unknown>[];
      return rows.map(rowToMemory);
    },

    searchMemory(query: string): MemoryEntry[] {
      const seen = new Set<string>();
      const results: MemoryEntry[] = [];

      const addRows = (rows: Record<string, unknown>[]) => {
        for (const row of rows) {
          const id = row['id'] as string;
          if (!seen.has(id)) {
            seen.add(id);
            results.push(rowToMemory(row));
          }
        }
      };

      const pattern = `%${query}%`;
      addRows(stmts.searchMemory.all(pattern, pattern) as Record<string, unknown>[]);

      const words = query.split(/\s+/).filter((w) => w.length > 2);
      for (const word of words) {
        const wordPattern = `%${word}%`;
        addRows(stmts.searchMemory.all(wordPattern, wordPattern) as Record<string, unknown>[]);
      }

      return results.sort((a, b) => b.confidence - a.confidence);
    },
  };
}
