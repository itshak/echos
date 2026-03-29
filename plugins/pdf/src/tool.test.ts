import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PluginContext } from '@echos/core';

// Hoisted so the vi.mock factory below can reference it
const { mockParsePdf } = vi.hoisted(() => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockParsePdf: vi.fn<any>(),
}));

vi.mock('node:module', () => ({
  createRequire: () => () => mockParsePdf,
}));

vi.mock('uuid', () => ({
  v4: () => 'mock-uuid-5678',
}));

import { createSavePdfTool } from './tool.js';

const mockContext: PluginContext = {
  sqlite: {
    upsertNote: vi.fn(),
    getTopTagsWithCounts: vi.fn().mockReturnValue([]),
  },
  markdown: {
    save: vi.fn().mockReturnValue('/data/knowledge/articles/mock-file.md'),
  },
  vectorDb: {
    upsert: vi.fn().mockResolvedValue(undefined),
  },
  generateEmbedding: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
  config: {},
} as unknown as PluginContext;

type MockFetchOptions = {
  ok?: boolean;
  status?: number;
  statusText?: string;
  contentType?: string | null;
  contentLength?: string | null;
};

function makeFetchResponse(opts: MockFetchOptions = {}) {
  const { ok = true, status = 200, statusText = 'OK', contentType = 'application/pdf', contentLength = null } = opts;
  return {
    ok,
    status,
    statusText,
    headers: {
      get: (name: string) => {
        if (name === 'content-type') return contentType;
        if (name === 'content-length') return contentLength;
        return null;
      },
    },
    arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(100)),
  };
}

/** Extract text from the first content item (always TextContent in this tool). */
function firstText(result: Awaited<ReturnType<ReturnType<typeof createSavePdfTool>['execute']>>): string {
  const item = result.content[0];
  if (!item || item.type !== 'text') throw new Error('Expected text content');
  return item.text;
}

