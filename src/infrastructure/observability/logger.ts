/**
 * Logger estruturado mínimo (seção 12 do desafio): saída em JSON, com
 * campos de correlação padronizados. Não é uma biblioteca completa de
 * observabilidade (Pino/Winston) — é o suficiente para atender ao requisito
 * de "logs estruturados com correlationId, messageId, transactionId,
 * walletId, providerId" sem adicionar uma dependência nova ao projeto.
 *
 * Regra importante: nunca passar o payload financeiro completo (ex.: o
 * objeto `money` inteiro, ou o corpo bruto da requisição) em `context` —
 * só IDs, status e metadados. Isso é responsabilidade de quem chama o
 * logger, não algo que o logger valida automaticamente.
 */
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
    // eslint-disable-next-line no-console
    console.error(line);
  } else if (level === 'warn') {
    // eslint-disable-next-line no-console
    console.warn(line);
  } else {
    // eslint-disable-next-line no-console
    console.log(line);
  }
}
