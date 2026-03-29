import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PluginContext } from '@echos/core';

const { mockParseURL } = vi.hoisted(() => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockParseURL: vi.fn<any>(),
}));

vi.mock('rss-parser', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  default: vi.fn().mockImplementation(function (this: any) {
    this.parseURL = mockParseURL;
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
  mockParseURL.mockResolvedValue(PARSED_FEED);
  vi.clearAllMocks();
  mockParseURL.mockResolvedValue(PARSED_FEED);
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
      mockParseURL.mockResolvedValue({ title: 'My Blog', items: [] });
      await exec({ action: 'add', url: VALID_FEED_URL });
      expect(store.listFeeds()[0]?.name).toBe('My Blog');
    });

    it('uses provided name over feed title', async () => {
      await exec({ action: 'add', url: VALID_FEED_URL, name: 'Custom Name' });
      expect(store.listFeeds()[0]?.name).toBe('Custom Name');
    });

    it('returns error for missing url', async () => {
      const result = await exec({ action: 'add' });
      expect(result.content[0]).toMatchObject({ text: expect.stringContaining('url is required') });
    });

    it('returns error for invalid URL', async () => {
      const result = await exec({ action: 'add', url: 'not-a-url' });
      expect(result.content[0]).toMatchObject({ text: expect.stringContaining('Invalid URL') });
    });

    it('returns message for duplicate feed', async () => {
      await exec({ action: 'add', url: VALID_FEED_URL });
      const result = await exec({ action: 'add', url: VALID_FEED_URL });
      expect(result.content[0]).toMatchObject({ text: expect.stringContaining('already subscribed') });
      expect(store.listFeeds()).toHaveLength(1);
    });

    it('returns error when feed URL is not parseable', async () => {
      mockParseURL.mockRejectedValue(new Error('HTTP 404'));
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

    it('returns error for missing url', async () => {
      const result = await exec({ action: 'remove' });
      expect(result.content[0]).toMatchObject({ text: expect.stringContaining('url is required') });
    });

    it('returns error for invalid URL', async () => {
      const result = await exec({ action: 'remove', url: 'not-a-url' });
      expect(result.content[0]).toMatchObject({ text: expect.stringContaining('Invalid URL') });
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

    it('returns error for invalid URL', async () => {
      const result = await exec({ action: 'refresh', url: 'not-a-url' });
      expect(result.content[0]).toMatchObject({ text: expect.stringContaining('Invalid URL') });
    });

    it('reports no new entries when feed is up to date', async () => {
      await exec({ action: 'add', url: VALID_FEED_URL });
      mockParseURL.mockResolvedValue({ title: 'Example Blog', items: [] });
      const result = await exec({ action: 'refresh' });
      expect(result.content[0]).toMatchObject({ text: expect.stringContaining('no new entries') });
    });

    it('saves new articles on refresh', async () => {
      await exec({ action: 'add', url: VALID_FEED_URL });
      mockParseURL.mockResolvedValue({
        title: 'Example Blog',
        items: [
          { guid: 'guid-1', link: 'https://example.com/post/1', title: 'Post 1', isoDate: '2024-06-01T00:00:00.000Z' },
        ],
      });
      const result = await exec({ action: 'refresh' });
      expect(result.content[0]).toMatchObject({ text: expect.stringContaining('saved 1 new article') });
      expect(mockContext.sqlite.upsertNote).toHaveBeenCalled();
    });

    it('deduplicates: does not save the same article twice', async () => {
      await exec({ action: 'add', url: VALID_FEED_URL });
      const items = [
        { guid: 'guid-1', link: 'https://example.com/post/1', title: 'Post 1', isoDate: '2024-06-01T00:00:00.000Z' },
      ];
      mockParseURL.mockResolvedValue({ title: 'Example Blog', items });
      await exec({ action: 'refresh' });
      vi.clearAllMocks();
      mockParseURL.mockResolvedValue({ title: 'Example Blog', items });
      await exec({ action: 'refresh' });
      // upsertNote should NOT be called the second time
      expect(mockContext.sqlite.upsertNote).not.toHaveBeenCalled();
    });
  });
});
