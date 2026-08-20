import { Body, Controller, Get, Headers, HttpException, HttpStatus, Inject, Param, Post } from '@nestjs/common';
import {
  SubmitWagerTransactionUseCase,
  IdempotencyConflictError,
  WalletNotFoundError,
} from '../../application/use-cases/submit-wager-transaction.use-case';
import { WagerTransactionKind } from '../../domain/wager-transaction';
import { DomainError } from '../../domain/errors';
import type { WagerTransactionRepository, UnitOfWork } from '../../application/ports';
import { TOKENS } from '../../tokens';

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

@Controller()
export class WageringController {
  constructor(
    private readonly submitWagerTransaction: SubmitWagerTransactionUseCase,
    @Inject(TOKENS.WAGER_TRANSACTION_REPOSITORY) private readonly transactions: WagerTransactionRepository,
    @Inject(TOKENS.UNIT_OF_WORK) private readonly uow: UnitOfWork,
  ) {}

  @Post('wagering/transactions')
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

  @Get('wagering/transactions/:transactionId')
  async getById(@Param('transactionId') transactionId: string) {
    const transaction = await this.uow.run((tx) => this.transactions.findById(transactionId, tx));
    if (!transaction) {
      throw new HttpException('Transaction not found', HttpStatus.NOT_FOUND);
    }
    return this.toResponse(transaction);
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async getByProviderAndExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ) {
    const transaction = await this.uow.run((tx) =>
      this.transactions.findByExternalId(providerId, externalTransactionId, tx),
    );
    if (!transaction) {
      throw new HttpException('Transaction not found', HttpStatus.NOT_FOUND);
    }
    return this.toResponse(transaction);
  }

  private toResponse(transaction: Awaited<ReturnType<WagerTransactionRepository['findById']>>) {
    if (!transaction) return null;
    return {
      transactionId: transaction.id,
      providerId: transaction.providerId,
      externalTransactionId: transaction.externalTransactionId,
      walletId: transaction.walletId,
      playerId: transaction.playerId,
      roundId: transaction.roundId,
      gameId: transaction.gameId,
      kind: transaction.kind,
      money: transaction.money.toJSON(),
      status: transaction.status,
      referenceExternalTransactionId: transaction.referenceExternalTransactionId ?? null,
      failureCode: transaction.failureCode ?? null,
      createdAt: transaction.createdAt,
      processedAt: transaction.processedAt ?? null,
    };
  }
}
