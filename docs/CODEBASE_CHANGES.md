# Echos Codebase Changes

This document tracks all changes made to the initial Echos codebase, with special focus on token optimization for Groq's 8K TPM limit.

## Table of Contents

1. [STT Provider Abstraction](#1-stt-provider-abstraction)
2. [Coolify Deployment Configuration](#2-coolify-deployment-configuration)
3. [Groq 8K Token Optimization](#3-groq-8k-token-optimization)
4. [Tool Selection Evolution](#4-tool-selection-evolution)
5. [Multilingual Support Improvements](#5-multilingual-support-improvements)

---

## 1. STT Provider Abstraction & Auto-Detection

### Phase 1: Multi-provider abstraction

**Commit:** `df015b0` — feat: add multi-provider STT abstraction

Added support for multiple Speech-to-Text providers through an abstraction layer:

- OpenAI-compatible API
- Groq API
- Local whisper.cpp

**Commit:** `71e8132` — feat: auto-detect STT base URL from model name

Auto-detects the appropriate STT base URL based on the configured model name.

### Phase 2: Provider registry with broad support

Replaced the hardcoded Groq/OpenAI-only detection with a proper provider registry supporting 8 cloud providers:

| Provider     | Key Prefix | Default Model                   |
| ------------ | ---------- | ------------------------------- |
| OpenAI       | `sk-`      | `whisper-1`                     |
| Groq         | `gsk_`     | `whisper-large-v3-turbo`        |
| Together AI  | _(none)_   | `openai/whisper-large-v3-turbo` |
| SiliconFlow  | _(none)_   | `FunAudioLLM/SenseVoiceSmall`   |
| DeepInfra    | _(none)_   | `openai/whisper-large-v3-turbo` |
| Fireworks AI | _(none)_   | `whisper-large-v3-turbo`        |
| Hugging Face | `hf_`      | `openai/whisper-large-v3-turbo` |
| OpenRouter   | `sk-or-`   | `openai/whisper-large-v3-turbo` |

**Detection flow** (in order, first match wins):

1. **Key prefix detection** — Matches API key against known prefixes (e.g., `gsk_` → Groq). Longer prefixes checked first to avoid false matches (`sk-or-` before `sk-`).
2. **Base URL detection** — Matches `STT_BASE_URL` against known provider endpoints.
3. **Model name detection** — Matches `STT_MODEL` against provider-specific hints (e.g., `SenseVoiceSmall` → SiliconFlow).
4. **Cache lookup** — Checks `~/.echos/stt-provider-cache.json` for previously detected provider (24h TTL, keyed by SHA-256 hash of API key).
5. **Probe fallback** — For providers with no detectable key prefix (Together AI, SiliconFlow, DeepInfra, Fireworks AI), hits the `/models` endpoint sequentially with a 5s timeout. First 200 response wins. Result is cached automatically.

**Config changes:**

- `STT_PROVIDER` default changed from `openai-compatible` to `auto`
- New enum values: `auto`, `openai`, `groq`, `together`, `siliconflow`, `deepinfra`, `fireworks`, `huggingface`, `openrouter`, `local`
- `createSttClient()` is now async to support probing

**Files changed:**

- `packages/core/src/stt/registry.ts` — New provider registry with detection functions, caching, and probing
- `packages/core/src/stt/factory.ts` — Rewritten to use registry-based resolution with async probing fallback
- `packages/shared/src/config/index.ts` — Extended STT provider enum
- `.env.example` — Updated documentation for all providers

---

## 2. Coolify Deployment Configuration

**Commit:** `f25b302` — feat: add Coolify deployment configuration

Added deployment configuration files for Coolify:

- `.env.coolify` — environment variables for Coolify deployment
- `COOLIFY.md` — deployment documentation
- Updated `Dockerfile` and `docker-compose.yml`

---

## 3. Groq 8K Token Optimization

The Groq free tier has an 8,000 tokens-per-minute (TPM) limit. The initial codebase was sending ~33K tokens per request, causing failures. Below are all steps taken to reduce token usage.

### Step 1: Configurable Context Window

**Commit:** `622f406` — feat: add configurable context window for Groq free tier

- Added `MAX_CONTEXT_TOKENS` environment variable (default: 80,000, set to ~6,000 for Groq)
- Root cause identified: full conversation history was sent with each request (~40K tokens)
- Files changed: `agent/index.ts`, `agent/types.ts`, `stt/factory.ts`, `config/index.ts`, `agent-deps.ts`

### Step 2: Dynamic Tool Selection

**Commit:** `3492d03` — feat: add dynamic tool selection to stay under Groq TPM limits

- Instead of sending all 14+ tools (~30K tokens), implemented message categorization to select only relevant tools
- Token reduction: 50-70% for most queries
- Tool categories created: `url_save`, `search_knowledge`, `reminders`, `todos`, `note_management`, `tags`, `reading`, `memory`, `voice`, `export`, `categorize`, `links`
- Wired into Telegram, Web API, and CLI interfaces
- New file: `agent/tool-router.ts` (214 lines)

### Step 3: Aggressive Token Reduction

**Commit:** `0d7dcec` — fix: reduce Groq token usage from 33k to under 8k

Root cause: Groq counts `prompt + max_completion_tokens` towards TPM limit. pi-ai's model registry set `maxTokens=65536` for `gpt-oss-120b`, causing 1755 + 32000 = 33,755 tokens per request.

**Specific changes:**

1. **Override maxTokens for Groq models** — Set to 5,000 in `model-resolver.ts` and `agent/index.ts`
2. **Reduced tool router maxTools** — From 10 to 5 for faster responses
3. **Fixed plural keyword matching** — reminders, todos, alarms
4. **Optimized system prompt** — ~30% reduction in `system-prompt.ts`
5. **Optimized tool schemas** — Shrunk the 7 largest tool definitions:
   - `create-note.ts`
   - `explore-graph.ts`
   - `export-notes.ts`
   - `list-notes.ts`
   - `reminder.ts`
   - `synthesize.ts`
   - `use-template.ts`
6. **Set MAX_CONTEXT_TOKENS=5000** default in `.env.example`
7. **Added token estimation logging** — For debugging token usage
8. **Added context window pruning** — With logging in `context-manager.ts`

### Step 4: Tool Selection Refinement for Non-English

**Commit:** `5959892` — fix: improve tool selection for non-English languages

Improved the tool selection algorithm to better handle non-English user messages.

**Commit:** `ff40639` — fix: send ALL tools to support all languages (fits in Groq 8K TPM)

Reverted to sending all tools after optimizations made it possible to fit within 8K TPM.

**Commit:** `3f8b5da` — fix: restore tool selection — 13 essential tools fit in Groq 8K TPM

Settled on 13 essential tools that fit within the Groq 8K limit.

**Commit:** `4dd6095` — fix: reduce maxCompletion from 5000→1024 for Groq free tier

Further reduced `maxCompletion` from 5,000 to 1,024 to ensure staying under the 8K limit.

### Step 5: Tool Swapping for Multilingual Support

**Commit:** `2195814` — fix: swap tools — remove categorize_note, mark_content; add save_audio, save_image, save_pdf

- Removed: `categorize_note`, `mark_content`
- Added: `save_audio`, `save_image`, `save_pdf`

**Commit:** `b9b00d6` — feat: expand always-available tools from 13 to 25 for better multilingual support

Expanded the always-available tool set from 13 to 25 tools to support better multilingual capabilities.

### Step 6: Language Detection

**Commit:** `93975b9` — feat: detect user language and respond in the same language

Added automatic user language detection and response in the same language.

---

## 4. Tool Selection Evolution Summary

| Stage                | Tools Sent       | maxCompletion | Est. Tokens | Status           |
| -------------------- | ---------------- | ------------- | ----------- | ---------------- |
| Initial              | All 14+          | 65,536        | ~33,755     | ❌ Over 8K limit |
| Configurable context | All              | 65,536        | ~33,755     | ❌ Over 8K limit |
| Dynamic selection    | 1-5 per category | 65,536        | ~10-15K     | ⚠️ Still over    |
| Aggressive reduction | 13 essential     | 5,000         | ~6,755      | ✅ Under 8K      |
| Further reduction    | 13 essential     | 1,024         | ~2,779      | ✅ Well under    |
| Final                | 25 expanded      | 1,024         | ~5-6K       | ✅ Under 8K      |

---

## 5. Multilingual Support Improvements

The final state includes:

- Language detection for user messages
- Expanded tool set (25 tools) for multilingual support
- Optimized tool schemas that fit within Groq's 8K TPM limit
- Response in the detected user language
