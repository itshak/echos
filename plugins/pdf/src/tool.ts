import { createRequire } from 'node:module';
import { Type, type Static } from '@mariozechner/pi-ai';
import type { AgentTool } from '@mariozechner/pi-agent-core';
import { v4 as uuidv4 } from 'uuid';
import type { NoteMetadata } from '@echos/shared';
import { validateUrl, validateBufferSize, CONTENT_SIZE_DEFAULTS } from '@echos/shared';
import type { PluginContext } from '@echos/core';
import { categorizeContent, type ProcessingMode } from '@echos/core';

// Import via createRequire to avoid pdf-parse's test-file side-effect when
// running as an ESM entry point.
const _require = createRequire(import.meta.url);

interface PdfData {
  text: string;
  numpages: number;
  info: Record<string, unknown>;
}

// pdf-parse/lib/pdf-parse.js is the library proper without the CLI test harness.
const parsePdf = _require('pdf-parse/lib/pdf-parse.js') as (
  buffer: Buffer,
) => Promise<PdfData>;

const MAX_CHARS = 500_000;
const TRUNCATED_NOTICE = '\n\n[content truncated due to size limit]';

const schema = Type.Object({
  url: Type.String({ description: 'URL of the PDF to download and save', format: 'uri' }),
  title: Type.Optional(Type.String({ description: 'Optional title override (defaults to PDF filename or extracted title)' })),
  tags: Type.Optional(Type.Array(Type.String(), { description: 'Tags to apply to the saved note' })),
  categorize: Type.Optional(
    Type.Boolean({
      description: 'Automatically categorize using AI (default: true)',
      default: true,
    }),
  ),
});

type Params = Static<typeof schema>;

