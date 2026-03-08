# HIVE.md — Project Context

## Project Overview

**EchOS** is a secure, self-hosted, agent-driven personal knowledge management system (v0.9.0). It captures, organizes, and retrieves knowledge through natural conversation across three interfaces: **Telegram** (primary/stable), **Web API** (experimental), and **CLI** (standalone, stable).

**Key traits:**

- Single-user by design — intentionally not multi-tenant
- Security-first: data stays on your infrastructure, only calls configured APIs
- Frictionless capture: text, URLs, voice messages, photos
- Obsidian-compatible: all notes are plain markdown files in `data/knowledge/`
- Hybrid search: FTS5 (SQLite) + vector (LanceDB) fused via Reciprocal Rank Fusion (RRF)
- Agent-driven: natural language instead of rigid commands

**Version**: 0.12.0 — approaching 1.0.

## Current Sprint

No active sprint. On `main` branch — no feature work in progress.

## Active Constraints

<!-- Rules that all agents must follow -->

- **WORKTREE MANDATORY**: Never commit directly to `main`. Always work in a git worktree at `../echos-FEATURE_NAME` on branch `feature/FEATURE_NAME` (or `fix/`, `chore/`).
- Follow project conventions and existing code style (TypeScript strict mode, ESM, no `any`)
- Run `pnpm -r build` before every commit — must pass with zero errors
- Run `pnpm vitest run` — no new test failures allowed
- Keep changes focused and minimal; no unsolicited refactors or extra abstractions
- Never use `eval()`, `Function()`, `vm`, or execute shell commands with user-controlled input
- Never log secrets or API keys (Pino redaction is configured)
- Validate all URLs via `validateUrl()` from `@echos/shared` (SSRF prevention)
- Sanitize all external content via `sanitizeHtml()` / `escapeXml()`
- After any feature: update the relevant doc in `docs/`

## Architecture

### Monorepo Structure

```
packages/
  shared/     → Types, security utils (validateUrl, sanitizeHtml), Zod config, Pino logging, error hierarchy, NotificationService
  core/       → Agent, 23 core tools, storage, search, plugin registry, AI categorization
  telegram/   → Telegram bot interface (grammY) — primary interface, InterfaceAdapter
  web/        → Web API (Fastify) — experimental, InterfaceAdapter, binds to 127.0.0.1 only
  cli/        → Standalone CLI binary — no daemon, no InterfaceAdapter
  scheduler/  → BullMQ workers + cron tasks (requires Redis)

plugins/           → Content processors; each implements EchosPlugin
  article/           → save_article; Mozilla Readability + DOMPurify
  youtube/           → save_youtube; transcript extraction + Whisper fallback
  twitter/           → save_tweet; FxTwitter free API, auto thread unrolling
  image/             → save_image; Sharp metadata + EXIF extraction
  content-creation/  → create_content, analyze_my_style, mark_as_voice_example
  digest/            → Daily knowledge digest scheduled job
  journal/           → journal + reflect tools
  resurface/         → get_resurfaced (spaced repetition / on-this-day / random / forgotten modes)
```

### Storage (3 Layers)

| Layer | Technology | Role |
|-------|------------|------|
| Source of truth | Markdown files | `data/knowledge/{type}/{category}/{date}-{slug}.md` with YAML frontmatter |
| Metadata / FTS | SQLite + FTS5 | Structured metadata, full-text search (BM25), tags, reminders, memory store |
| Vector search | LanceDB (embedded) | Embeddings via OpenAI `text-embedding-3-small`, cosine similarity |

- **Startup**: `reconcileStorage` scans all `.md` files, syncs SQLite/LanceDB by content hash
- **Live**: `chokidar` file watcher on `knowledge/**/*.md`, debounced 500ms

### Search

Hybrid (default) = FTS5 BM25 + LanceDB cosine merged via **Reciprocal Rank Fusion (RRF)**. Also supports `keyword` and `semantic` modes independently.

### Agent & LLM

- Framework: `pi-agent-core` + `pi-ai` (23+ provider support)
- Primary provider: Anthropic Claude; also supports any OpenAI-compatible endpoint via `LLM_BASE_URL`
- **Prompt caching**: `CACHE_RETENTION` env (`long` 1h / `short` 5min / `none`); ~90% input token reduction. Custom OpenAI-compatible endpoints force `none`.
- Session IDs: `telegram-{userId}`, `web-{userId}`, `cli-local`
- Custom `echos_context` message type injects date/time context without string concatenation:

  ```typescript
  await agent.prompt([
    createContextMessage(`Current date/time: ${now.toISOString()} UTC`),
    createUserMessage(userInput),
  ]);
  ```

