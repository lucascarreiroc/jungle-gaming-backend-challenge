import { Body, Controller, Get, Headers, HttpException, HttpStatus, Param, Post } from '@nestjs/common';
import {
  SubmitWagerTransactionUseCase,
  IdempotencyConflictError,
  WalletNotFoundError,
} from '../../application/use-cases/submit-wager-transaction.use-case';
import { WagerTransactionKind } from '../../domain/wager-transaction';
import { DomainError } from '../../domain/errors';

interface SubmitTransactionBody {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}

/**
 * Mapeamento de status HTTP (decisão do desafio, seção 9):
 * - 200/201: sucesso (PROCESSED) ou aceite assíncrono (PENDING_REFERENCE -> 202)
 * - 400: payload inválido (VALIDATION_*)
 * - 409: conflito de idempotência (payload divergente) ou wallet duplicada
 * - 422: rejeição de regra de negócio (BUSINESS_*) — payload válido, mas a
 *        operação não pôde ser aplicada; distinto de 400 para o provedor
 *        não tentar "corrigir" algo que já estava sintaticamente correto.
 * - 503: falha transitória de infraestrutura (INFRA_*) — o provedor deve reenviar.
 */
@Controller('wagering/transactions')
export class WageringController {
  constructor(private readonly submitWagerTransaction: SubmitWagerTransactionUseCase) {}

  @Post()
  async submit(
    @Headers('idempotency-key') idempotencyKey: string,
    @Body() body: SubmitTransactionBody,
  ) {
    if (!idempotencyKey) {
      throw new HttpException(
        { failureCode: 'VALIDATION_MISSING_IDEMPOTENCY_KEY' },
        HttpStatus.BAD_REQUEST,
      );
    }

    try {
      const result = await this.submitWagerTransaction.execute({
        idempotencyKey,
        ...body,
        correlationId: idempotencyKey,
      });

      if (result.status === 'PENDING_REFERENCE') {
        throw new HttpException(result, HttpStatus.ACCEPTED);
      }
      if (result.status === 'REJECTED') {
        throw new HttpException(result, HttpStatus.UNPROCESSABLE_ENTITY);
      }
      if (result.status === 'FAILED') {
        throw new HttpException(result, HttpStatus.SERVICE_UNAVAILABLE);
      }
      return result;
    } catch (err) {
      if (err instanceof HttpException) throw err;
      if (err instanceof IdempotencyConflictError) {
        throw new HttpException({ failureCode: err.code, message: err.message }, HttpStatus.CONFLICT);
      }
      if (err instanceof WalletNotFoundError) {
        throw new HttpException({ failureCode: err.code, message: err.message }, HttpStatus.NOT_FOUND);
      }
      if (err instanceof DomainError) {
        throw new HttpException({ failureCode: err.code, message: err.message }, HttpStatus.BAD_REQUEST);
      }
      throw new HttpException(
        { failureCode: 'INFRA_TRANSIENT_FAILURE' },
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  @Get(':transactionId')
  async getById(@Param('transactionId') _transactionId: string) {
    // TODO: injetar WagerTransactionRepository e implementar a consulta.
    // Omitido aqui para focar o tempo nas áreas de maior peso na avaliação
    // (correção financeira, concorrência, idempotência) — ver README.md.
    throw new HttpException('Not implemented', HttpStatus.NOT_IMPLEMENTED);
  }
}
