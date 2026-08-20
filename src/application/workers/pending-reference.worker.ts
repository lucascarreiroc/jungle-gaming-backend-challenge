import type { UnitOfWork, WagerTransactionRepository, Clock } from '../ports';
import { SubmitWagerTransactionUseCase } from '../use-cases/submit-wager-transaction.use-case';

// Ver ARCHITECTURE.md secao 10, item 5: o limite abaixo ainda nao e aplicado
// porque o contador de tentativas nao esta persistido neste scaffold.
const MAX_REFERENCE_WAIT_ATTEMPTS = 10;
void MAX_REFERENCE_WAIT_ATTEMPTS;

/**
 * Reprocessa transacoes em PENDING_REFERENCE (REFUND/ROLLBACK que chegaram
 * antes da transacao que referenciam). Rodado periodicamente por um
 * scheduler externo. Usa FOR UPDATE SKIP LOCKED (dentro do repositorio) para
 * ser seguro com multiplas instancias do worker.
 *
 * Limitacao conhecida (ver ARCHITECTURE.md): o caminho de "resubmeter via
 * useCase" e de "marcar como REJECTED apos esgotar tentativas" ainda nao
 * estao implementados - o worker hoje so classifica o lote entre resolvido
 * (referencia ja existe) e ainda pendente.
 */
export class PendingReferenceWorker {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly transactions: WagerTransactionRepository,
    private readonly useCase: SubmitWagerTransactionUseCase,
    private readonly clock: Clock,
  ) {
    void this.useCase;
    void this.clock;
  }

  async runOnce(): Promise<{ resolved: number; stillPending: number; timedOut: number }> {
    const batch = await this.uow.run((tx) => this.transactions.findPendingReferenceBatch(100, tx));

    let resolved = 0;
    let stillPending = 0;
    const timedOut = 0;

    for (const pending of batch) {
      const reference = await this.uow.run((tx) =>
        this.transactions.findByExternalId(
          pending.providerId,
          pending.referenceExternalTransactionId!,
          tx,
        ),
      );

      if (reference && reference.status === 'PROCESSED') {
        // TODO: resubmeter via this.useCase, reaproveitando toda a logica
        // de idempotencia/concorrencia (ver ARCHITECTURE.md).
        resolved += 1;
        continue;
      }

      // TODO(retry-count): persistir um contador de tentativas por transacao
      // para decidir aqui quando atingir MAX_REFERENCE_WAIT_ATTEMPTS e
      // marcar como FAILED/REJECTED com FailureCode.REFERENCE_NOT_FOUND_TIMEOUT.
      stillPending += 1;
    }

    return { resolved, stillPending, timedOut };
  }
}