- Model spec resolution: `resolveModel(spec, baseUrl?)` in `packages/core/src/agent/model-resolver.ts`

### AI Categorization

`packages/core/src/agent/categorization.ts` — streaming JSON via `streamSimple` + `parseStreamingJson`. Fires `onProgress` callback as fields resolve. Vocabulary-aware: injects top 50 tags from SQLite into the prompt.

- `lightweight` mode: category + tags
- `full` mode: category + tags + gist + summary + key points

### Tool Definition Pattern

```typescript
import { Type, Static } from '@sinclair/typebox';

const schema = Type.Object({ param: Type.String() });
type Params = Static<typeof schema>;

const tool: AgentTool<typeof schema> = {
  name: 'tool_name',
  description: '...',
  parameters: schema,
  execute: async (_toolCallId: string, params: Params, _signal, onUpdate) => {
    onUpdate?.({ content: [{ type: 'text', text: 'progress' }], details: { phase: 'x' } });
    return { content: [...], details: { ... } };
  },
};
```

**CRITICAL**: `execute` first param must be explicitly typed `_toolCallId: string` to avoid TS7006 in plugin builds.

### Plugin System

Plugins implement `EchosPlugin` and return `AgentTool[]` from `setup(context: PluginContext)`. Context exposes: `sqlite`, `markdown`, `vectorDb`, `generateEmbedding`, `logger`, `config`.

**New plugin checklist — always all 6 steps:**

1. Create `plugins/{name}/package.json`
2. Add to `pnpm-workspace.yaml`
3. `COPY plugins/{name}/package.json ...` in Dockerfile `deps` stage
4. `COPY --from=deps .../plugins/{name}/package.json ...` in Dockerfile `production` stage
5. Add TypeScript path alias in root `tsconfig.json` `paths`
6. Register plugin in daemon entry point `src/index.ts`

### Security Model

| Interface | Auth mechanism |
|-----------|---------------|
| Telegram | User ID whitelist (`ALLOWED_USER_IDS`) enforced in middleware on every message |
| Web API | Bearer token (`WEB_API_KEY`) + `userId` validated against `ALLOWED_USER_IDS`; 127.0.0.1 only |
| CLI | Local only — no networking, no auth required |

- SSRF: `validateUrl()` blocks private IPs, localhost, metadata endpoints
- Rate limiting: token bucket, 20 tokens, 1 token/second refill, per user
- No `eval`, no `Function()`, no AI output executed as code
- Pino log redaction covers all secret field names

### Error Hierarchy (`@echos/shared/errors`)

`ValidationError` (400), `AuthenticationError` (401), `SecurityError` (403), `NotFoundError` (404), `RateLimitError` (429), `ProcessingError` (500, optionally retryable), `ExternalServiceError` (502, retryable)

## Recent Decisions

- **Multi-provider LLM**: Any provider via `pi-ai`; model spec resolved by `resolveModel()` in `packages/core/src/agent/model-resolver.ts`
- **Prompt caching**: `CACHE_RETENTION` env controls Anthropic cache TTL; custom OpenAI endpoints force `none`
- **Export architecture**: Pure serialization in `packages/core/src/export/index.ts`; interfaces handle delivery by listening to the `tool_execution_end` event on the agent; files auto-deleted after 1h by scheduler's `export-cleanup` cron job
- **Context overflow handling**: Layer 1 proactive — `createContextWindow` in `context-manager.ts` slides message window to fit token budget; Layer 2 reactive — `isContextOverflow` from `pi-ai` matches provider-specific error patterns
- **Memory system**: Top 15 memories (by confidence + recency) injected into system prompt at agent creation; `recall_knowledge` tool used for on-demand retrieval when more exist
- **Tag storage**: Comma-separated strings in SQLite; `getAllTagsWithCounts()` uses recursive CTE; `renameTag()` / `mergeTags()` use `',' || tags || ','` wrapping to prevent substring false matches
- **Categorization streaming**: `streamSimple` + `parseStreamingJson` (never throws on partial JSON); `onProgress` fires progressively as `category` → `tags` → `gist` resolve
