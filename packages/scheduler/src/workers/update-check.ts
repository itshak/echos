import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { JobData } from '../queue.js';
import {
  getVersion,
  fetchLatestRelease,
  compareSemver,
  detectInstallMethod,
  formatUpdateNotification,
  type NotificationService,
} from '@echos/shared';

/** Module-level dedup: prevents repeated broadcasts within a daemon session. */
let lastNotifiedVersion: string | undefined;

export interface UpdateCheckDeps {
  notificationService: NotificationService;
  logger: Logger;
  disableUpdateCheck?: boolean;
}

/** Creates a BullMQ processor that checks for EchOS updates and notifies the user. */
export function createUpdateCheckProcessor(deps: UpdateCheckDeps) {
  return async (_job: Job<JobData>): Promise<void> => {
    const { notificationService, logger, disableUpdateCheck } = deps;

    if (disableUpdateCheck) {
      logger.debug('Update check: disabled via DISABLE_UPDATE_CHECK');
      return;
    }

    const currentVersion = getVersion();
    if (currentVersion === 'unknown') {
      logger.debug('Update check: current version unknown, skipping');
      return;
    }

    const release = await fetchLatestRelease('albinotonnina', 'echos');
    if (!release) {
      logger.warn('Update check: failed to fetch latest release from GitHub');
      return;
    }

    const cmp = compareSemver(currentVersion, release.version);
    if (cmp >= 0) {
      logger.debug(
        { currentVersion, latestVersion: release.version },
        'Update check: already up to date',
      );
      return;
    }

    // Dedup: don't re-notify for the same version within this daemon session
    if (lastNotifiedVersion === release.version) {
      logger.debug(
        { version: release.version },
        'Update check: already notified about this version',
      );
      return;
    }

    const installMethod = detectInstallMethod();
    const message = formatUpdateNotification(
      currentVersion,
      release.version,
      installMethod,
      release.url,
    );

    await notificationService.broadcast(message);
    lastNotifiedVersion = release.version;

    logger.info(
      { currentVersion, latestVersion: release.version, installMethod },
      'Update check: notification sent',
    );
  };
}
