import { describe, it, expect, vi } from 'vitest';
import { suggestLinks, DEFAULT_SIMILARITY_THRESHOLD } from './auto-linker.js';
import type { SqliteStorage, NoteRow } from '../storage/sqlite.js';
import type { VectorStorage, VectorSearchResult } from '../storage/vectordb.js';

// ── helpers ───────────────────────────────────────────────────────────────────

function makeNote(
  overrides: Partial<NoteRow> & { id: string; title: string },
): NoteRow {
  return {
    type: 'note',
    content: 'some content',
    filePath: '',
    tags: '',
    links: '',
    category: '',
    sourceUrl: null,
    author: null,
    gist: null,
    created: '',
    updated: '',
    contentHash: null,
    status: null,
    inputSource: null,
    imagePath: null,
    imageUrl: null,
    imageMetadata: null,
    ocrText: null,
    deletedAt: null,
    ...overrides,
  };
}

function makeSearchResult(id: string, score: number, title = 'Title'): VectorSearchResult {
  return { id, text: '', type: 'note', title, score };
}

function makeSqlite(notes: NoteRow[]): Pick<SqliteStorage, 'getNote'> {
  const map = new Map(notes.map((n) => [n.id, n]));
  return { getNote: (id: string) => map.get(id) };
}

function makeVectorStore(results: VectorSearchResult[]): Pick<VectorStorage, 'search'> {
  return { search: vi.fn().mockResolvedValue(results) };
}

const fakeEmbed = vi.fn().mockResolvedValue([0.1, 0.2, 0.3]);

// ── tests ─────────────────────────────────────────────────────────────────────

describe('suggestLinks', () => {
  it('returns empty when note does not exist', async () => {
    const sqlite = makeSqlite([]);
    const vectorStore = makeVectorStore([]);
    const result = await suggestLinks(
      'missing',
      sqlite as SqliteStorage,
      vectorStore as unknown as VectorStorage,
      fakeEmbed,
    );
    expect(result).toEqual([]);
  });

  it('excludes the source note from suggestions', async () => {
    const note = makeNote({ id: 'n1', title: 'Source' });
    const sqlite = makeSqlite([note]);
    const vectorStore = makeVectorStore([makeSearchResult('n1', 0.95)]);

    const result = await suggestLinks(
      'n1',
      sqlite as SqliteStorage,
      vectorStore as unknown as VectorStorage,
      fakeEmbed,
    );
    expect(result).toEqual([]);
  });

  it('excludes already-linked notes', async () => {
    const note = makeNote({ id: 'n1', title: 'Source', links: 'n2' });
    const target = makeNote({ id: 'n2', title: 'Linked' });
    const sqlite = makeSqlite([note, target]);
    const vectorStore = makeVectorStore([makeSearchResult('n2', 0.95)]);

    const result = await suggestLinks(
      'n1',
      sqlite as SqliteStorage,
      vectorStore as unknown as VectorStorage,
      fakeEmbed,
    );
    expect(result).toEqual([]);
  });

  it('excludes notes below the similarity threshold', async () => {
    const note = makeNote({ id: 'n1', title: 'Source' });
    const target = makeNote({ id: 'n2', title: 'Low' });
    const sqlite = makeSqlite([note, target]);
    const vectorStore = makeVectorStore([
      makeSearchResult('n2', DEFAULT_SIMILARITY_THRESHOLD - 0.01),
    ]);

    const result = await suggestLinks(
      'n1',
      sqlite as SqliteStorage,
      vectorStore as unknown as VectorStorage,
      fakeEmbed,
    );
    expect(result).toEqual([]);
  });

  it('excludes notes with the same sourceUrl', async () => {
    const note = makeNote({ id: 'n1', title: 'Source', sourceUrl: 'https://example.com/article' });
    const target = makeNote({
      id: 'n2',
      title: 'Same Source',
      sourceUrl: 'https://example.com/article',
    });
    const sqlite = makeSqlite([note, target]);
    const vectorStore = makeVectorStore([makeSearchResult('n2', 0.95)]);

    const result = await suggestLinks(
      'n1',
      sqlite as SqliteStorage,
      vectorStore as unknown as VectorStorage,
      fakeEmbed,
    );
    expect(result).toEqual([]);
  });

  it('allows notes when one has null sourceUrl', async () => {
    const note = makeNote({ id: 'n1', title: 'Source', sourceUrl: null });
    const target = makeNote({ id: 'n2', title: 'Target', sourceUrl: 'https://example.com' });
    const sqlite = makeSqlite([note, target]);
    const vectorStore = makeVectorStore([makeSearchResult('n2', 0.90)]);

    const result = await suggestLinks(
      'n1',
      sqlite as SqliteStorage,
      vectorStore as unknown as VectorStorage,
      fakeEmbed,
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.targetId).toBe('n2');
  });

  it('returns suggestions sorted by score with correct fields', async () => {
    const note = makeNote({ id: 'n1', title: 'Source', tags: 'typescript,testing' });
    const t1 = makeNote({ id: 'n2', title: 'Related A', tags: 'typescript' });
    const t2 = makeNote({ id: 'n3', title: 'Related B', category: 'dev' });
    const sqlite = makeSqlite([note, t1, t2]);
    const vectorStore = makeVectorStore([
      makeSearchResult('n2', 0.95),
      makeSearchResult('n3', 0.88),
    ]);

    const result = await suggestLinks(
      'n1',
      sqlite as SqliteStorage,
      vectorStore as unknown as VectorStorage,
      fakeEmbed,
    );

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      targetId: 'n2',
      targetTitle: 'Related A',
      similarity: 0.95,
      reason: 'shared tags: typescript',
    });
    expect(result[1]!.targetId).toBe('n3');
  });

  it('respects the limit parameter', async () => {
    const note = makeNote({ id: 'n1', title: 'Source' });
    const notes = [note];
    const searchResults: VectorSearchResult[] = [];
    for (let i = 2; i <= 10; i++) {
      const n = makeNote({ id: `n${i}`, title: `Note ${i}` });
      notes.push(n);
      searchResults.push(makeSearchResult(`n${i}`, 0.99 - i * 0.01));
    }
    const sqlite = makeSqlite(notes);
    const vectorStore = makeVectorStore(searchResults);

    const result = await suggestLinks(
      'n1',
      sqlite as SqliteStorage,
      vectorStore as unknown as VectorStorage,
      fakeEmbed,
      2,
    );
    expect(result).toHaveLength(2);
  });

  it('uses precomputed vector when provided', async () => {
    const note = makeNote({ id: 'n1', title: 'Source' });
    const target = makeNote({ id: 'n2', title: 'Target' });
    const sqlite = makeSqlite([note, target]);
    const vectorStore = makeVectorStore([makeSearchResult('n2', 0.90)]);
    const embed = vi.fn().mockResolvedValue([0.1]);

    await suggestLinks(
      'n1',
      sqlite as SqliteStorage,
      vectorStore as unknown as VectorStorage,
      embed,
      5,
      undefined,
      [0.5, 0.6, 0.7],
    );

    expect(embed).not.toHaveBeenCalled();
    expect(vectorStore.search).toHaveBeenCalledWith([0.5, 0.6, 0.7], 20);
  });

  it('respects custom similarity threshold', async () => {
    const note = makeNote({ id: 'n1', title: 'Source' });
    const target = makeNote({ id: 'n2', title: 'Target' });
    const sqlite = makeSqlite([note, target]);
    const vectorStore = makeVectorStore([makeSearchResult('n2', 0.75)]);

    // Default threshold (0.82) would exclude this
    const withDefault = await suggestLinks(
      'n1',
      sqlite as SqliteStorage,
      vectorStore as unknown as VectorStorage,
      fakeEmbed,
    );
    expect(withDefault).toHaveLength(0);

    // Lower threshold includes it
    const withLower = await suggestLinks(
      'n1',
      sqlite as SqliteStorage,
      vectorStore as unknown as VectorStorage,
      fakeEmbed,
      5,
      0.70,
    );
    expect(withLower).toHaveLength(1);
  });
});

