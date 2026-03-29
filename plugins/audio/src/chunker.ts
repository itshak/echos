/**
 * Audio chunker — splits large audio files into Whisper-compatible pieces.
 *
 * Whisper has a strict 25 MB file size limit. When a URL serves a file larger
 * than that, we download it in sequential byte-range requests and pass each
 * chunk separately to the API. Whisper handles partial audio gracefully;
 * the caller concatenates the resulting transcripts.
 *
 * No native binary dependencies (no ffmpeg): chunks are split at byte
 * boundaries only.
 */

export const WHISPER_MAX_BYTES = 25 * 1024 * 1024; // 25 MB

// Leave a small margin so the multipart form overhead stays under the limit.
const CHUNK_SIZE = 24 * 1024 * 1024; // 24 MB

export interface AudioChunk {
  data: Buffer;
  /** Byte offset of this chunk within the original file. */
  start: number;
  /** Last byte index (inclusive) within the original file. */
  end: number;
  index: number;
  total: number;
}

/**
 * Download an audio file in fixed-size chunks using HTTP Range requests.
 *
 * Throws if the server does not honour the `Range` header (i.e. returns
 * 200 OK instead of 206 Partial Content on the first request), because the
 * file is already known to exceed the Whisper limit and cannot be chunked.
 */
export async function downloadInChunks(
  url: string,
  totalBytes: number,
): Promise<AudioChunk[]> {
  const chunks: AudioChunk[] = [];
  let offset = 0;
  let index = 0;
  const total = Math.ceil(totalBytes / CHUNK_SIZE);

  while (offset < totalBytes) {
    const end = Math.min(offset + CHUNK_SIZE - 1, totalBytes - 1);

    const response = await fetch(url, {
      headers: { Range: `bytes=${offset}-${end}` },
      signal: AbortSignal.timeout(120_000),
      redirect: 'error',
    });

    if (!response.ok) {
      throw new Error(`Failed to download chunk ${index + 1}/${total}: HTTP ${response.status}`);
    }

    // A 200 response means the server ignored the Range header and sent the
    // full file. We cannot safely chunk it, so drain the body and bail out.
    if (response.status !== 206) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(
        'The audio server does not support HTTP Range requests (responded with ' +
        `HTTP ${response.status} instead of 206). The file (${totalBytes} bytes) ` +
        'exceeds the Whisper 25 MB limit and cannot be processed without range support.',
      );
    }

    const data = Buffer.from(await response.arrayBuffer());

    chunks.push({ data, start: offset, end, index, total });

    offset = end + 1;
    index++;
  }

  return chunks;
}

/**
 * Download an audio file fully (for files ≤ WHISPER_MAX_BYTES or when
 * Content-Length is unknown).
 *
 * Performs an early size check from the Content-Length header, then streams
 * the body with a hard byte cap to prevent unbounded memory usage.
 */
export async function downloadFull(url: string): Promise<Buffer> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(120_000),
    redirect: 'error',
  });

  if (!response.ok) {
    throw new Error(`Failed to download audio: HTTP ${response.status} ${response.statusText}`);
  }

  // Early rejection based on Content-Length when available.
  const contentLengthHeader = response.headers.get('content-length');
  if (contentLengthHeader !== null) {
    const declared = Number.parseInt(contentLengthHeader, 10);
    if (Number.isFinite(declared) && declared > WHISPER_MAX_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(
        `Audio file is too large (${declared} bytes); maximum allowed is ${WHISPER_MAX_BYTES} bytes`,
      );
    }
  }

  // Stream with an explicit max-bytes cap to avoid unbounded buffering.
  const body = response.body;
  if (body !== null) {
    const reader = (body as ReadableStream<Uint8Array>).getReader();
    const bufferChunks: Uint8Array[] = [];
    let received = 0;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;

      received += value.byteLength;
      if (received > WHISPER_MAX_BYTES) {
        await reader.cancel('Audio file exceeds maximum allowed size').catch(() => undefined);
        throw new Error(
          `Audio file is too large (exceeded ${WHISPER_MAX_BYTES} bytes while downloading); ` +
          'please trim or compress the audio below 25 MB and try again.',
        );
      }

      bufferChunks.push(value);
    }

    const result = new Uint8Array(received);
    let byteOffset = 0;
    for (const chunk of bufferChunks) {
      result.set(chunk, byteOffset);
      byteOffset += chunk.byteLength;
    }

    return Buffer.from(result.buffer, result.byteOffset, result.byteLength);
  }

  // Fallback: no streaming reader available — use arrayBuffer but still enforce the limit.
  const arrayBuffer = await response.arrayBuffer();
  if (arrayBuffer.byteLength > WHISPER_MAX_BYTES) {
    throw new Error(
      `Audio file is too large (${arrayBuffer.byteLength} bytes); maximum allowed is ${WHISPER_MAX_BYTES} bytes`,
    );
  }

  return Buffer.from(arrayBuffer);
}

/**
 * Probe a URL with `Range: bytes=0-0` to discover the total file size without
 * downloading the full body. Returns the total byte count if the server
 * supports range requests and includes a `Content-Range` header; otherwise
 * returns `undefined`.
 */
export async function probeContentLength(url: string): Promise<number | undefined> {
  try {
    const response = await fetch(url, {
      headers: { Range: 'bytes=0-0' },
      signal: AbortSignal.timeout(10_000),
      redirect: 'error',
    });

    // Drain or cancel the single-byte body immediately.
    await response.body?.cancel().catch(() => undefined);

    if (response.status !== 206) return undefined;

    // Content-Range: bytes 0-0/TOTAL
    const contentRange = response.headers.get('content-range');
    if (!contentRange) return undefined;

    const match = /\/(\d+)$/.exec(contentRange);
    if (!match) return undefined;

    const total = Number.parseInt(match[1]!, 10);
    return Number.isFinite(total) && total > 0 ? total : undefined;
  } catch {
    return undefined;
  }
}