export function createSavePdfTool(context: PluginContext): AgentTool<typeof schema> {
  return {
    name: 'save_pdf',
    label: 'Save PDF',
    description:
      'Download a PDF from a URL, extract its text content, and save it as a knowledge note. Handles standard PDFs; fails gracefully on password-protected or corrupt files.',
    parameters: schema,
    execute: async (_toolCallId: string, params: Params, _signal, onUpdate) => {
      // Validate URL (SSRF protection)
      const safeUrl = validateUrl(params.url);

      onUpdate?.({
        content: [{ type: 'text', text: `Downloading PDF from ${safeUrl}...` }],
        details: { phase: 'downloading' },
      });

      // Download the PDF
      let pdfBuffer: Buffer;
      try {
        const response = await fetch(safeUrl, {
          signal: AbortSignal.timeout(30_000),
          redirect: 'error',
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        const contentType = response.headers.get('content-type') ?? '';
        if (
          contentType.length > 0 &&
          !contentType.includes('application/pdf') &&
          !contentType.includes('application/octet-stream') &&
          !contentType.includes('binary/')
        ) {
          context.logger.warn({ contentType }, 'Unexpected content-type for PDF download');
        }
        // Reject early based on declared size to avoid buffering a huge response
        const contentLength = response.headers.get('content-length');
        if (contentLength !== null) {
          const bytes = parseInt(contentLength, 10);
          if (!isNaN(bytes) && bytes > CONTENT_SIZE_DEFAULTS.maxBytes) {
            return {
              content: [{ type: 'text' as const, text: `PDF is too large to process: reported size ${bytes.toLocaleString()} bytes exceeds ${CONTENT_SIZE_DEFAULTS.maxBytes.toLocaleString()} byte limit` }],
              details: { error: 'too_large' },
            };
          }
        }
        const arrayBuffer = await response.arrayBuffer();
        pdfBuffer = Buffer.from(arrayBuffer);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `Failed to download PDF: ${message}` }],
          details: { error: message },
        };
      }

      // Validate buffer size (default 10 MiB)
      try {
        validateBufferSize(pdfBuffer, { label: 'PDF file' });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: 'text' as const, text: `PDF is too large to process: ${message}` }],
          details: { error: message },
        };
      }

      onUpdate?.({
        content: [{ type: 'text', text: 'Extracting text from PDF...' }],
        details: { phase: 'extracting' },
      });

      // Parse PDF
      let pdfData: PdfData;
      try {
        pdfData = await parsePdf(pdfBuffer);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Password-protected PDFs produce a specific error
        const isPasswordProtected =
          message.toLowerCase().includes('password') ||
          message.toLowerCase().includes('encrypted');
        const userMessage = isPasswordProtected
          ? 'This PDF is password-protected and cannot be extracted.'
          : `Failed to parse PDF: ${message}`;
        return {
          content: [{ type: 'text' as const, text: userMessage }],
          details: { error: message },
        };
      }

      // Extract and clean text
      let text = pdfData.text.trim();
      if (text.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'No text could be extracted from this PDF. It may be image-only (scanned) or use unsupported encoding.',
            },
          ],
          details: { error: 'empty_text' },
        };
      }

      // Truncate if needed
      const wasTruncated = text.length > MAX_CHARS;
      if (wasTruncated) {
        text = text.slice(0, MAX_CHARS - TRUNCATED_NOTICE.length) + TRUNCATED_NOTICE;
        context.logger.info(
          { originalLength: pdfData.text.length, truncatedLength: text.length },
          'PDF content truncated to size limit',
        );
      }

      // Derive title: prefer explicit param, then PDF metadata, then URL filename
      const urlFilename =
        decodeURIComponent(new URL(safeUrl).pathname.split('/').pop() ?? '').replace(/\.pdf$/i, '') ||
        'PDF Document';
      const pdfTitle =
        typeof pdfData.info['Title'] === 'string' && pdfData.info['Title'].trim().length > 0
          ? pdfData.info['Title'].trim()
          : undefined;
      const title = params.title ?? pdfTitle ?? urlFilename;

      const now = new Date().toISOString();
      const id = uuidv4();

      let category = 'articles';
      let tags = params.tags ?? [];
      let gist: string | undefined;

      const shouldCategorize = params.categorize !== false; // default true
      if (shouldCategorize && context.config.anthropicApiKey) {
        onUpdate?.({
          content: [{ type: 'text', text: 'Categorizing PDF content with AI...' }],
          details: { phase: 'categorizing' },
        });

        try {
          const mode: ProcessingMode = 'full';
          const vocabulary = context.sqlite.getTopTagsWithCounts(50);
          const result = await categorizeContent(
            title,
            text,
            mode,
            context.config.anthropicApiKey as string,
            context.logger,
            (message) =>
              onUpdate?.({
                content: [{ type: 'text', text: message }],
                details: { phase: 'categorizing' },
              }),
            context.config.defaultModel as string,
            undefined,
            vocabulary,
          );

          category = result.category;
          tags = result.tags;
          if ('gist' in result) {
            gist = result.gist;
          }
          context.logger.info({ category, tags }, 'PDF auto-categorized');
        } catch (error) {
          context.logger.error({ error }, 'Auto-categorization failed, using defaults');
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
        sourceUrl: safeUrl,
        status: 'saved',
        inputSource: 'file',
      };
      if (gist) metadata.gist = gist;

      // Prepend PDF-specific metadata as a header block in the content
      const pageCount = pdfData.numpages;
      const pdfAuthor =
        typeof pdfData.info['Author'] === 'string' && pdfData.info['Author'].trim().length > 0
          ? pdfData.info['Author'].trim()
          : undefined;

      if (pdfAuthor) metadata.author = pdfAuthor;

      const header =
        `**Source:** ${safeUrl}\n` +
        `**Pages:** ${pageCount}\n` +
        `**Extracted characters:** ${pdfData.text.length.toLocaleString()}${wasTruncated ? ' (truncated)' : ''}\n` +
        (pdfAuthor ? `**Author:** ${pdfAuthor}\n` : '') +
        '\n---\n\n';

      const fullContent = header + text;

      const filePath = context.markdown.save(metadata, fullContent);
      context.sqlite.upsertNote(metadata, fullContent, filePath);

      try {
        const vector = await context.generateEmbedding(text.slice(0, 8000));
        await context.vectorDb.upsert({
          id,
          text: text.slice(0, 8000),
          vector,
          type: 'article',
          title,
        });
      } catch {
        // Non-fatal — note is saved even if embedding fails
      }

      let responseText = `Saved PDF "${title}" (id: ${id})\n`;
      responseText += `Source: ${safeUrl}\n`;
      responseText += `Pages: ${pageCount}\n`;
      responseText += `Extracted: ${pdfData.text.length.toLocaleString()} characters`;
      if (wasTruncated) responseText += ' (truncated to 500 000 characters)';
      responseText += `\nCategory: ${category}\n`;
      responseText += `Tags: [${tags.join(', ')}]`;
      if (gist) responseText += `\nGist: ${gist}`;

      return {
        content: [{ type: 'text' as const, text: responseText }],
        details: { id, filePath, title, category, tags, pageCount, wasTruncated },
      };
    },
  };
}
