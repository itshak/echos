import { describe, it, expect, beforeEach } from 'vitest';
import { createFeedStore, type Feed, type FeedEntry, type FeedStore } from './feed-store.js';

function makeFeed(overrides: Partial<Feed> = {}): Feed {
  return {
    id: 'feed-1',
    url: 'https://example.com/feed.xml',
    name: 'Example Feed',
    tags: ['tech'],
    lastCheckedAt: null,
    lastEntryDate: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeEntry(overrides: Partial<FeedEntry> = {}): FeedEntry {
  return {
    id: 'entry-1',
    feedId: 'feed-1',
    guid: 'guid-abc',
    url: 'https://example.com/article/1',
    title: 'Test Article',
    publishedAt: '2024-01-02T00:00:00.000Z',
    savedNoteId: 'note-123',
    createdAt: '2024-01-02T00:00:00.000Z',
    ...overrides,
  };
}

let store: FeedStore;

beforeEach(() => {
  store = createFeedStore(':memory:');
});

describe('createFeedStore', () => {
  describe('feeds', () => {
    it('stores and retrieves a feed by id', () => {
      const feed = makeFeed();
      store.upsertFeed(feed);
      expect(store.getFeed('feed-1')).toEqual(feed);
    });

    it('stores and retrieves a feed by url', () => {
      const feed = makeFeed();
      store.upsertFeed(feed);
      expect(store.getFeedByUrl('https://example.com/feed.xml')).toEqual(feed);
    });

    it('returns undefined for unknown id', () => {
      expect(store.getFeed('nonexistent')).toBeUndefined();
    });

    it('returns undefined for unknown url', () => {
      expect(store.getFeedByUrl('https://missing.example.com/rss')).toBeUndefined();
    });

    it('lists all feeds in insertion order', () => {
      store.upsertFeed(makeFeed({ id: 'feed-1', url: 'https://a.com/rss', createdAt: '2024-01-01T00:00:00.000Z' }));
      store.upsertFeed(makeFeed({ id: 'feed-2', url: 'https://b.com/rss', createdAt: '2024-01-02T00:00:00.000Z' }));
      const feeds = store.listFeeds();
      expect(feeds).toHaveLength(2);
      expect(feeds[0]?.id).toBe('feed-1');
      expect(feeds[1]?.id).toBe('feed-2');
    });

    it('returns empty list when no feeds', () => {
      expect(store.listFeeds()).toEqual([]);
    });

    it('deletes a feed and returns true', () => {
      store.upsertFeed(makeFeed());
      expect(store.deleteFeed('feed-1')).toBe(true);
      expect(store.getFeed('feed-1')).toBeUndefined();
    });

    it('returns false when deleting nonexistent feed', () => {
      expect(store.deleteFeed('nonexistent')).toBe(false);
    });

    it('upserts updated feed data', () => {
      store.upsertFeed(makeFeed({ name: 'Old Name' }));
      store.upsertFeed(makeFeed({ name: 'New Name' }));
      expect(store.getFeed('feed-1')?.name).toBe('New Name');
    });

    it('updateLastChecked sets lastCheckedAt', () => {
      store.upsertFeed(makeFeed());
      store.updateLastChecked('feed-1', '2024-06-01T12:00:00.000Z');
      expect(store.getFeed('feed-1')?.lastCheckedAt).toBe('2024-06-01T12:00:00.000Z');
      expect(store.getFeed('feed-1')?.lastEntryDate).toBeNull();
    });

    it('updateLastChecked sets lastEntryDate when provided', () => {
      store.upsertFeed(makeFeed());
      store.updateLastChecked('feed-1', '2024-06-01T12:00:00.000Z', '2024-05-31T10:00:00.000Z');
      expect(store.getFeed('feed-1')?.lastEntryDate).toBe('2024-05-31T10:00:00.000Z');
    });

    it('preserves tags as array roundtrip', () => {
      store.upsertFeed(makeFeed({ tags: ['a', 'b', 'c'] }));
      expect(store.getFeed('feed-1')?.tags).toEqual(['a', 'b', 'c']);
    });
  });

  describe('entries', () => {
    beforeEach(() => {
      store.upsertFeed(makeFeed());
    });

    it('claimEntry returns true for a new entry', () => {
      const claimed = store.claimEntry(makeEntry());
      expect(claimed).toBe(true);
    });

    it('claimEntry returns false for a duplicate guid', () => {
      store.claimEntry(makeEntry());
      const secondClaim = store.claimEntry(makeEntry({ id: 'entry-2' }));
      expect(secondClaim).toBe(false);
    });

    it('claimEntry allows same guid under different feed', () => {
      store.upsertFeed(makeFeed({ id: 'feed-2', url: 'https://other.com/rss' }));
      store.claimEntry(makeEntry());
      const otherFeedClaim = store.claimEntry(makeEntry({ id: 'entry-2', feedId: 'feed-2' }));
      expect(otherFeedClaim).toBe(true);
    });

    it('getEntryCount returns 0 for no entries', () => {
      expect(store.getEntryCount('feed-1')).toBe(0);
    });

    it('getEntryCount increments after claims', () => {
      store.claimEntry(makeEntry({ guid: 'g1' }));
      store.claimEntry(makeEntry({ id: 'e2', guid: 'g2' }));
      expect(store.getEntryCount('feed-1')).toBe(2);
    });

    it('cascade-deletes entries when feed is deleted', () => {
      store.claimEntry(makeEntry());
      expect(store.getEntryCount('feed-1')).toBe(1);
      store.deleteFeed('feed-1');
      store.upsertFeed(makeFeed()); // recreate to check count
      expect(store.getEntryCount('feed-1')).toBe(0);
    });
  });
});
