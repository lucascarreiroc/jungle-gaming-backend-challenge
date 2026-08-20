import { Controller, Get, Header } from '@nestjs/common';
import { metrics } from '../../infrastructure/observability/metrics';

@Controller('metrics')
export class MetricsController {
  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4')
  get(): string {
    return metrics.renderPrometheusText();
  }
}
