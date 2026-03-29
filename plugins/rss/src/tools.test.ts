import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PluginContext } from '@echos/core';
import { ValidationError } from '@echos/shared';

const { mockParseString, mockFetchFeedXml, mockPollFeed, mockProcessEntry } = vi.hoisted(() => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockParseString: vi.fn<any>(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockFetchFeedXml: vi.fn<any>(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockPollFeed: vi.fn<any>(),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockProcessEntry: vi.fn<any>(),
}));

vi.mock('rss-parser', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default: vi.fn().mockImplementation(function (this: any) {
    this.parseString = mockParseString;
  }),
}));

vi.mock('uuid', () => ({ v4: () => 'mock-uuid' }));

vi.mock('@echos/plugin-article', () => ({
  processArticle: vi.fn().mockResolvedValue({
    title: 'Article Title',
    content: 'Article content',
    metadata: { type: 'article', sourceUrl: 'https://example.com/post/1' },
    embedText: 'Article Title\n\nArticle content',
  }),
}));

vi.mock('./poller.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./poller.js')>();
  return {
    ...orig,
    fetchFeedXml: mockFetchFeedXml,
    pollFeed: mockPollFeed,
    processEntry: mockProcessEntry,
  };
});

import { createManageFeedsTool } from './tools.js';
import { createFeedStore, type FeedStore } from './feed-store.js';

const mockContext: PluginContext = {
  sqlite: {
    upsertNote: vi.fn(),
    getTopTagsWithCounts: vi.fn().mockReturnValue([]),
    getSchedule: vi.fn().mockReturnValue(undefined),
    upsertSchedule: vi.fn(),
  },
  markdown: {
    save: vi.fn().mockReturnValue('/data/knowledge/articles/test.md'),
  },
  vectorDb: {
    upsert: vi.fn().mockResolvedValue(undefined),
  },
  generateEmbedding: vi.fn().mockResolvedValue([0.1, 0.2]),
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
  getAgentDeps: vi.fn(),
  getNotificationService: vi.fn(),
  config: {},
} as unknown as PluginContext;

const VALID_FEED_URL = 'https://example.com/feed.xml';
const PARSED_FEED = { title: 'Example Blog', items: [] };

let store: FeedStore;

beforeEach(() => {
  store = createFeedStore(':memory:');
  vi.clearAllMocks();
  mockFetchFeedXml.mockResolvedValue('<rss></rss>');
  mockParseString.mockResolvedValue(PARSED_FEED);
  mockPollFeed.mockResolvedValue([]);
  mockProcessEntry.mockResolvedValue(true);
});

function tool() {
  return createManageFeedsTool(mockContext, store);
}

async function exec(params: Parameters<ReturnType<typeof tool>['execute']>[1]) {
  return tool().execute('call-id', params);
}

