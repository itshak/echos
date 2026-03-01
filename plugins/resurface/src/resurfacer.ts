import type { SqliteStorage } from '@echos/core';

export interface SurfacedNote {
  id: string;
  title: string;
  type: string;
  category: string;
  tags: string[];
  gist: string | null;
  created: string;
  sourceUrl: string | null;
  reason: 'forgotten' | 'on_this_day' | 'random';
}

/**
 * Picks notes to resurface using three strategies:
 * - forgotten: notes not surfaced in a while (or never), oldest first
 * - on_this_day: notes created on the same calendar date in a prior year
 * - random: random sampling of un-recently-surfaced notes
 * - mix: blend of forgotten + on_this_day
 *
 * Updates `last_surfaced` for every returned note.
 */
export function resurfaceNotes(
  sqlite: SqliteStorage,
  opts: { limit?: number; mode?: 'forgotten' | 'on_this_day' | 'random' | 'mix' } = {},
): SurfacedNote[] {
  const db = sqlite.db;
  const limit = opts.limit ?? 3;
  const mode = opts.mode ?? 'mix';

  const threshold = new Date();
  threshold.setDate(threshold.getDate() - 7);
  const thresholdIso = threshold.toISOString();

  let rows: SurfacedNote[] = [];

  type RawRow = {
    id: string;
    type: string;
    title: string;
    category: string;
    tags: string;
    gist: string | null;
    created: string;
    sourceUrl: string | null;
  };

  const toSurfaced = (r: RawRow, reason: SurfacedNote['reason']): SurfacedNote => ({
    ...r,
    tags: r.tags ? r.tags.split(',').filter(Boolean) : [],
    reason,
  });

  // Run the selection and last_surfaced update in a single transaction so
  // concurrent scheduled runs or tool calls cannot select the same notes
  // before either update commits.
  rows = db.transaction((): SurfacedNote[] => {
    // Fetch raw candidate rows for each active strategy (always up to `limit` so
    // we have enough to top-up when one strategy is sparse).
    let forgottenRaw: RawRow[] = [];
    if (mode === 'forgotten' || mode === 'mix') {
      forgottenRaw = db
        .prepare(
          `SELECT id, type, title, category, tags, gist, created, source_url AS sourceUrl
           FROM notes
           WHERE (status != 'archived' OR status IS NULL)
             AND (last_surfaced IS NULL OR last_surfaced < ?)
           ORDER BY last_surfaced ASC NULLS FIRST, created ASC
           LIMIT ?`,
        )
        .all(thresholdIso, limit) as RawRow[];
    }

    let onThisDayRaw: RawRow[] = [];
    if (mode === 'on_this_day' || mode === 'mix') {
      // Compare month-day entirely in SQL using UTC (strftime on SQLite 'now' is UTC)
      // to avoid local-time vs stored-UTC mismatch around midnight.
      onThisDayRaw = db
        .prepare(
          `SELECT id, type, title, category, tags, gist, created, source_url AS sourceUrl
           FROM notes
           WHERE strftime('%m-%d', created) = strftime('%m-%d', 'now')
             AND strftime('%Y', created) < strftime('%Y', 'now')
             AND (status != 'archived' OR status IS NULL)
             AND (last_surfaced IS NULL OR last_surfaced < ?)
           ORDER BY RANDOM()
           LIMIT ?`,
        )
        .all(thresholdIso, limit) as RawRow[];
    }

    let selected: SurfacedNote[] = [];

    if (mode === 'forgotten') {
      selected = forgottenRaw.map((r) => toSurfaced(r, 'forgotten'));
    } else if (mode === 'on_this_day') {
      selected = onThisDayRaw.map((r) => toSurfaced(r, 'on_this_day'));
    } else if (mode === 'mix') {
      // Allocate ~60 % to forgotten, ~40 % to on_this_day.
      // If on_this_day is sparse, top up from the remaining forgotten rows so
      // the result always fills `limit` when enough eligible notes exist.
      const forgottenSlot = Math.ceil(limit * 0.6);

      const forgottenChosen = forgottenRaw.slice(0, forgottenSlot);
      selected.push(...forgottenChosen.map((r) => toSurfaced(r, 'forgotten')));

      const seenIds = new Set(selected.map((r) => r.id));
      const onThisDayChosen = onThisDayRaw.filter((r) => !seenIds.has(r.id));
      selected.push(...onThisDayChosen.map((r) => toSurfaced(r, 'on_this_day')));

      // Top up with remaining forgotten rows if on_this_day was sparse
      if (selected.length < limit) {
        const seenIdsNow = new Set(selected.map((r) => r.id));
        const topUp = forgottenRaw
          .slice(forgottenSlot)
          .filter((r) => !seenIdsNow.has(r.id))
          .slice(0, limit - selected.length);
        selected.push(...topUp.map((r) => toSurfaced(r, 'forgotten')));
      }
    } else if (mode === 'random') {
      // For a personal knowledge base (hundreds to low thousands of notes),
      // ORDER BY RANDOM() is fast and gives a uniform distribution.
      const randomRows = db
        .prepare(
          `SELECT id, type, title, category, tags, gist, created, source_url AS sourceUrl
           FROM notes
           WHERE (last_surfaced IS NULL OR last_surfaced < ?)
             AND (status != 'archived' OR status IS NULL)
           ORDER BY RANDOM()
           LIMIT ?`,
        )
        .all(thresholdIso, limit) as RawRow[];

      selected = randomRows.map((r) => toSurfaced(r, 'random'));
    }

    // Trim to requested limit
    selected = selected.slice(0, limit);

    // Update last_surfaced for all selected notes in the same transaction
    if (selected.length > 0) {
      const now = new Date().toISOString();
      const ids = selected.map((row) => row.id);
      const placeholders = ids.map(() => '?').join(', ');
      db.prepare(`UPDATE notes SET last_surfaced = ? WHERE id IN (${placeholders})`).run(now, ...ids);
    }

    return selected;
  })();

  return rows;
}

export function formatSurfacedNote(note: SurfacedNote): string {
  const reasonLabel: Record<SurfacedNote['reason'], string> = {
    forgotten: '🔮 Resurfaced',
    on_this_day: '📅 On this day',
    random: '🎲 Discovery',
  };

  const year = new Date(note.created).getUTCFullYear();
  const dateLabel = note.reason === 'on_this_day' ? ` (${year})` : '';
  const tagsStr = note.tags.length > 0 ? ` · ${note.tags.map((t) => `#${t}`).join(' ')}` : '';
  const gist = note.gist ? `\n> ${note.gist}` : '';

  return `${reasonLabel[note.reason]}${dateLabel}: **${note.title}**${tagsStr}${gist}`;
}
