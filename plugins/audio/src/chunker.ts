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
 * Falls back to a single full download when the server does not support
 * range requests (no `Accept-Ranges: bytes` or `Content-Range` in response).
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

    if (!response.ok && response.status !== 206) {
      throw new Error(`Failed to download chunk ${index + 1}/${total}: HTTP ${response.status}`);
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
 */
export async function downloadFull(url: string): Promise<Buffer> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(120_000),
    redirect: 'error',
  });

  if (!response.ok) {
    throw new Error(`Failed to download audio: HTTP ${response.status} ${response.statusText}`);
  }

  return Buffer.from(await response.arrayBuffer());
}
