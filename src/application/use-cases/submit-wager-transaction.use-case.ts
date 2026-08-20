import { createHash } from 'crypto';
import { Money } from '../../domain/money';
import type { MoneyProps } from '../../domain/money';
import { Wallet } from '../../domain/wallet';
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  LedgerDirection,
} from '../../domain/wager-transaction';
import { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import { OutboxMessage } from '../../domain/inbox-outbox';
import { FailureCode, DomainError } from '../../domain/errors';
import type {
  WalletRepository,
  WagerTransactionRepository,
  LedgerRepository,
  OutboxRepository,
  UnitOfWork,
  Clock,
  IdGenerator,
} from '../ports';
import {
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WagerTransactionPendingReference,
  WalletBalanceChanged,
} from '../../domain/events';
import {
  recordTransactionByStatus,
  recordIdempotentDuplicate,
  recordOptimisticLockConflict,
  recordProcessingLatencyMs,
} from '../../infrastructure/observability/metrics';
import { logEvent } from '../../infrastructure/observability/logger';

export interface SubmitWagerTransactionInput {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  correlationId?: string;
}

export interface SubmitWagerTransactionOutput {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps | null;
  idempotentReplay: boolean;
  failureCode?: FailureCode;
}

export class IdempotencyConflictError extends DomainError {
  constructor() {
    super('Idempotency key reused with a different payload', FailureCode.CONFLICT_IDEMPOTENCY_PAYLOAD_MISMATCH);
  }
}

export class WalletNotFoundError extends DomainError {
  constructor() {
    super('Wallet not found', FailureCode.VALIDATION_MISSING_REFERENCE);
  }
}

const MAX_OPTIMISTIC_LOCK_RETRIES = 5;

/**
 * Limite de tentativas de resolução de referência para REFUND/ROLLBACK
 * (seção 7.1 do desafio). Compartilhado entre o primeiro encontro (via
 * execute()) e as retentativas subsequentes do PendingReferenceWorker.
 */
export const MAX_REFERENCE_WAIT_ATTEMPTS = 10;

/**
 * Canonicaliza o subconjunto de campos de negócio do payload (chaves
 * ordenadas) para gerar o payloadHash. Header e metadados de transporte
 * (Idempotency-Key literal, timestamps de fila, etc.) NÃO entram no hash —
 * apenas o conteúdo que, se mudasse, tornaria a requisição "diferente".
 */
export function computePayloadHash(input: SubmitWagerTransactionInput): string {
  const canonical = {
    providerId: input.providerId,
    externalTransactionId: input.externalTransactionId,
    playerId: input.playerId,
    walletId: input.walletId,
    roundId: input.roundId,
    gameId: input.gameId,
    kind: input.kind,
    money: { amount: input.money.amount, currency: input.money.currency },
    referenceExternalTransactionId: input.referenceExternalTransactionId ?? null,
  };
  const json = JSON.stringify(canonical, Object.keys(canonical).sort());
  return createHash('sha256').update(json).digest('hex');
}

/**
 * Orquestra a submissão de uma WagerTransaction. Usado pelo controller HTTP,
 * pelo consumer SQS (ver seção 10 do desafio: "reutilizar o mesmo use case
 * da entrada HTTP") e pelo PendingReferenceWorker (via resumePendingReference).
 *
 * Estratégia de concorrência (ver seção 8): optimistic locking na Wallet via
 * coluna `version`. Se o UPDATE afeta 0 linhas, o caso de uso re-lê a wallet
 * e retenta a operação de domínio do zero, até MAX_OPTIMISTIC_LOCK_RETRIES
 * vezes. Isso evita lock global compartilhado entre wallets distintas —
 * cada wallet é serializada apenas contra si mesma, então wallets diferentes
 * processam em paralelo sem qualquer contenção entre si.
 *
 * Atomicidade: transação SQL, alteração de saldo, ledger e outbox são
 * confirmados juntos, ou nada é (ver seção 11).
 */
export class SubmitWagerTransactionUseCase {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly wallets: WalletRepository,
    private readonly transactions: WagerTransactionRepository,
    private readonly ledger: LedgerRepository,
    private readonly outbox: OutboxRepository,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  async execute(input: SubmitWagerTransactionInput): Promise<SubmitWagerTransactionOutput> {
    const startedAt = Date.now();
    let result: SubmitWagerTransactionOutput;
    try {
      result = await this.executeInsideTransaction(input);
    } catch (err) {
      // Corrida de idempotência: duas requisições com a MESMA idempotencyKey
      // passaram pelo SELECT antes de qualquer uma commitar (janela real sob
      // alta concorrência). A segunda perde a corrida no INSERT, protegida
      // pela constraint UNIQUE(provider_id, idempotency_key) do schema — não
      // pela lógica de aplicação. Aqui tratamos isso como o que
      // semanticamente é: um replay idempotente, não um erro para o chamador.
      if (this.isIdempotencyUniqueViolation(err)) {
        result = await this.uow.run((tx) =>
          this.buildReplayResponseByKey(input.providerId, input.idempotencyKey, tx),
        );
      } else {
        logEvent('error', 'wager transaction processing failed', {
          providerId: input.providerId,
          externalTransactionId: input.externalTransactionId,
          walletId: input.walletId,
          correlationId: input.correlationId,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    }

    recordProcessingLatencyMs(Date.now() - startedAt);
    recordTransactionByStatus(result.status);
    if (result.idempotentReplay) recordIdempotentDuplicate();

    logEvent('info', 'wager transaction processed', {
      transactionId: result.transactionId,
      providerId: input.providerId,
      walletId: input.walletId,
      correlationId: input.correlationId,
      status: result.status,
      idempotentReplay: result.idempotentReplay,
    });

    return result;
  }

  /**
   * Retoma o processamento de uma transação que está em PENDING_REFERENCE,
   * tentando resolver a referência de novo. Chamado pelo PendingReferenceWorker.
   * Reutiliza a mesma lógica de resolução de referência e mutação de saldo
   * de execute() (via processTransaction) — não é uma cópia paralela dela.
   */
  async resumePendingReference(transactionId: string): Promise<SubmitWagerTransactionOutput> {
    return this.uow.run(async (tx) => {
      const transaction = await this.transactions.findById(transactionId, tx);
      if (!transaction) {
        throw new Error(`WagerTransaction ${transactionId} not found for resumePendingReference`);
      }
      if (transaction.status !== WagerTransactionStatus.PendingReference) {
        // Já foi resolvida por outra instância do worker (ou pelo fluxo
        // síncrono original) entre o momento em que este worker leu o lote
        // e agora — não é um erro, apenas retornamos o estado atual.
        return this.buildReplayResponse(transaction, tx);
      }
      return this.processTransaction(transaction, tx);
    });
  }

  private isIdempotencyUniqueViolation(err: unknown): boolean {
    const pgErr = err as { code?: string; constraint?: string } | undefined;
    return pgErr?.code === '23505' && pgErr?.constraint === 'uq_wager_tx_idempotency';
  }

  private async buildReplayResponseByKey(
    providerId: string,
    idempotencyKey: string,
    tx: unknown,
  ): Promise<SubmitWagerTransactionOutput> {
    const existing = await this.transactions.findByIdempotencyKey(providerId, idempotencyKey, tx);
    if (!existing) {
      throw new Error(
        `Expected an existing transaction for idempotency key ${idempotencyKey} after a unique violation, but none was found`,
      );
    }
    return this.buildReplayResponse(existing, tx);
  }

  private async executeInsideTransaction(
    input: SubmitWagerTransactionInput,
  ): Promise<SubmitWagerTransactionOutput> {
    const payloadHash = computePayloadHash(input);

    return this.uow.run(async (tx) => {
      // 1) Checagem de idempotência - fonte da verdade é (providerId, idempotencyKey).
      const existing = await this.transactions.findByIdempotencyKey(
        input.providerId,
        input.idempotencyKey,
        tx,
      );
      if (existing) {
        if (!existing.matchesPayload(payloadHash)) {
          throw new IdempotencyConflictError();
        }
        // Replay idempotente: retorna o resultado original, incluindo o
        // saldo observado naquele momento (não o saldo atual da wallet).
        return this.buildReplayResponse(existing, tx);
      }

      const money = Money.from(input.money);
      const transaction = WagerTransaction.create({
        id: this.ids.next(),
        providerId: input.providerId,
        externalTransactionId: input.externalTransactionId,
        idempotencyKey: input.idempotencyKey,
        payloadHash,
        walletId: input.walletId,
        playerId: input.playerId,
        roundId: input.roundId,
        gameId: input.gameId,
        kind: input.kind,
        money,
        referenceExternalTransactionId: input.referenceExternalTransactionId,
        createdAt: this.clock.now(),
      });

      await this.transactions.insert(transaction, tx);

      return this.processTransaction(transaction, tx);
    });
  }

  /**
   * Núcleo compartilhado: resolve referência (se necessário) e aplica a
   * mutação de saldo. Chamado tanto para uma transação recém-criada quanto
   * para uma retomada de PENDING_REFERENCE — o comportamento é idêntico nos
   * dois casos, o que evita ter duas implementações divergentes da mesma
   * regra de negócio.
   */
  private async processTransaction(
    transaction: WagerTransaction,
    tx: unknown,
  ): Promise<SubmitWagerTransactionOutput> {
    const money = transaction.money;
    const correlationId = transaction.id;

    // 2) Resolve referência para REFUND/ROLLBACK.
    let reference: WagerTransaction | null = null;
    if (transaction.requiresReference()) {
      reference = await this.transactions.findByExternalId(
        transaction.providerId,
        transaction.referenceExternalTransactionId!,
        tx,
      );
      if (!reference || reference.status !== WagerTransactionStatus.Processed) {
        transaction.incrementReferenceCheckAttempts();

        if (transaction.referenceCheckAttempts >= MAX_REFERENCE_WAIT_ATTEMPTS) {
          // Esgotado o limite de tentativas (seção 7.1): rejeita com um
          // failureCode que identifica especificamente esse motivo, e
          // publica o evento correspondente.
          transaction.reject(FailureCode.REFERENCE_NOT_FOUND_TIMEOUT);
          await this.transactions.update(transaction, tx);
          await this.enqueueEvent(
            WagerTransactionRejected.from(
              {
                transactionId: transaction.id,
                walletId: transaction.walletId,
                providerId: transaction.providerId,
                externalTransactionId: transaction.externalTransactionId,
                failureCode: FailureCode.REFERENCE_NOT_FOUND_TIMEOUT,
              },
              { correlationId },
            ),
            tx,
          );
          return {
            transactionId: transaction.id,
            status: transaction.status,
            balance: null,
            idempotentReplay: false,
            failureCode: transaction.failureCode,
          };
        }

        transaction.markPendingReference();
        await this.transactions.update(transaction, tx);
        await this.enqueueEvent(
          WagerTransactionPendingReference.from(
            {
              transactionId: transaction.id,
              walletId: transaction.walletId,
              providerId: transaction.providerId,
              externalTransactionId: transaction.externalTransactionId,
              referenceExternalTransactionId: transaction.referenceExternalTransactionId!,
            },
            { correlationId },
          ),
          tx,
        );
        return {
          transactionId: transaction.id,
          status: transaction.status,
          balance: null,
          idempotentReplay: false,
        };
      }

      // Nota: "uma referência não pode ser revertida duas vezes pelo mesmo
      // tipo de operação" é garantido pelos índices únicos parciais
      // uq_wager_tx_single_refund_per_reference / ..._rollback_per_reference
      // no schema (ver migrations/001_init.sql), não por uma checagem aqui.
    }

    // 3) Aplica a mutação de saldo com retry em caso de conflito otimista.
    if (!transaction.affectsBalance()) {
      transaction.markProcessed(reference?.id, this.clock.now());
      await this.transactions.update(transaction, tx);
      await this.enqueueEvent(
        WagerTransactionProcessed.from(
          {
            transactionId: transaction.id,
            walletId: transaction.walletId,
            providerId: transaction.providerId,
            externalTransactionId: transaction.externalTransactionId,
            kind: transaction.kind,
            money: money.toJSON(),
            balanceAfter: (await this.mustFindWallet(transaction.walletId, tx)).balance.toJSON(),
          },
          { correlationId },
        ),
        tx,
      );
      return {
        transactionId: transaction.id,
        status: transaction.status,
        balance: null,
        idempotentReplay: false,
      };
    }

    let attempt = 0;
    for (;;) {
      attempt += 1;
      const wallet = await this.mustFindWallet(transaction.walletId, tx);
      const expectedVersion = wallet.version;

      try {
        const mutation = this.applyMutation(wallet, transaction, money, reference);

        const updateResult = await this.wallets.updateWithOptimisticLock(wallet, expectedVersion, tx);
        if (!updateResult.updated) {
          recordOptimisticLockConflict();
          if (attempt >= MAX_OPTIMISTIC_LOCK_RETRIES) {
            transaction.fail(FailureCode.INFRA_TRANSIENT_FAILURE);
            await this.transactions.update(transaction, tx);
            throw new Error('Exceeded optimistic lock retries for wallet ' + wallet.id);
          }
          continue; // re-lê a wallet e tenta de novo
        }

        const direction = transaction.ledgerDirectionFor(reference ?? undefined);
        const entry = WalletLedgerEntry.create({
          id: this.ids.next(),
          walletId: wallet.id,
          transactionId: transaction.id,
          direction,
          money,
          balanceBefore: mutation.balanceBefore,
          balanceAfter: mutation.balanceAfter,
          createdAt: this.clock.now(),
        });
        await this.ledger.insert(entry, tx);

        transaction.markProcessed(reference?.id, this.clock.now());
        await this.transactions.update(transaction, tx);

        await this.enqueueEvent(
          WalletBalanceChanged.from(
            {
              walletId: wallet.id,
              transactionId: transaction.id,
              direction,
              money: money.toJSON(),
              balanceBefore: mutation.balanceBefore.toJSON(),
              balanceAfter: mutation.balanceAfter.toJSON(),
              walletVersion: mutation.newVersion,
            },
            { correlationId },
          ),
          tx,
        );
        await this.enqueueEvent(
          WagerTransactionProcessed.from(
            {
              transactionId: transaction.id,
              walletId: wallet.id,
              providerId: transaction.providerId,
              externalTransactionId: transaction.externalTransactionId,
              kind: transaction.kind,
              money: money.toJSON(),
              balanceAfter: mutation.balanceAfter.toJSON(),
            },
            { correlationId },
          ),
          tx,
        );

        return {
          transactionId: transaction.id,
          status: transaction.status,
          balance: mutation.balanceAfter.toJSON(),
          idempotentReplay: false,
        };
      } catch (err) {
        if (err instanceof DomainError) {
          transaction.reject(err.code);
          await this.transactions.update(transaction, tx);
          await this.enqueueEvent(
            WagerTransactionRejected.from(
              {
                transactionId: transaction.id,
                walletId: transaction.walletId,
                providerId: transaction.providerId,
                externalTransactionId: transaction.externalTransactionId,
                failureCode: err.code,
              },
              { correlationId },
            ),
            tx,
          );
          return {
            transactionId: transaction.id,
            status: transaction.status,
            balance: null,
            idempotentReplay: false,
            failureCode: err.code,
          };
        }
        throw err;
      }
    }
  }

  private applyMutation(
    wallet: Wallet,
    transaction: WagerTransaction,
    money: Money,
    reference: WagerTransaction | null,
  ) {
    const direction = transaction.ledgerDirectionFor(reference ?? undefined);
    switch (transaction.kind) {
      case WagerTransactionKind.Bet:
        return wallet.debit(money, this.clock.now());
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return wallet.credit(money, this.clock.now());
      case WagerTransactionKind.Rollback:
        return direction === LedgerDirection.Credit
          ? wallet.reverseDebit(money, this.clock.now())
          : wallet.reverseCredit(money, this.clock.now());
      default:
        throw new Error(`Unsupported kind for balance mutation: ${transaction.kind}`);
    }
  }

  private async mustFindWallet(walletId: string, tx: unknown): Promise<Wallet> {
    const wallet = await this.wallets.findById(walletId, tx);
    if (!wallet) throw new WalletNotFoundError();
    return wallet;
  }

  private async enqueueEvent(event: { toJSON(): Record<string, unknown> }, tx: unknown): Promise<void> {
    const message = OutboxMessage.enqueue(event as any);
    await this.outbox.insert(message, tx);
  }

  private async buildReplayResponse(
    existing: WagerTransaction,
    tx: unknown,
  ): Promise<SubmitWagerTransactionOutput> {
    const wallet = await this.wallets.findById(existing.walletId, tx);
    return {
      transactionId: existing.id,
      status: existing.status,
      balance: wallet ? wallet.balance.toJSON() : null,
      idempotentReplay: true,
      failureCode: existing.failureCode,
    };
  }
}