describe('deriveReason', () => {
  it('reports shared tags', async () => {
    const note = makeNote({ id: 'n1', title: 'A', tags: 'go,rust,python' });
    const target = makeNote({ id: 'n2', title: 'B', tags: 'rust,python,java' });
    const sqlite = makeSqlite([note, target]);
    const vectorStore = makeVectorStore([makeSearchResult('n2', 0.95)]);

    const result = await suggestLinks(
      'n1',
      sqlite as SqliteStorage,
      vectorStore as unknown as VectorStorage,
      fakeEmbed,
    );
    expect(result[0]!.reason).toContain('shared tags');
    expect(result[0]!.reason).toContain('rust');
  });

  it('reports same category', async () => {
    const note = makeNote({ id: 'n1', title: 'A', category: 'engineering' });
    const target = makeNote({ id: 'n2', title: 'B', category: 'engineering' });
    const sqlite = makeSqlite([note, target]);
    const vectorStore = makeVectorStore([makeSearchResult('n2', 0.95)]);

    const result = await suggestLinks(
      'n1',
      sqlite as SqliteStorage,
      vectorStore as unknown as VectorStorage,
      fakeEmbed,
    );
    expect(result[0]!.reason).toContain('same category: engineering');
  });

  it('falls back to semantic similarity when no tags or category match', async () => {
    const note = makeNote({ id: 'n1', title: 'A' });
    const target = makeNote({ id: 'n2', title: 'B' });
    const sqlite = makeSqlite([note, target]);
    const vectorStore = makeVectorStore([makeSearchResult('n2', 0.95)]);

    const result = await suggestLinks(
      'n1',
      sqlite as SqliteStorage,
      vectorStore as unknown as VectorStorage,
      fakeEmbed,
    );
    expect(result[0]!.reason).toBe('semantically similar content');
  });

  it('combines shared tags and same category', async () => {
    const note = makeNote({ id: 'n1', title: 'A', tags: 'ts', category: 'dev' });
    const target = makeNote({ id: 'n2', title: 'B', tags: 'ts', category: 'dev' });
    const sqlite = makeSqlite([note, target]);
    const vectorStore = makeVectorStore([makeSearchResult('n2', 0.95)]);

    const result = await suggestLinks(
      'n1',
      sqlite as SqliteStorage,
      vectorStore as unknown as VectorStorage,
      fakeEmbed,
    );
    expect(result[0]!.reason).toContain('shared tags: ts');
    expect(result[0]!.reason).toContain('same category: dev');
    expect(result[0]!.reason).toContain('; ');
  });
});
