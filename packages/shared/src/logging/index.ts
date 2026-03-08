import pino from 'pino';

/**
 * Pino redaction paths — any field matching these paths will be replaced with
 * "[Redacted]" in all log output, preventing accidental secret leakage.
 *
 * Keep this list conservative: over-redacting hides useful debug info, but
 * missing a field can leak credentials into log aggregators.
 */
const redactPaths = [
  // Top-level secret fields
  'apiKey',
  'token',
  'password',
  'secret',
  'authorization',
  'cookie',
  'key',
  'credential',
  'credentials',
  'privateKey',
  'clientSecret',
  'accessToken',
  'refreshToken',
  'bearer',
  // HTTP header spellings (case-insensitive keys map to lowercase in Fastify/Node)
  'headers.authorization',
  'headers.cookie',
  'headers["x-api-key"]',
  // Nested variants (one level deep — covers { config: { apiKey: ... } } etc.)
  '*.apiKey',
  '*.token',
  '*.password',
  '*.secret',
  '*.key',
  '*.credential',
  '*.credentials',
  '*.privateKey',
  '*.clientSecret',
  '*.accessToken',
  '*.refreshToken',
  '*.bearer',
];

export function createLogger(name: string, level: string = 'info'): pino.Logger {
  const options: pino.LoggerOptions = {
    name,
    level,
    redact: redactPaths,
    serializers: {
      err: pino.stdSerializers.err,
    },
  };

  if (process.env['NODE_ENV'] !== 'production') {
    options.transport = { target: 'pino-pretty', options: { colorize: true } };
  }

  return pino(options);
}

export function createAuditLogger(name: string = 'audit'): pino.Logger {
  return pino({
    name,
    level: 'info',
    redact: redactPaths,
    serializers: {
      err: pino.stdSerializers.err,
    },
  });
}

export interface AuditEvent {
  event: string;
  userId?: number;
  details?: Record<string, unknown>;
  timestamp?: string;
}

export function auditLog(logger: pino.Logger, event: AuditEvent): void {
  logger.info({
    ...event,
    timestamp: event.timestamp ?? new Date().toISOString(),
  });
}
