import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  compareSemver,
  getUpdateInstructions,
  fetchLatestRelease,
  formatUpdateNotification,
} from './update-checker.js';

describe('compareSemver', () => {
  it('returns 0 for equal versions', () => {
    expect(compareSemver('1.0.0', '1.0.0')).toBe(0);
  });

  it('returns 0 for equal versions with v prefix', () => {
    expect(compareSemver('v1.2.3', 'v1.2.3')).toBe(0);
  });

  it('returns -1 when current is older (patch)', () => {
    expect(compareSemver('0.13.1', '0.13.2')).toBe(-1);
  });

  it('returns -1 when current is older (minor)', () => {
    expect(compareSemver('0.13.1', '0.14.0')).toBe(-1);
  });

  it('returns -1 when current is older (major)', () => {
    expect(compareSemver('0.13.1', '1.0.0')).toBe(-1);
  });

  it('returns 1 when current is newer', () => {
    expect(compareSemver('0.14.0', '0.13.1')).toBe(1);
  });

  it('returns 0 for malformed current version', () => {
    expect(compareSemver('bad', '1.0.0')).toBe(0);
  });

  it('returns 0 for malformed latest version', () => {
    expect(compareSemver('1.0.0', 'bad')).toBe(0);
  });

  it('returns 0 for both malformed', () => {
    expect(compareSemver('nope', 'nah')).toBe(0);
  });

  it('handles v prefix mixed', () => {
    expect(compareSemver('v1.0.0', '1.0.1')).toBe(-1);
  });
});

describe('getUpdateInstructions', () => {
  it('returns brew command for homebrew', () => {
    expect(getUpdateInstructions('homebrew')).toBe('brew update && brew upgrade echos');
  });

  it('returns pnpm command for git', () => {
    expect(getUpdateInstructions('git')).toBe('pnpm update-echos');
  });

  it('returns docker compose command for docker', () => {
    expect(getUpdateInstructions('docker')).toBe('docker compose pull && docker compose up -d');
  });

  it('returns releases URL for manual', () => {
    expect(getUpdateInstructions('manual')).toBe('https://github.com/albinotonnina/echos/releases');
  });
});

describe('fetchLatestRelease', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns version and url on success', async () => {
    const mockResponse = {
      ok: true,
      json: async () => ({
        tag_name: 'v0.14.0',
        html_url: 'https://github.com/albinotonnina/echos/releases/tag/v0.14.0',
      }),
    };
    vi.mocked(fetch).mockResolvedValue(mockResponse as Response);

    const result = await fetchLatestRelease('albinotonnina', 'echos');
    expect(result).toEqual({
      version: '0.14.0',
      url: 'https://github.com/albinotonnina/echos/releases/tag/v0.14.0',
    });
  });

  it('returns null on 404', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 404 } as Response);

    const result = await fetchLatestRelease('albinotonnina', 'echos');
    expect(result).toBeNull();
  });

  it('returns null on rate limit (403)', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 403 } as Response);

    const result = await fetchLatestRelease('albinotonnina', 'echos');
    expect(result).toBeNull();
  });

  it('returns null on network error', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('Network failure'));

    const result = await fetchLatestRelease('albinotonnina', 'echos');
    expect(result).toBeNull();
  });

  it('returns null for invalid tag_name format', async () => {
    const mockResponse = {
      ok: true,
      json: async () => ({
        tag_name: 'release-candidate-1',
        html_url: 'https://example.com',
      }),
    };
    vi.mocked(fetch).mockResolvedValue(mockResponse as Response);

    const result = await fetchLatestRelease('albinotonnina', 'echos');
    expect(result).toBeNull();
  });

  it('strips v prefix from tag_name', async () => {
    const mockResponse = {
      ok: true,
      json: async () => ({
        tag_name: 'v1.2.3',
        html_url: 'https://example.com/release',
      }),
    };
    vi.mocked(fetch).mockResolvedValue(mockResponse as Response);

    const result = await fetchLatestRelease('owner', 'repo');
    expect(result?.version).toBe('1.2.3');
  });

  it('accepts tag_name without v prefix', async () => {
    const mockResponse = {
      ok: true,
      json: async () => ({
        tag_name: '2.0.0',
        html_url: 'https://example.com/release',
      }),
    };
    vi.mocked(fetch).mockResolvedValue(mockResponse as Response);

    const result = await fetchLatestRelease('owner', 'repo');
    expect(result?.version).toBe('2.0.0');
  });
});

describe('formatUpdateNotification', () => {
  it('formats notification for git install', () => {
    const msg = formatUpdateNotification('0.13.1', '0.14.0', 'git', 'https://github.com/albinotonnina/echos/releases/tag/v0.14.0');
    expect(msg).toContain('EchOS Update Available');
    expect(msg).toContain('v0.14.0');
    expect(msg).toContain('v0.13.1');
    expect(msg).toContain('pnpm update-echos');
    expect(msg).toContain('https://github.com/albinotonnina/echos/releases/tag/v0.14.0');
  });

  it('formats notification for homebrew install', () => {
    const msg = formatUpdateNotification('0.13.1', '0.14.0', 'homebrew', 'https://example.com');
    expect(msg).toContain('brew update && brew upgrade echos');
  });

  it('formats notification for docker install', () => {
    const msg = formatUpdateNotification('0.13.1', '0.14.0', 'docker', 'https://example.com');
    expect(msg).toContain('docker compose pull');
  });

  it('formats notification for manual install', () => {
    const msg = formatUpdateNotification('0.13.1', '0.14.0', 'manual', 'https://example.com');
    expect(msg).toContain('Download the latest release');
    expect(msg).toContain('https://github.com/albinotonnina/echos/releases');
  });
});