describe('createSavePdfTool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
  });

  it('creates tool with correct name and label', () => {
    const tool = createSavePdfTool(mockContext);
    expect(tool.name).toBe('save_pdf');
    expect(tool.label).toBe('Save PDF');
  });

  it('saves a PDF and returns id, pages, and category', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(makeFetchResponse());
    mockParsePdf.mockResolvedValue({ text: 'Hello world PDF content', numpages: 3, info: { Title: 'Test Doc', Author: 'Alice' } });

    const tool = createSavePdfTool(mockContext);
    const result = await tool.execute('call-1', { url: 'https://example.com/test.pdf' }, undefined as unknown as AbortSignal, vi.fn());

    expect(mockContext.markdown.save).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'article', title: 'Test Doc', author: 'Alice', inputSource: 'file' }),
      expect.any(String),
    );
    expect(mockContext.sqlite.upsertNote).toHaveBeenCalled();
    expect(mockContext.generateEmbedding).toHaveBeenCalled();
    const text = firstText(result);
    expect(text).toContain('mock-uuid-5678');

    expect(text).toContain('Pages: 3');
    expect(text).toContain('Category: articles');
  });

  it('returns an error on HTTP failure', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(makeFetchResponse({ ok: false, status: 404, statusText: 'Not Found' }));

    const tool = createSavePdfTool(mockContext);
    const result = await tool.execute('call-2', { url: 'https://example.com/missing.pdf' }, undefined as unknown as AbortSignal, vi.fn());

    expect(firstText(result)).toContain('Failed to download PDF');
    expect(firstText(result)).toContain('404');
    expect(mockContext.markdown.save).not.toHaveBeenCalled();
  });

  it('returns an error on password-protected PDF', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(makeFetchResponse());
    mockParsePdf.mockRejectedValue(new Error('PDF is password protected'));

    const tool = createSavePdfTool(mockContext);
    const result = await tool.execute('call-3', { url: 'https://example.com/locked.pdf' }, undefined as unknown as AbortSignal, vi.fn());

    expect(firstText(result)).toContain('password-protected');
    expect(mockContext.markdown.save).not.toHaveBeenCalled();
  });

  it('returns an error on encrypted PDF', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(makeFetchResponse());
    mockParsePdf.mockRejectedValue(new Error('Document is encrypted'));

    const tool = createSavePdfTool(mockContext);
    const result = await tool.execute('call-3b', { url: 'https://example.com/encrypted.pdf' }, undefined as unknown as AbortSignal, vi.fn());

    expect(firstText(result)).toContain('password-protected');
  });

  it('returns an error when no text can be extracted (image-only PDF)', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(makeFetchResponse());
    mockParsePdf.mockResolvedValue({ text: '   ', numpages: 1, info: {} });

    const tool = createSavePdfTool(mockContext);
    const result = await tool.execute('call-4', { url: 'https://example.com/scan.pdf' }, undefined as unknown as AbortSignal, vi.fn());

    expect(firstText(result)).toContain('No text could be extracted');
    expect(mockContext.markdown.save).not.toHaveBeenCalled();
  });

  it('truncates content exceeding MAX_CHARS and appends notice', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(makeFetchResponse());
    mockParsePdf.mockResolvedValue({ text: 'A'.repeat(600_000), numpages: 10, info: {} });

    const tool = createSavePdfTool(mockContext);
    const result = await tool.execute('call-5', { url: 'https://example.com/big.pdf' }, undefined as unknown as AbortSignal, vi.fn());

    expect(firstText(result)).toContain('truncated');
    const savedContent: string = (mockContext.markdown.save as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(savedContent).toContain('[content truncated due to size limit]');
  });

  it('falls back to URL pathname as title when PDF has no Title metadata', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(makeFetchResponse());
    mockParsePdf.mockResolvedValue({ text: 'Some content', numpages: 1, info: {} });

    const tool = createSavePdfTool(mockContext);
    await tool.execute('call-6', { url: 'https://example.com/my-document.pdf' }, undefined as unknown as AbortSignal, vi.fn());

    expect(mockContext.markdown.save).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'my-document' }),
      expect.any(String),
    );
  });

  it('strips query string from URL when deriving filename title', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(makeFetchResponse());
    mockParsePdf.mockResolvedValue({ text: 'Some content', numpages: 1, info: {} });

    const tool = createSavePdfTool(mockContext);
    await tool.execute('call-7', { url: 'https://example.com/report.pdf?token=abc123&v=2' }, undefined as unknown as AbortSignal, vi.fn());

    expect(mockContext.markdown.save).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'report' }),
      expect.any(String),
    );
  });

  it('rejects oversized PDF via content-length before buffering', async () => {
    const oversizeBytes = (11 * 1024 * 1024).toString(); // 11 MiB > 10 MiB limit
    const mockResponse = makeFetchResponse({ contentLength: oversizeBytes });
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(mockResponse);

    const tool = createSavePdfTool(mockContext);
    const result = await tool.execute('call-8', { url: 'https://example.com/huge.pdf' }, undefined as unknown as AbortSignal, vi.fn());

    expect(firstText(result)).toContain('too large');
    expect(mockResponse.arrayBuffer).not.toHaveBeenCalled();
    expect(mockContext.markdown.save).not.toHaveBeenCalled();
  });

  it('uses explicit title param over PDF Title metadata', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(makeFetchResponse());
    mockParsePdf.mockResolvedValue({ text: 'Content', numpages: 1, info: { Title: 'Metadata Title' } });

    const tool = createSavePdfTool(mockContext);
    await tool.execute('call-9', { url: 'https://example.com/doc.pdf', title: 'My Override' }, undefined as unknown as AbortSignal, vi.fn());

    expect(mockContext.markdown.save).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'My Override' }),
      expect.any(String),
    );
  });

  it('handles embedding failure gracefully (note is still saved)', async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue(makeFetchResponse());
    mockParsePdf.mockResolvedValue({ text: 'Content', numpages: 1, info: {} });
    const ctx = { ...mockContext, generateEmbedding: vi.fn().mockRejectedValue(new Error('Embedding down')) } as unknown as PluginContext;

    const tool = createSavePdfTool(ctx);
    const result = await tool.execute('call-10', { url: 'https://example.com/doc.pdf' }, undefined as unknown as AbortSignal, vi.fn());

    expect(firstText(result)).toContain('Saved PDF');
    expect(mockContext.markdown.save).toHaveBeenCalled();
  });
});
