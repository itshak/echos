export type InstallMethod = 'homebrew' | 'git' | 'docker' | 'manual';

/**
 * Detects how EchOS was installed by checking environment and filesystem clues.
 */
export function detectInstallMethod(): InstallMethod {
  // Docker: /.dockerenv exists or CONTAINER env var
  if (process.env['CONTAINER'] || process.env['container']) {
    return 'docker';
  }
  try {
    const { accessSync } = require('node:fs') as typeof import('node:fs');
    accessSync('/.dockerenv');
    return 'docker';
  } catch {
    // not docker
  }

  // Homebrew: running script path contains /Cellar/ or /homebrew/
  const scriptPath = process.argv[1] ?? '';
  if (scriptPath.includes('/Cellar/') || scriptPath.includes('/homebrew/')) {
    return 'homebrew';
  }

  // Git: .git directory at project root (walk up like getVersion())
  try {
    const { existsSync } = require('node:fs') as typeof import('node:fs');
    const { dirname, join } = require('node:path') as typeof import('node:path');
    const { fileURLToPath } = require('node:url') as typeof import('node:url');
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6; i++) {
      if (existsSync(join(dir, '.git'))) {
        return 'git';
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // cannot check
  }

  return 'manual';
}

/**
 * Pure semver comparison for X.Y.Z strings.
 * Returns -1 if current < latest, 0 if equal, 1 if current > latest.
 * Returns 0 on parse failure (no false positives).
 */
export function compareSemver(current: string, latest: string): -1 | 0 | 1 {
  const parse = (v: string): [number, number, number] | null => {
    const match = v.replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)$/);
    if (!match) return null;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  };

  const c = parse(current);
  const l = parse(latest);
  if (!c || !l) return 0;

  for (let i = 0; i < 3; i++) {
    if (c[i]! < l[i]!) return -1;
    if (c[i]! > l[i]!) return 1;
  }
  return 0;
}

/**
 * Returns installation-specific update instructions.
 */
export function getUpdateInstructions(method: InstallMethod): string {
  switch (method) {
    case 'homebrew':
      return 'brew update && brew upgrade echos';
    case 'git':
      return 'pnpm update-echos';
    case 'docker':
      return 'docker compose pull && docker compose up -d';
    case 'manual':
      return 'https://github.com/albinotonnina/echos/releases';
  }
}

/**
 * Fetches the latest release from GitHub.
 * Returns null on any error. 10s timeout.
 */
export async function fetchLatestRelease(
  owner: string,
  repo: string,
): Promise<{ version: string; url: string } | null> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    const response = await fetch(
      `https://api.github.com/repos/${owner}/${repo}/releases/latest`,
      {
        headers: { Accept: 'application/vnd.github+json' },
        signal: controller.signal,
      },
    );

    clearTimeout(timeout);

    if (!response.ok) return null;

    const data = (await response.json()) as { tag_name?: string; html_url?: string };
    const tagName = data.tag_name;
    if (!tagName || !/^v?\d+\.\d+\.\d+$/.test(tagName)) return null;

    return {
      version: tagName.replace(/^v/, ''),
      url: data.html_url ?? `https://github.com/${owner}/${repo}/releases/latest`,
    };
  } catch {
    return null;
  }
}

/**
 * Formats the update notification message.
 */
export function formatUpdateNotification(
  currentVersion: string,
  latestVersion: string,
  installMethod: InstallMethod,
  releaseUrl: string,
): string {
  const instructions = getUpdateInstructions(installMethod);
  const howTo =
    installMethod === 'manual'
      ? `Download the latest release:\n${instructions}`
      : `How to update:\n${instructions}`;

  return [
    '📦 *EchOS Update Available*',
    '',
    `A new version of EchOS is available: v${latestVersion} (you're running v${currentVersion}).`,
    '',
    howTo,
    '',
    `View release notes: ${releaseUrl}`,
  ].join('\n');
}
