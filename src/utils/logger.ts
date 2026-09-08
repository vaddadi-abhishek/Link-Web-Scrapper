/**
 * Lightweight structured logger with timestamps, levels, and tag prefixes.
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const currentLevel: LogLevel = (process.env.LOG_LEVEL?.toLowerCase() as LogLevel) || 'info';

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= (LOG_LEVELS[currentLevel] ?? LOG_LEVELS.info);
}

function formatMessage(level: LogLevel, tag: string, message: string): string {
  const timestamp = new Date().toISOString();
  return `[${timestamp}] [${level.toUpperCase()}] [${tag}] ${message}`;
}

export const logger = {
  debug(tag: string, message: string, ...args: any[]): void {
    if (shouldLog('debug')) {
      console.debug(formatMessage('debug', tag, message), ...args);
    }
  },

  info(tag: string, message: string, ...args: any[]): void {
    if (shouldLog('info')) {
      console.info(formatMessage('info', tag, message), ...args);
    }
  },

  warn(tag: string, message: string, ...args: any[]): void {
    if (shouldLog('warn')) {
      console.warn(formatMessage('warn', tag, message), ...args);
    }
  },

  error(tag: string, message: string, ...args: any[]): void {
    if (shouldLog('error')) {
      console.error(formatMessage('error', tag, message), ...args);
    }
  },
};
