import type { Bot } from 'grammy';
import type { Logger } from 'pino';
import type { Config } from '@echos/shared';
import type { AgentDeps } from '@echos/core';
import { createUserMessage } from '@echos/core';
import { getOrCreateSession } from './session.js';
import { streamAgentResponse } from './streaming.js';
import { handleVoiceMessage } from './voice.js';
import { handlePhotoMessage } from './photo.js';
import { writeFileSync, mkdirSync } from 'fs';
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
  bot.on('message:document', async (ctx) => {
    const doc = ctx.message?.document;
    if (!doc) return;

    const userId = ctx.from?.id;
    if (!userId) return;

    const fileName = doc.file_name || 'unknown';
    const ext = extname(fileName).toLowerCase();

    // Route to appropriate handler based on file type
    const pdfExts = new Set(['.pdf']);
    const officeExts = new Set(['.docx', '.doc', '.xlsx', '.xls', '.csv', '.pptx', '.ppt']);

    if (!pdfExts.has(ext) && !officeExts.has(ext)) {
      await ctx.reply(
        'Unsupported file type. Supported: PDF, Word (.docx/.doc), Excel (.xlsx/.xls/.csv), PowerPoint (.pptx/.ppt).',
      );
      return;
    }

    await ctx.react('👀').catch(() => undefined);

    try {
      const file = await ctx.api.getFile(doc.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${ctx.api.token}/${file.file_path}`;

      const tmpDir = join(process.env['ECHOS_HOME'] || '/data', 'tmp');
      mkdirSync(tmpDir, { recursive: true });

      const safeFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
      const tmpFilePath = join(tmpDir, `${randomUUID().substring(0, 8)}-${safeFileName}`);

      const response = await fetch(fileUrl);
      if (!response.ok) {
        throw new Error(`Failed to download: HTTP ${response.status}`);
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      writeFileSync(tmpFilePath, buffer);

      const agent = getOrCreateSession(userId, agentDeps);

      // Build instruction for the agent — let it decide how to process
      const instruction =
        `The user sent a document: "${fileName}" (saved to ${tmpFilePath}).

` +
        `Please process this ${ext} file and extract its contents as a knowledge note.`;

      await streamAgentResponse(agent, instruction, ctx);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      await ctx.reply(`Failed to process "${fileName}": ${msg}`);
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
