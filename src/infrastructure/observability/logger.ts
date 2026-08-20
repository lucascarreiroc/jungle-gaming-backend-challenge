export type LogLevel = 'info' | 'warn' | 'error';

export interface LogContext {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
  [key: string]: unknown;
}

export function logEvent(level: LogLevel, message: string, context: LogContext = {}): void {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...context,
  };
  const line = JSON.stringify(entry);

  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}
