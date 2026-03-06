import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createReadingQueueTool } from './reading-queue.js';
import { createSqliteStorage, type SqliteStorage } from '../../storage/sqlite.js';
import { createLogger } from '@echos/shared';
import type { NoteMetadata } from '@echos/shared';

const logger = createLogger('test', 'silent');

let sqlite: SqliteStorage;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'echos-reading-queue-test-'));
  sqlite = createSqliteStorage(join(tempDir, 'test.db'), logger);
});

afterEach(() => {
  sqlite.close();
  rmSync(tempDir, { recursive: true, force: true });
});

function makeMeta(overrides: Partial<NoteMetadata> = {}): NoteMetadata {
  return {
    id: 'test-1',
    type: 'article',
    title: 'Test Article',
    created: '2024-01-01T00:00:00Z',
    updated: '2024-01-01T00:00:00Z',
    tags: [],
    links: [],
    category: 'general',
    status: 'saved',
    ...overrides,
  };
}

function callTool(params: Parameters<ReturnType<typeof createReadingQueueTool>['execute']>[1]) {
  const tool = createReadingQueueTool({ sqlite });
  return tool.execute('call-id', params, undefined as never, undefined);
}

function firstText(result: Awaited<ReturnType<typeof callTool>>): string {
  const item = result.content.find((c) => c.type === 'text');
  if (!item || !('text' in item)) throw new Error('No text content');
  return item.text;
}

describe('reading_queue — empty queue', () => {
  it('returns no-items message when queue is empty', async () => {
    const result = await callTool({});
    expect(firstText(result)).toContain('No unread items');
    expect(result.details).toMatchObject({ count: 0 });
  });

  it('includes type in no-items message when type filter is applied', async () => {
    const result = await callTool({ type: 'article' });
    expect(firstText(result)).toContain('No unread items');
    expect(firstText(result)).toContain('article');
  });
});

describe('reading_queue — with items', () => {
  beforeEach(() => {
    sqlite.upsertNote(makeMeta({ id: 'a1', type: 'article', title: 'Article 1', status: 'saved', created: '2024-01-01T00:00:00Z' }), '', '');
    sqlite.upsertNote(makeMeta({ id: 'y1', type: 'youtube', title: 'Video 1', status: 'saved', created: '2024-01-02T00:00:00Z' }), '', '');
    sqlite.upsertNote(makeMeta({ id: 't1', type: 'tweet', title: 'Tweet 1', status: 'saved', created: '2024-01-03T00:00:00Z' }), '', '');
    sqlite.upsertNote(makeMeta({ id: 'a2', type: 'article', title: 'Article 2', status: 'read', created: '2024-01-04T00:00:00Z' }), '', '');
  });

  it('lists only unread (saved) items', async () => {
    const result = await callTool({});
    const text = firstText(result);
    expect(text).toContain('Article 1');
    expect(text).toContain('Video 1');
    expect(text).toContain('Tweet 1');
    expect(text).not.toContain('Article 2'); // status=read, should be excluded
    expect(result.details).toMatchObject({ count: 3 });
  });

  it('filters by type', async () => {
    const result = await callTool({ type: 'article' });
    const text = firstText(result);
    expect(text).toContain('Article 1');
    expect(text).not.toContain('Video 1');
    expect(text).not.toContain('Tweet 1');
    expect(result.details).toMatchObject({ count: 1 });
  });

  it('respects the limit parameter', async () => {
    const result = await callTool({ limit: 2 });
    expect(result.details).toMatchObject({ count: 2 });
  });

  it('returns all items when limit exceeds queue size', async () => {
    const result = await callTool({ limit: 100 });
    expect(result.details).toMatchObject({ count: 3 });
  });
});
