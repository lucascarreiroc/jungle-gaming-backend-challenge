import { Controller, Get, Header } from '@nestjs/common';
import { metrics } from '../../infrastructure/observability/metrics';

/**
 * Exposição de métricas em formato de texto do Prometheus (seção 12 do
 * desafio). Não exige autenticação, assim como os health checks — é
 * considerado infraestrutura de observabilidade, não dado de negócio.
 */
@Controller('metrics')
export class MetricsController {
  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4')
  get(): string {
    return metrics.renderPrometheusText();
  }
}
