import type { Logger } from 'pino';
import type { ScheduleEntry } from '@echos/shared';
import type { PreparedStatements } from './sqlite-schema.js';

export interface ScheduleOps {
  upsertSchedule(schedule: ScheduleEntry): void;
  getSchedule(id: string): ScheduleEntry | undefined;
  listSchedules(enabledOnly?: boolean): ScheduleEntry[];
  deleteSchedule(id: string): boolean;
}

function rowToScheduleEntry(row: Record<string, unknown>): ScheduleEntry {
  return {
    id: row['id'] as string,
    jobType: row['job_type'] as string,
    cron: row['cron'] as string,
    enabled: row['enabled'] === 1,
    description: row['description'] as string,
    config: JSON.parse(row['config'] as string) as Record<string, unknown>,
    created: row['created'] as string,
    updated: row['updated'] as string,
  };
}

export function createScheduleOps(
  _db: unknown,
  stmts: PreparedStatements,
  _logger: Logger,
): ScheduleOps {
  return {
    upsertSchedule(schedule: ScheduleEntry): void {
      stmts.upsertSchedule.run({
        id: schedule.id,
        jobType: schedule.jobType,
        cron: schedule.cron,
        enabled: schedule.enabled ? 1 : 0,
        description: schedule.description,
        config: JSON.stringify(schedule.config),
        created: schedule.created,
        updated: schedule.updated,
      });
    },

    getSchedule(id: string): ScheduleEntry | undefined {
      const row = stmts.getSchedule.get(id) as Record<string, unknown> | undefined;
      if (!row) return undefined;
      return rowToScheduleEntry(row);
    },

    listSchedules(enabledOnly?: boolean): ScheduleEntry[] {
      const rows =
        enabledOnly === undefined
          ? (stmts.listAllSchedules.all() as Record<string, unknown>[])
          : (stmts.listSchedules.all(enabledOnly ? 1 : 0) as Record<string, unknown>[]);
      return rows.map(rowToScheduleEntry);
    },

    deleteSchedule(id: string): boolean {
      const info = stmts.deleteSchedule.run(id);
      return info.changes > 0;
    },
  };
}
