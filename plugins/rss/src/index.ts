import { join } from 'node:path';
import type { EchosPlugin, PluginContext } from '@echos/core';
import { createFeedStore, type FeedStore } from './feed-store.js';
import { createManageFeedsTool } from './tools.js';
import { createRssPollJob, ensureDefaultSchedule } from './job.js';

let feedStore: FeedStore | null = null;

const rssPlugin: EchosPlugin = {
  name: 'rss',
  description: 'RSS/Atom feed ingestion — subscribe to feeds and save new articles automatically',
  version: '0.1.0',

  setup(context: PluginContext) {
    const dbPath = context.config.dbPath as string | undefined;
    if (!dbPath) {
      throw new Error('RSS plugin requires dbPath in plugin config');
    }

    feedStore = createFeedStore(join(dbPath, 'rss.db'));

    // Register the default poll schedule in SQLite if not already present
    ensureDefaultSchedule(context);

    return {
      tools: [createManageFeedsTool(context, feedStore)],
      jobs: [createRssPollJob(context, feedStore)],
    };
  },

  teardown() {
    feedStore?.close();
    feedStore = null;
  },
};

export default rssPlugin;
