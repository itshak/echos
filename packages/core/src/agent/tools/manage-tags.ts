import { Type, type Static } from '@mariozechner/pi-ai';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import type { SqliteStorage } from '../../storage/sqlite.js';
import { ValidationError } from '@echos/shared';

export interface ManageTagsToolDeps {
  sqlite: SqliteStorage;
}

const schema = Type.Object({
  action: Type.Union(
    [Type.Literal('list'), Type.Literal('rename'), Type.Literal('merge')],
    {
      description:
        'list: show all tags with counts | rename: rename a tag across all notes | merge: consolidate multiple tags into one',
    },
  ),
  from: Type.Optional(Type.String({ description: 'Tag to rename (rename action)' })),
  to: Type.Optional(Type.String({ description: 'New tag name (rename action)' })),
  tags: Type.Optional(
    Type.Array(Type.String(), { description: 'Tags to consolidate (merge action)' }),
  ),
  into: Type.Optional(Type.String({ description: 'Target tag to merge into (merge action)' })),
  limit: Type.Optional(
    Type.Number({
      description: 'Max tags to return for list action (default 100, min 1, max 500)',
      minimum: 1,
      maximum: 500,
    }),
  ),
});

type Params = Static<typeof schema>;

function validateTagValue(value: string, fieldName: string): void {
  if (value.includes(',')) {
    throw new ValidationError(`"${fieldName}" must not contain commas`);
  }
}

export function createManageTagsTool(deps: ManageTagsToolDeps): AgentTool<typeof schema> {
  return {
    name: 'manage_tags',
    label: 'Manage Tags',
    description:
      'Manage the tag vocabulary across all notes. Use action="list" to see all tags with usage counts. Use action="rename" to rename a tag across all notes (e.g., "js" → "javascript"). Use action="merge" to consolidate multiple tags into one (e.g., merge ["react", "reactjs"] into "react").',
    parameters: schema,
    execute: async (_toolCallId, params: Params) => {
      if (params.action === 'list') {
        const limit = Math.min(Math.max(1, params.limit ?? 100), 500);
        const tags = deps.sqlite.getTopTagsWithCounts(limit);

        if (tags.length === 0) {
          return {
            content: [{ type: 'text' as const, text: 'No tags found in your knowledge base.' }],
            details: { total: 0, tags: [] },
          };
        }

        const lines = tags.map(({ tag, count }) => `- **${tag}** (${count} note${count === 1 ? '' : 's'})`);
        return {
          content: [
            {
              type: 'text' as const,
              text: `${tags.length} tag${tags.length === 1 ? '' : 's'} in your knowledge base:\n\n${lines.join('\n')}`,
            },
          ],
          details: { total: tags.length, tags },
        };
      }

      if (params.action === 'rename') {
        if (!params.from || !params.to) {
          throw new ValidationError('rename action requires both "from" and "to" parameters');
        }
        const from = params.from.toLowerCase().trim();
        const to = params.to.toLowerCase().trim();
        if (!from || !to) {
          throw new ValidationError('"from" and "to" must be non-empty strings');
        }
        validateTagValue(from, 'from');
        validateTagValue(to, 'to');
        if (from === to) {
          return {
            content: [
              { type: 'text' as const, text: `Tag "${from}" is already named "${to}". No changes made.` },
            ],
            details: { affected: 0 },
          };
        }

        const affected = deps.sqlite.renameTag(from, to);
        return {
          content: [
            {
              type: 'text' as const,
              text:
                affected > 0
                  ? `Renamed tag "${from}" to "${to}" across ${affected} note${affected === 1 ? '' : 's'}.`
                  : `Tag "${from}" was not found in any notes. No changes made.`,
            },
          ],
          details: { from, to, affected },
        };
      }

      if (params.action === 'merge') {
        if (!params.tags || params.tags.length === 0) {
          throw new ValidationError('merge action requires a "tags" array of tags to consolidate');
        }
        if (!params.into) {
          throw new ValidationError('merge action requires an "into" parameter specifying the target tag');
        }
        const into = params.into.toLowerCase().trim();
        if (!into) {
          throw new ValidationError('"into" must be a non-empty string');
        }
        validateTagValue(into, 'into');
        const tags = params.tags.map((t) => t.toLowerCase().trim()).filter(Boolean);
        for (const t of tags) {
          validateTagValue(t, 'tags');
        }

        const affected = deps.sqlite.mergeTags(tags, into);
        const sourceList = tags.filter((t) => t !== into).join('", "');
        return {
          content: [
            {
              type: 'text' as const,
              text:
                affected > 0
                  ? `Merged tags "${sourceList}" into "${into}" across ${affected} note${affected === 1 ? '' : 's'}.`
                  : `None of the source tags were found in any notes. No changes made.`,
            },
          ],
          details: { tags, into, affected },
        };
      }

      throw new ValidationError(`Unknown action: ${String(params.action)}`);
    },
  };
}
