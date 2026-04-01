import type { Bot } from 'grammy';
import type { Logger } from 'pino';
import type { Config } from '@echos/shared';
import type { AgentDeps } from '@echos/core';
import { createUserMessage } from '@echos/core';
import { getOrCreateSession } from './session.js';
import { streamAgentResponse } from './streaming.js';
import { handleVoiceMessage } from './voice.js';
import { handlePhotoMessage } from './photo.js';
import { mkdir, writeFile, unlink } from 'fs/promises';
import { join, extname } from 'path';
import { randomUUID } from 'crypto';

export interface MessageDeps {
  agentDeps: AgentDeps;
  config: Config;
  logger: Logger;
}

export function registerMessageHandlers(bot: Bot, deps: MessageDeps): void {
  const { agentDeps, config, logger } = deps;

  // Handle document messages (PDF, Word, Excel, PowerPoint, CSV)
  const MAX_DOCUMENT_SIZE = 20 * 1024 * 1024; // 20 MB
  const DOWNLOAD_TIMEOUT_MS = 30_000;
  const SUPPORTED_EXTS = new Set([
    '.pdf',
    '.docx', '.doc',
    '.xlsx', '.xls', '.csv',
    '.pptx', '.ppt',
  ]);

  bot.on('message:document', async (ctx) => {
    const doc = ctx.message?.document;
    if (!doc) return;

    const userId = ctx.from?.id;
    if (!userId) return;

    // Comment 1: Derive extension from file_path when file_name is missing
    const file = await ctx.api.getFile(doc.file_id);

    // Comment 2: Guard against undefined file_path
    if (!file.file_path) {
      await ctx.reply('Could not retrieve the file from Telegram. Please try sending it again.');
      return;
    }

    const fileName = doc.file_name || file.file_path.split('/').pop() || 'unknown';
    const ext = extname(fileName).toLowerCase();

    if (!SUPPORTED_EXTS.has(ext)) {
      await ctx.reply(
        'Unsupported file type. Supported: PDF, Word (.docx/.doc), Excel (.xlsx/.xls/.csv), PowerPoint (.pptx/.ppt).',
      );
      return;
    }

    // Comment 3: Reject files that exceed the size limit before downloading
    if (doc.file_size && doc.file_size > MAX_DOCUMENT_SIZE) {
      await ctx.reply('File is too large. Maximum supported size is 20 MB.');
      return;
    }

    await ctx.react('👀').catch(() => undefined);

    let tmpFilePath: string | undefined;
    try {
      const fileUrl = `https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`;

      const tmpDir = join(process.env['ECHOS_HOME'] || '/data', 'tmp');
      await mkdir(tmpDir, { recursive: true });

      const safeFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
      tmpFilePath = join(tmpDir, `${randomUUID().substring(0, 8)}-${safeFileName}`);

      // Comment 3: Enforce download timeout
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
      try {
        const response = await fetch(fileUrl, { signal: controller.signal });
        if (!response.ok) {
          throw new Error(`Failed to download: HTTP ${response.status}`);
        }
        // Comment 4: Use async fs operations
        const buffer = Buffer.from(await response.arrayBuffer());
        await writeFile(tmpFilePath, buffer);
      } finally {
        clearTimeout(timeout);
      }

      const agent = getOrCreateSession(userId, agentDeps);

      // Comment 5: Pass the download URL so the agent can use URL-based tools if needed
      const instruction =
        `The user sent a document: "${fileName}" (type: ${ext}, saved to ${tmpFilePath}, url: ${fileUrl}).\n` +
        `Please process this file and extract its contents as a knowledge note.`;

      await streamAgentResponse(agent, instruction, ctx);
    } catch (error) {
      // Comment 6: Log full error server-side, send generic message to user
      logger.error({ err: error, fileName }, 'Failed to process document');
      await ctx.reply(`Sorry, I couldn't process "${fileName}". Please try again later.`);
    } finally {
      // Comment 4: Clean up temp file
      if (tmpFilePath) {
        unlink(tmpFilePath).catch(() => undefined);
      }
    }
  });

  // Handle all text messages via agent
  bot.on('message:text', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    const agent = getOrCreateSession(userId, agentDeps);

    // If the agent is mid-run, steer it with the new message instead of queuing a new turn
    if (agent.state.isStreaming) {
      agent.steer(createUserMessage(ctx.message.text));
      await ctx.reply('↩️ Redirecting...');
      return;
    }

    await ctx.react('👀').catch(() => undefined);
    await streamAgentResponse(agent, ctx.message.text, ctx);
  });

  // Handle voice messages via Whisper transcription
  bot.on('message:voice', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    if (!config.openaiApiKey) {
      await ctx.reply('Voice messages require OpenAI API key configuration.');
      return;
    }

    await ctx.react('🤗').catch(() => undefined);
    const agent = getOrCreateSession(userId, agentDeps);
    await handleVoiceMessage(ctx, agent, config.openaiApiKey, logger, config.whisperLanguage);
  });

  // Handle photo messages
  bot.on('message:photo', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;

    await ctx.react('👀').catch(() => undefined);
    const agent = getOrCreateSession(userId, agentDeps);
    await handlePhotoMessage(ctx, agent, logger);
  });
}
