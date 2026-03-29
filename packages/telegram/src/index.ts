import { Bot } from 'grammy';
import type { Logger } from 'pino';
import type { Config, InterfaceAdapter, NotificationService } from '@echos/shared';
import type { AgentDeps } from '@echos/core';
import {
  createAuthMiddleware,
  createRateLimitMiddleware,
  createErrorHandler,
} from './middleware/index.js';
import { clearAllSessions } from './session.js';
import { createTelegramNotificationService } from './notification.js';
import { registerCommands } from './commands.js';
import { registerCallbacks } from './callbacks.js';
import { registerMessageHandlers } from './messages.js';

export interface TelegramAdapterOptions {
  config: Config;
  agentDeps: AgentDeps;
  logger: Logger;
}

export interface TelegramAdapter extends InterfaceAdapter {
  notificationService: NotificationService;
}

export function createTelegramAdapter(options: TelegramAdapterOptions): TelegramAdapter {
  const { config, agentDeps, logger } = options;
  if (!config.telegramBotToken) {
    throw new Error('TELEGRAM_BOT_TOKEN is required when enableTelegram=true');
  }
  const bot = new Bot(config.telegramBotToken);

  const notificationService = createTelegramNotificationService({
    bot,
    allowedUserIds: config.allowedUserIds,
    logger,
  });

  // Middleware chain: error -> auth -> rate limit
  bot.catch(createErrorHandler(logger));
  bot.use(createAuthMiddleware(config.allowedUserIds, logger));
  bot.use(createRateLimitMiddleware());

  // Register handler modules
  const deps = { agentDeps, config, logger };
  registerCommands(bot, deps);
  registerCallbacks(bot, deps);
  registerMessageHandlers(bot, deps);

  return {
    notificationService,

    async start(): Promise<void> {
      logger.info('Starting Telegram bot...');
      // Drop pending updates to prevent stale /start commands from being processed
      // when the bot reconnects after being offline (e.g., user cleared messages)
      bot.start({
        onStart: () => logger.info('Telegram bot started'),
        drop_pending_updates: true,
      });
    },

    async stop(): Promise<void> {
      logger.info('Stopping Telegram bot...');
      clearAllSessions();
      bot.stop();
    },
  };
}
