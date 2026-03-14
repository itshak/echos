import { InlineKeyboard } from 'grammy';

/** Max items to show as inline keyboard buttons */
const MAX_KEYBOARD_ITEMS = 5;

/** Max label length for a button (Telegram displays ~30 chars well) */
const MAX_LABEL_LENGTH = 28;

/**
 * Callback data prefixes:
 * - mr:<id>  = mark as read
 * - ar:<id>  = archive
 * - cr:<id>  = complete reminder
 */
export type CallbackAction = 'mr' | 'ar' | 'cr';

export interface KeyboardAction {
  action: CallbackAction;
  id: string;
  label: string;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '\u2026';
}

export function encodeCallback(action: CallbackAction, id: string): string {
  return `${action}:${id}`;
}

export function decodeCallback(data: string): { action: CallbackAction; id: string } | undefined {
  const colonIdx = data.indexOf(':');
  if (colonIdx < 1) return undefined;
  const action = data.slice(0, colonIdx) as CallbackAction;
  if (!['mr', 'ar', 'cr'].includes(action)) return undefined;
  const id = data.slice(colonIdx + 1);
  if (!id) return undefined;
  return { action, id };
}

interface ReadingQueueItem {
  id: string;
  title: string;
  type: string;
  sourceUrl?: string;
}

export function buildReadingQueueKeyboard(items: ReadingQueueItem[]): InlineKeyboard | undefined {
  const actionable = items.slice(0, MAX_KEYBOARD_ITEMS);
  if (actionable.length === 0) return undefined;

  const kb = new InlineKeyboard();
  for (const item of actionable) {
    const label = truncate(item.title, MAX_LABEL_LENGTH);
    kb.text(`\u2713 ${label}`, encodeCallback('mr', item.id));
    if (item.sourceUrl) {
      kb.url('\u{1F517}', item.sourceUrl);
    }
    kb.row();
  }
  return kb;
}

interface ListNotesItem {
  id: string;
  title: string;
  type: string;
  status: string | null;
}

export function buildListNotesKeyboard(items: ListNotesItem[]): InlineKeyboard | undefined {
  // Only show archive buttons for non-archived items
  const actionable = items
    .filter((i) => i.status !== 'archived')
    .slice(0, MAX_KEYBOARD_ITEMS);
  if (actionable.length === 0) return undefined;

  const kb = new InlineKeyboard();
  for (const item of actionable) {
    const label = truncate(item.title, MAX_LABEL_LENGTH);
    if (item.status !== 'read') {
      kb.text(`\u2713 ${label}`, encodeCallback('mr', item.id));
    }
    kb.text(`\u{1F4C2} ${label}`, encodeCallback('ar', item.id));
    kb.row();
  }
  return kb;
}

interface ReminderItem {
  id: string;
  title: string;
  completed: boolean;
}

export function buildRemindersKeyboard(items: ReminderItem[]): InlineKeyboard | undefined {
  const pending = items.filter((i) => !i.completed).slice(0, MAX_KEYBOARD_ITEMS);
  if (pending.length === 0) return undefined;

  const kb = new InlineKeyboard();
  for (const item of pending) {
    const label = truncate(item.title, MAX_LABEL_LENGTH);
    kb.text(`\u2705 ${label}`, encodeCallback('cr', item.id));
    kb.row();
  }
  return kb;
}
