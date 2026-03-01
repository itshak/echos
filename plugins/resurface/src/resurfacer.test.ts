import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createSqliteStorage, type SqliteStorage } from '@echos/core';
import { createLogger } from '@echos/shared';
import { resurfaceNotes } from './resurfacer.js';

const logger = createLogger('test', 'silent');

let storage: SqliteStorage;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'echos-resurface-test-'));
  storage = createSqliteStorage(join(tempDir, 'test.db'), logger);
});

afterEach(() => {
  storage.close();
  rmSync(tempDir, { recursive: true, force: true });
});

function insertNote(
  id: string,
  opts: {
    title?: string;
    lastSurfaced?: string | null;
    status?: string;
    created?: string;
  } = {},
) {
  storage.upsertNote(
    {
      id,
      type: 'note',
      title: opts.title ?? `Note ${id}`,
      created: opts.created ?? '2023-01-01T00:00:00Z',
      updated: '2023-01-01T00:00:00Z',
      tags: [],
      links: [],
      category: 'general',
      status: (opts.status as never) ?? 'read',
    },
    `Content of ${id}`,
    `/${id}.md`,
  );
  if (opts.lastSurfaced !== undefined) {
    storage.db
      .prepare(`UPDATE notes SET last_surfaced = ? WHERE id = ?`)
      .run(opts.lastSurfaced, id);
  }
}

describe('resurfaceNotes', () => {
  it('returns notes that have never been surfaced', () => {
    insertNote('a');
    insertNote('b');

    const results = resurfaceNotes(storage, { mode: 'forgotten', limit: 10 });
    expect(results.map((r) => r.id)).toContain('a');
    expect(results.map((r) => r.id)).toContain('b');
  });

  it('filters out notes surfaced within the last 7 days', () => {
    const recentlyStr = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    insertNote('recent', { lastSurfaced: recentlyStr });
    insertNote('old', { lastSurfaced: null });

    const results = resurfaceNotes(storage, { mode: 'forgotten', limit: 10 });
    const ids = results.map((r) => r.id);
    expect(ids).not.toContain('recent');
    expect(ids).toContain('old');
  });

  it('filters out archived notes', () => {
    insertNote('archived', { status: 'archived' });
    insertNote('readable', { status: 'read' });

    const results = resurfaceNotes(storage, { mode: 'forgotten', limit: 10 });
    const ids = results.map((r) => r.id);
    expect(ids).not.toContain('archived');
    expect(ids).toContain('readable');
  });

  it('updates last_surfaced for all returned notes', () => {
    insertNote('x');
    insertNote('y');

    const before = storage.db
      .prepare(`SELECT last_surfaced FROM notes WHERE id = 'x'`)
      .get() as { last_surfaced: string | null };
    expect(before.last_surfaced).toBeNull();

    resurfaceNotes(storage, { mode: 'forgotten', limit: 2 });

    const after = storage.db
      .prepare(`SELECT last_surfaced FROM notes WHERE id = 'x'`)
      .get() as { last_surfaced: string | null };
    expect(after.last_surfaced).not.toBeNull();
  });

  it('deduplicates between forgotten and on_this_day in mix mode', () => {
    // Insert a note created on today's month-day in a prior year
    const now = new Date();
    const pastYear = now.getFullYear() - 1;
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    insertNote('overlap', { created: `${pastYear}-${month}-${day}T00:00:00Z` });

    const results = resurfaceNotes(storage, { mode: 'mix', limit: 10 });
    const ids = results.map((r) => r.id);
    // The note should appear at most once
    expect(ids.filter((id) => id === 'overlap').length).toBeLessThanOrEqual(1);
  });

  it('returns empty array when no eligible notes exist', () => {
    const results = resurfaceNotes(storage, { mode: 'mix' });
    expect(results).toHaveLength(0);
  });

  it('respects the limit parameter', () => {
    for (let i = 0; i < 10; i++) insertNote(`note-${i}`);

    const results = resurfaceNotes(storage, { mode: 'forgotten', limit: 3 });
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it('random mode returns notes and updates last_surfaced', () => {
    insertNote('r1');
    insertNote('r2');

    const results = resurfaceNotes(storage, { mode: 'random', limit: 2 });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((r) => r.reason === 'random')).toBe(true);

    const row = storage.db
      .prepare(`SELECT last_surfaced FROM notes WHERE id = ?`)
      .get(results[0]!.id) as { last_surfaced: string | null };
    expect(row.last_surfaced).not.toBeNull();
  });
});
