import { Controller, Get, HttpException, HttpStatus, Inject } from '@nestjs/common';
import { Pool } from 'pg';
import { TOKENS } from '../../tokens';

/**
 * Health checks não exigem autenticação (ver seção 2 do desafio).
 * /live: processo está de pé, sem checar dependências externas.
 * /ready: PostgreSQL (e, quando o consumer SQS existir, o próprio SQS)
 *         estão alcançáveis.
 */
@Controller('health')
export class HealthController {
  constructor(@Inject(TOKENS.PG_POOL) private readonly pool: Pool) {}

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready() {
    try {
      await this.pool.query('SELECT 1');
      return { status: 'ok', postgres: 'reachable' };
    } catch (err) {
      throw new HttpException(
        { status: 'unavailable', postgres: 'unreachable' },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }
}