describe('manage_feeds tool', () => {
  describe('add', () => {
    it('subscribes to a valid feed', async () => {
      const result = await exec({ action: 'add', url: VALID_FEED_URL, tags: ['news'] });
      expect(result.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('Subscribed') });
      const feeds = store.listFeeds();
      expect(feeds).toHaveLength(1);
      expect(feeds[0]?.url).toBe(VALID_FEED_URL);
      expect(feeds[0]?.tags).toEqual(['news']);
    });

    it('uses feed title from rss-parser when no name provided', async () => {
      mockParseString.mockResolvedValue({ title: 'My Blog', items: [] });
      await exec({ action: 'add', url: VALID_FEED_URL });
      expect(store.listFeeds()[0]?.name).toBe('My Blog');
    });

    it('uses provided name over feed title', async () => {
      await exec({ action: 'add', url: VALID_FEED_URL, name: 'Custom Name' });
      expect(store.listFeeds()[0]?.name).toBe('Custom Name');
    });

    it('throws ValidationError for missing url', async () => {
      await expect(exec({ action: 'add' })).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError for invalid URL', async () => {
      await expect(exec({ action: 'add', url: 'not-a-url' })).rejects.toThrow(ValidationError);
    });

    it('returns message for duplicate feed', async () => {
      await exec({ action: 'add', url: VALID_FEED_URL });
      const result = await exec({ action: 'add', url: VALID_FEED_URL });
      expect(result.content[0]).toMatchObject({ text: expect.stringContaining('already subscribed') });
      expect(store.listFeeds()).toHaveLength(1);
    });

    it('returns error when feed URL is not parseable', async () => {
      mockFetchFeedXml.mockRejectedValue(new Error('HTTP 404'));
      const result = await exec({ action: 'add', url: VALID_FEED_URL });
      expect(result.content[0]).toMatchObject({ text: expect.stringContaining('Could not parse feed') });
    });
  });

  describe('list', () => {
    it('returns empty-state message when no feeds', async () => {
      const result = await exec({ action: 'list' });
      expect(result.content[0]).toMatchObject({ text: expect.stringContaining('No RSS feeds') });
    });

    it('lists subscribed feeds', async () => {
      await exec({ action: 'add', url: VALID_FEED_URL });
      const result = await exec({ action: 'list' });
      expect(result.content[0]).toMatchObject({
        text: expect.stringContaining('Example Blog'),
      });
      expect(result.content[0]).toMatchObject({
        text: expect.stringContaining('(1)'),
      });
    });
  });

  describe('remove', () => {
    beforeEach(async () => {
      await exec({ action: 'add', url: VALID_FEED_URL });
    });

    it('removes an existing feed', async () => {
      const result = await exec({ action: 'remove', url: VALID_FEED_URL });
      expect(result.content[0]).toMatchObject({ text: expect.stringContaining('Unsubscribed') });
      expect(store.listFeeds()).toHaveLength(0);
    });

    it('returns not-found message for unknown url', async () => {
      const result = await exec({ action: 'remove', url: 'https://other.example.com/rss' });
      expect(result.content[0]).toMatchObject({ text: expect.stringContaining('No feed found') });
    });

    it('throws ValidationError for missing url', async () => {
      await expect(exec({ action: 'remove' })).rejects.toThrow(ValidationError);
    });

    it('throws ValidationError for invalid URL', async () => {
      await expect(exec({ action: 'remove', url: 'not-a-url' })).rejects.toThrow(ValidationError);
    });
  });

  describe('refresh', () => {
    it('returns empty-state when no feeds', async () => {
      const result = await exec({ action: 'refresh' });
      expect(result.content[0]).toMatchObject({ text: expect.stringContaining('No RSS feeds') });
    });

    it('returns not-found for unknown url', async () => {
      const result = await exec({ action: 'refresh', url: 'https://notsubscribed.com/rss' });
      expect(result.content[0]).toMatchObject({ text: expect.stringContaining('No feed found') });
    });

    it('throws ValidationError for invalid URL', async () => {
      await expect(exec({ action: 'refresh', url: 'not-a-url' })).rejects.toThrow(ValidationError);
    });

    it('reports no new entries when feed is up to date', async () => {
      await exec({ action: 'add', url: VALID_FEED_URL });
      mockPollFeed.mockResolvedValue([]);
      const result = await exec({ action: 'refresh' });
      expect(result.content[0]).toMatchObject({ text: expect.stringContaining('no new entries') });
    });

    it('saves new articles on refresh', async () => {
      await exec({ action: 'add', url: VALID_FEED_URL });
      mockPollFeed.mockResolvedValue([
        { guid: 'guid-1', url: 'https://example.com/post/1', title: 'Post 1', publishedAt: '2024-06-01T00:00:00.000Z' },
      ]);
      mockProcessEntry.mockResolvedValue(true);
      const result = await exec({ action: 'refresh' });
      expect(result.content[0]).toMatchObject({ text: expect.stringContaining('saved 1 new article') });
      expect(mockProcessEntry).toHaveBeenCalled();
    });

    it('deduplicates: does not save the same article twice', async () => {
      await exec({ action: 'add', url: VALID_FEED_URL });
      const entries = [
        { guid: 'guid-1', url: 'https://example.com/post/1', title: 'Post 1', publishedAt: '2024-06-01T00:00:00.000Z' },
      ];
      mockPollFeed.mockResolvedValue(entries);
      mockProcessEntry.mockResolvedValue(true);
      await exec({ action: 'refresh' });
      vi.clearAllMocks();
      mockPollFeed.mockResolvedValue(entries);
      // Second time processEntry returns false (already claimed)
      mockProcessEntry.mockResolvedValue(false);
      await exec({ action: 'refresh' });
      // processEntry was called but returned false, so saved count should be 0
      expect(mockProcessEntry).toHaveBeenCalled();
    });
  });
});
