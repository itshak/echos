import type { Bot } from 'grammy';
import type { Logger } from 'pino';
import type { AgentDeps } from '@echos/core';
import { decodeCallback } from './keyboards.js';

export interface CallbackDeps {
  agentDeps: AgentDeps;
  logger: Logger;
}

export function registerCallbacks(bot: Bot, deps: CallbackDeps): void {
  const { agentDeps, logger } = deps;

  bot.on('callback_query:data', async (ctx) => {
    const parsed = decodeCallback(ctx.callbackQuery.data);
    if (!parsed) {
      await ctx.answerCallbackQuery({ text: 'Unknown action.' });
      return;
    }

    const { action, id } = parsed;
    const { sqlite, markdown } = agentDeps;

    // Phase 1: execute the storage action and answer the callback query.
    let answered = false;
    try {
      if (action === 'mr' || action === 'ar') {
        const status = action === 'mr' ? 'read' : 'archived';
        const note = sqlite.getNote(id);
        if (!note) {
          await ctx.answerCallbackQuery({ text: 'Note not found.' });
          answered = true;
          return;
        }
        sqlite.updateNoteStatus(id, status);
        try { markdown.update(note.filePath, { status }); } catch { /* non-fatal */ }
        const verb = action === 'mr' ? 'read' : 'archived';
        await ctx.answerCallbackQuery({ text: `Marked as ${verb}.` });
        answered = true;
      } else if (action === 'cr') {
        const reminder = sqlite.getReminder(id);
        if (!reminder) {
          await ctx.answerCallbackQuery({ text: 'Reminder not found.' });
          answered = true;
          return;
        }
        sqlite.upsertReminder({
          ...reminder,
          completed: true,
          updated: new Date().toISOString(),
        });
        const titleShort = reminder.title.length > 180
          ? reminder.title.slice(0, 179) + '\u2026'
          : reminder.title;
        await ctx.answerCallbackQuery({ text: `Completed: ${titleShort}` });
        answered = true;
      }
    } catch (err) {
      logger.error({ err, action, id }, 'Callback query error');
      if (!answered) {
        await ctx.answerCallbackQuery({ text: 'Something went wrong.' }).catch(() => undefined);
      }
      return;
    }

    // Phase 2: remove the pressed button from the keyboard.
    try {
      const msg = ctx.callbackQuery.message;
      if (msg) {
        const existingMarkup = msg.reply_markup;
        if (existingMarkup?.inline_keyboard) {
          const callbackData = ctx.callbackQuery.data;
          const filtered = existingMarkup.inline_keyboard
            .map((row) => row.filter((btn) => !('callback_data' in btn) || btn.callback_data !== callbackData))
            .filter((row) => row.length > 0);
          await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: filtered.length > 0 ? filtered : [] } });
        }
      }
    } catch {
      // Non-fatal: keyboard cleanup is best-effort
    }
  });
}
