import RSSParser from 'rss-parser';
import { v4 as uuidv4 } from 'uuid';
import type { Logger } from 'pino';
import { validateUrl, validateBufferSize } from '@echos/shared';
import { processArticle } from '@echos/plugin-article';
import type { PluginContext } from '@echos/core';
import type { NoteMetadata } from '@echos/shared';
import { categorizeContent } from '@echos/core';
import type { Feed, FeedStore } from './feed-store.js';

const parser = new RSSParser();

const FEED_FETCH_TIMEOUT = 30_000; // 30s
const MAX_FEED_SIZE = 5 * 1024 * 1024; // 5 MiB

/**
 * Fetch feed XML with timeout and size limits, then return the raw string.
 * Prevents memory exhaustion from oversized feeds.
 */
export async function fetchFeedXml(url: string): Promise<string> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(FEED_FETCH_TIMEOUT),
    headers: { 'User-Agent': 'EchOS/1.0 (RSS Feed Reader)' },
  });

  if (!response.ok) {
    throw new Error(`Feed fetch failed: ${response.status} ${response.statusText}`);
  }

  const contentLength = response.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > MAX_FEED_SIZE) {
    throw new Error('Feed XML exceeds maximum allowed size');
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  validateBufferSize(buffer, { maxBytes: MAX_FEED_SIZE, label: 'RSS feed XML' });

  return buffer.toString('utf-8');
}

export interface NewEntry {
  guid: string;
  url: string;
  title: string;
  publishedAt: string | null;
}

export async function pollFeed(feed: Feed, logger: Logger): Promise<NewEntry[]> {
  const validatedUrl = validateUrl(feed.url);

  let parsed: Awaited<ReturnType<typeof parser.parseString>>;
  try {
    const xml = await fetchFeedXml(validatedUrl);
    parsed = await parser.parseString(xml);
  } catch (err) {
    throw new Error(`Failed to fetch feed "${feed.name}": ${err instanceof Error ? err.message : String(err)}`);
  }

  const newEntries: NewEntry[] = [];
  const lastEntryDate = feed.lastEntryDate ? new Date(feed.lastEntryDate) : null;

  for (const item of parsed.items) {
    const guid = item.guid ?? item.link ?? item.title ?? '';
    if (!guid) continue;

    const url = item.link ?? '';
    if (!url) continue;

    const title = item.title ?? 'Untitled';
    const pubDate = item.isoDate ?? item.pubDate ?? null;
    const publishedAt = pubDate ? new Date(pubDate).toISOString() : null;

    // Only include entries newer than lastEntryDate
    if (lastEntryDate && publishedAt) {
      const entryDate = new Date(publishedAt);
      if (entryDate <= lastEntryDate) continue;
    }

    newEntries.push({ guid, url, title, publishedAt });
  }

  logger.debug({ feedId: feed.id, name: feed.name, newCount: newEntries.length }, 'Feed polled');
  return newEntries;
}

/**
 * Processes a feed entry: claims the guid, extracts article content, saves as a note.
 * Returns true if the entry was saved, false if it was already claimed (duplicate).
 */
export async function processEntry(
  entry: NewEntry,
  feed: Feed,
  store: FeedStore,
  context: PluginContext,
): Promise<boolean> {
  const { sqlite, markdown, vectorDb, generateEmbedding, logger, config } = context;

  // Validate and process URL
  let validatedUrl: string;
  try {
    validatedUrl = validateUrl(entry.url);
  } catch {
    logger.warn({ url: entry.url, feedId: feed.id }, 'Skipping entry with invalid URL');
    return false;
  }

  const now = new Date().toISOString();
  const id = uuidv4();

  // Atomically claim the (feedId, guid) slot before doing any work.
  // This prevents concurrent poll + refresh from creating duplicate notes:
  // only the execution that successfully inserts the row proceeds.
  const claimed = store.claimEntry({
    id: uuidv4(),
    feedId: feed.id,
    guid: entry.guid,
    url: validatedUrl,
    title: entry.title,
    publishedAt: entry.publishedAt,
    savedNoteId: id,
    createdAt: now,
  });

  if (!claimed) {
    logger.debug({ feedId: feed.id, guid: entry.guid }, 'Entry already claimed by concurrent execution, skipping');
    return false;
  }

  try {
    let title = entry.title;
    let content = '';
    let author: string | undefined;

    // Try to extract article content
    try {
      const processed = await processArticle(validatedUrl, logger);
      title = processed.title || title;
      content = processed.content;
      author = processed.metadata.author;
    } catch (err) {
      // Fall back to minimal note if extraction fails
      logger.warn({ url: entry.url, err }, 'Article extraction failed, saving with minimal content');
      content = `*Source:* ${validatedUrl}\n\n*Feed:* ${feed.name}\n\n*Note:* Full content could not be extracted.`;
    }

    // Auto-categorize with AI
    // Use anthropicApiKey for Anthropic/Claude models; fall back to llmApiKey for custom endpoints.
    let category = 'articles';
    const tags = [...feed.tags, 'rss'];

    const apiKey = (config.anthropicApiKey ?? config['llmApiKey']) as string | undefined;
    const baseUrl = config['llmBaseUrl'] as string | undefined;

    if (content && apiKey) {
      try {
        const vocabulary = sqlite.getTopTagsWithCounts(50);
        const result = await categorizeContent(
          title,
          content,
          'lightweight',
          apiKey,
          logger,
          undefined,
          (config.defaultModel as string | undefined) ?? 'claude-haiku-4-5-20251001',
          baseUrl,
          vocabulary,
        );
        category = result.category;
        // Merge AI tags with feed tags, deduplicating
        const aiTags = result.tags.filter((t) => !tags.includes(t));
        tags.push(...aiTags);
      } catch {
        // Non-fatal — use defaults
      }
    }

    const metadata: NoteMetadata = {
      id,
      type: 'article',
      title,
      created: now,
      updated: now,
      tags,
      links: [],
      category,
      sourceUrl: validatedUrl,
      status: 'saved',
      inputSource: 'url',
    };
    if (author) metadata.author = author;

    const filePath = markdown.save(metadata, content);
    sqlite.upsertNote(metadata, content, filePath);

    // Embed
    if (content) {
      try {
        const embedText = `${title}\n\n${content.slice(0, 2000)}`;
        const vector = await generateEmbedding(embedText);
        await vectorDb.upsert({ id, text: embedText, vector, type: 'article', title });
      } catch {
        // Non-fatal
      }
    }

    logger.info({ feedId: feed.id, noteId: id, title }, 'Feed entry saved as note');
    return true;
  } catch (err) {
    // Roll back the claimed entry so it can be retried on the next poll
    store.removeEntry(feed.id, entry.guid);
    logger.error({ feedId: feed.id, guid: entry.guid, err }, 'Failed to process claimed entry, rolled back');
    throw err;
  }
}
