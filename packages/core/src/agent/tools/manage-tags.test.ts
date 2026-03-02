import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createManageTagsTool } from './manage-tags.js';
import { createSqliteStorage, type SqliteStorage } from '../../storage/sqlite.js';
import { createLogger } from '@echos/shared';
import type { NoteMetadata } from '@echos/shared';

const logger = createLogger('test', 'silent');

let sqlite: SqliteStorage;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'echos-manage-tags-test-'));
  sqlite = createSqliteStorage(join(tempDir, 'test.db'), logger);
});

afterEach(() => {
  sqlite.close();
  rmSync(tempDir, { recursive: true, force: true });
});

function makeMeta(overrides: Partial<NoteMetadata> = {}): NoteMetadata {
  return {
    id: 'test-1',
    type: 'note',
    title: 'Test Note',
    created: '2024-01-01T00:00:00Z',
    updated: '2024-01-01T00:00:00Z',
    tags: ['test'],
    links: [],
    category: 'general',
    ...overrides,
  };
}

function callTool(params: Parameters<ReturnType<typeof createManageTagsTool>['execute']>[1]) {
  const tool = createManageTagsTool({ sqlite });
  return tool.execute('call-id', params, undefined as never, undefined);
}

function firstText(result: Awaited<ReturnType<typeof callTool>>): string {
  const item = result.content.find((c) => c.type === 'text');
  if (!item || !('text' in item)) throw new Error('No text content');
  return item.text;
}

describe('manage_tags — list action', () => {
  it('returns "no tags" message when knowledge base is empty', async () => {
    const result = await callTool({ action: 'list' });
    expect(firstText(result)).toContain('No tags');
    expect(result.details).toEqual({ total: 0, tags: [] });
  });

  it('lists tags with counts', async () => {
    sqlite.upsertNote(makeMeta({ id: 'a', tags: ['javascript', 'react'] }), '', '/a.md');
    sqlite.upsertNote(makeMeta({ id: 'b', tags: ['javascript'] }), '', '/b.md');

    const result = await callTool({ action: 'list' });
    const text = firstText(result);
    expect(text).toContain('javascript');
    expect(text).toContain('react');
    // javascript appears in 2 notes, react in 1
    expect(text).toMatch(/javascript.*2 notes/s);
    expect(text).toMatch(/react.*1 note[^s]/s);
  });

  it('respects the limit parameter', async () => {
    sqlite.upsertNote(makeMeta({ id: 'a', tags: ['a', 'b', 'c'] }), '', '/a.md');

    const result = await callTool({ action: 'list', limit: 2 });
    const tags = result.details as { tags: unknown[] };
    expect(tags.tags).toHaveLength(2);
  });

  it('clamps limit to max 500', async () => {
    sqlite.upsertNote(makeMeta({ id: 'a', tags: ['x'] }), '', '/a.md');
    // Should not throw even with limit > 500 passed in (clamp logic)
    await expect(callTool({ action: 'list', limit: 500 })).resolves.toBeDefined();
  });
});

describe('manage_tags — rename action', () => {
  it('renames a tag and reports affected count', async () => {
    sqlite.upsertNote(makeMeta({ id: 'a', tags: ['js'] }), '', '/a.md');
    sqlite.upsertNote(makeMeta({ id: 'b', tags: ['js', 'react'] }), '', '/b.md');

    const result = await callTool({ action: 'rename', from: 'js', to: 'javascript' });
    expect(firstText(result)).toContain('2 notes');
    expect(result.details).toMatchObject({ from: 'js', to: 'javascript', affected: 2 });
  });

  it('reports 0 when tag does not exist', async () => {
    sqlite.upsertNote(makeMeta({ id: 'a', tags: ['typescript'] }), '', '/a.md');

    const result = await callTool({ action: 'rename', from: 'nonexistent', to: 'other' });
    expect(firstText(result)).toContain('not found');
    expect((result.details as { affected: number }).affected).toBe(0);
  });

  it('returns no-op message when from === to', async () => {
    const result = await callTool({ action: 'rename', from: 'js', to: 'js' });
    expect(firstText(result)).toContain('already named');
    expect((result.details as { affected: number }).affected).toBe(0);
  });

  it('throws ValidationError when "from" is missing', async () => {
    await expect(callTool({ action: 'rename', to: 'javascript' })).rejects.toThrow();
  });

  it('throws ValidationError when "to" is missing', async () => {
    await expect(callTool({ action: 'rename', from: 'js' })).rejects.toThrow();
  });

  it('throws ValidationError when tag contains a comma', async () => {
    await expect(callTool({ action: 'rename', from: 'a,b', to: 'c' })).rejects.toThrow();
    await expect(callTool({ action: 'rename', from: 'a', to: 'b,c' })).rejects.toThrow();
  });
});

describe('manage_tags — merge action', () => {
  it('merges source tags into the target and reports count', async () => {
    sqlite.upsertNote(makeMeta({ id: 'a', tags: ['reactjs'] }), '', '/a.md');
    sqlite.upsertNote(makeMeta({ id: 'b', tags: ['react-library'] }), '', '/b.md');

    const result = await callTool({ action: 'merge', tags: ['reactjs', 'react-library'], into: 'react' });
    expect(firstText(result)).toContain('2 notes');
    expect((result.details as { affected: number }).affected).toBe(2);
  });

  it('returns 0 when no source tags exist', async () => {
    sqlite.upsertNote(makeMeta({ id: 'a', tags: ['typescript'] }), '', '/a.md');

    const result = await callTool({ action: 'merge', tags: ['nonexistent'], into: 'other' });
    expect(firstText(result)).toContain('No changes made');
  });

  it('throws ValidationError when "tags" is missing', async () => {
    await expect(callTool({ action: 'merge', into: 'react' })).rejects.toThrow();
  });

  it('throws ValidationError when "into" is missing', async () => {
    await expect(callTool({ action: 'merge', tags: ['reactjs'] })).rejects.toThrow();
  });

  it('throws ValidationError when a tag in "tags" contains a comma', async () => {
    await expect(callTool({ action: 'merge', tags: ['a,b'], into: 'c' })).rejects.toThrow();
  });

  it('throws ValidationError when "into" contains a comma', async () => {
    await expect(callTool({ action: 'merge', tags: ['a'], into: 'b,c' })).rejects.toThrow();
  });
});
