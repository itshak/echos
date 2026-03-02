import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createManageTagsTool } from './manage-tags.js';
import { createSqliteStorage, type SqliteStorage } from '../../storage/sqlite.js';
import { createMarkdownStorage, type MarkdownStorage } from '../../storage/markdown.js';
import { createLogger } from '@echos/shared';
import type { NoteMetadata } from '@echos/shared';

const logger = createLogger('test', 'silent');

let sqlite: SqliteStorage;
let markdown: MarkdownStorage;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'echos-manage-tags-test-'));
  sqlite = createSqliteStorage(join(tempDir, 'test.db'), logger);
  markdown = createMarkdownStorage(join(tempDir, 'knowledge'), logger);
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
  const tool = createManageTagsTool({ sqlite, markdown });
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

  it('clamps limit exceeding 500 to max 500', async () => {
    const manyTags = Array.from({ length: 600 }, (_, i) => `tag-${i}`);
    sqlite.upsertNote(makeMeta({ id: 'a', tags: manyTags }), '', '/a.md');

    const result = await callTool({ action: 'list', limit: 600 });
    const tags = result.details as { tags: unknown[] };
    expect(tags.tags).toHaveLength(500);
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

  it('preserves original casing (no forced lowercase)', async () => {
    sqlite.upsertNote(makeMeta({ id: 'a', tags: ['JavaScript'] }), '', '/a.md');

    const result = await callTool({ action: 'rename', from: 'JavaScript', to: 'JS' });
    expect((result.details as { from: string; to: string }).from).toBe('JavaScript');
    expect((result.details as { from: string; to: string }).to).toBe('JS');
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

  it('syncs markdown frontmatter when file exists', async () => {
    const meta = makeMeta({ id: 'note-1', tags: ['js'] });
    const filePath = markdown.save(meta, 'content');
    sqlite.upsertNote(meta, 'content', filePath);

    await callTool({ action: 'rename', from: 'js', to: 'javascript' });

    const updated = markdown.read(filePath);
    expect(updated?.metadata.tags).toContain('javascript');
    expect(updated?.metadata.tags).not.toContain('js');
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

  it('counts distinct notes, not per-tag operations', async () => {
    // Single note with two source tags — should count as 1 affected note, not 2
    sqlite.upsertNote(makeMeta({ id: 'a', tags: ['reactjs', 'react-library'] }), '', '/a.md');

    const result = await callTool({ action: 'merge', tags: ['reactjs', 'react-library'], into: 'react' });
    expect((result.details as { affected: number }).affected).toBe(1);
    expect(firstText(result)).toContain('1 note');
  });

  it('returns 0 when no source tags exist', async () => {
    sqlite.upsertNote(makeMeta({ id: 'a', tags: ['typescript'] }), '', '/a.md');

    const result = await callTool({ action: 'merge', tags: ['nonexistent'], into: 'other' });
    expect(firstText(result)).toContain('No changes made');
  });

  it('returns no-op when all provided tags equal into', async () => {
    sqlite.upsertNote(makeMeta({ id: 'a', tags: ['react'] }), '', '/a.md');

    const result = await callTool({ action: 'merge', tags: ['react'], into: 'react' });
    expect(firstText(result)).toContain('No changes made');
    expect((result.details as { affected: number }).affected).toBe(0);
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

  it('syncs markdown frontmatter when file exists', async () => {
    const meta = makeMeta({ id: 'note-1', tags: ['reactjs'] });
    const filePath = markdown.save(meta, 'content');
    sqlite.upsertNote(meta, 'content', filePath);

    await callTool({ action: 'merge', tags: ['reactjs'], into: 'react' });

    const updated = markdown.read(filePath);
    expect(updated?.metadata.tags).toContain('react');
    expect(updated?.metadata.tags).not.toContain('reactjs');
  });
});
