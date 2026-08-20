/**
 * Registro de métricas em memória (seção 12 do desafio: "métricas cobrindo,
 * no mínimo: transações por status, duplicatas detectadas, retries,
 * mensagens em DLQ, conflitos de lock, outbox lag e latência de
 * processamento").
 *
 * Trade-off documentado (ver ARCHITECTURE.md): isto é um registro simples
 * em memória, não Prometheus client real nem OpenTelemetry — que são
 * explicitamente opcionais no desafio. Isso significa que as métricas são
 * por instância (não agregadas entre múltiplas réplicas) e se perdem em
 * um restart. Suficiente para demonstrar os pontos de instrumentação
 * corretos, não para operar em produção multi-instância sem um agregador
 * externo (que é exatamente o que o Prometheus faria via scraping de cada
 * instância, então o formato de exposição já é compatível).
 */
class MetricsRegistry {
  private counters = new Map<string, number>();
  private histogramSamples = new Map<string, number[]>();
  private gauges = new Map<string, number>();

  incrementCounter(name: string, labels: Record<string, string> = {}, by = 1): void {
    const key = this.key(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }

  observeHistogram(name: string, value: number, labels: Record<string, string> = {}): void {
    const key = this.key(name, labels);
    const samples = this.histogramSamples.get(key) ?? [];
    samples.push(value);
    // Mantém uma janela limitada para não crescer indefinidamente em
    // processos de longa duração — não precisamos do histórico completo,
    // só o suficiente para calcular percentis aproximados.
    if (samples.length > 1000) samples.shift();
    this.histogramSamples.set(key, samples);
  }

  setGauge(name: string, value: number, labels: Record<string, string> = {}): void {
    const key = this.key(name, labels);
    this.gauges.set(key, value);
  }

  /** Exposição no formato de texto do Prometheus (suficiente para scraping). */
  renderPrometheusText(): string {
    const lines: string[] = [];

    for (const [key, value] of this.counters) {
      lines.push(`${this.toPromLine(key)} ${value}`);
    }
    for (const [key, value] of this.gauges) {
      lines.push(`${this.toPromLine(key)} ${value}`);
    }
    for (const [key, samples] of this.histogramSamples) {
      if (samples.length === 0) continue;
      const sorted = [...samples].sort((a, b) => a - b);
      const p50 = percentile(sorted, 0.5);
      const p95 = percentile(sorted, 0.95);
      const p99 = percentile(sorted, 0.99);
      const base = key.replace(/^([a-zA-Z0-9_]+)/, '$1');
      lines.push(`${base}{quantile="0.5"} ${p50}`);
      lines.push(`${base}{quantile="0.95"} ${p95}`);
      lines.push(`${base}{quantile="0.99"} ${p99}`);
      lines.push(`${base}_count ${samples.length}`);
    }

    return lines.join('\n') + '\n';
  }

  private key(name: string, labels: Record<string, string>): string {
    const labelKeys = Object.keys(labels).sort();
    if (labelKeys.length === 0) return name;
    const labelStr = labelKeys.map((k) => `${k}="${labels[k]}"`).join(',');
    return `${name}{${labelStr}}`;
  }

  private toPromLine(key: string): string {
    return key;
  }
}

function percentile(sortedValues: number[], p: number): number {
  if (sortedValues.length === 0) return 0;
  const idx = Math.min(sortedValues.length - 1, Math.floor(p * sortedValues.length));
  return sortedValues[idx];
}

export const metrics = new MetricsRegistry();

// --- Helpers específicos do domínio (nomes alinhados à seção 12) ---

export function recordTransactionByStatus(status: string): void {
  metrics.incrementCounter('wagering_transactions_total', { status });
}

export function recordIdempotentDuplicate(): void {
  metrics.incrementCounter('wagering_idempotent_duplicates_total');
}

export function recordOptimisticLockConflict(): void {
  metrics.incrementCounter('wagering_optimistic_lock_conflicts_total');
}

export function recordOutboxRetry(): void {
  metrics.incrementCounter('wagering_outbox_retries_total');
}

export function recordOutboxLagMs(lagMs: number): void {
  metrics.observeHistogram('wagering_outbox_lag_ms', lagMs);
}

export function recordProcessingLatencyMs(latencyMs: number): void {
  metrics.observeHistogram('wagering_processing_latency_ms', latencyMs);
}

export function setDlqDepth(count: number): void {
  metrics.setGauge('wagering_dlq_messages', count);
}

export function recordSqsRedelivery(): void {
  metrics.incrementCounter('wagering_sqs_redeliveries_total');
}
