import type { UnitOfWork, WagerTransactionRepository } from '../ports';
import { SubmitWagerTransactionUseCase } from '../use-cases/submit-wager-transaction.use-case';
import { WagerTransactionStatus } from '../../domain/wager-transaction';

export class PendingReferenceWorker {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly transactions: WagerTransactionRepository,
    private readonly useCase: SubmitWagerTransactionUseCase,
  ) {}

  async runOnce(): Promise<{ resolved: number; stillPending: number; timedOut: number }> {
    const batch = await this.uow.run((tx) => this.transactions.findPendingReferenceBatch(100, tx));

    let resolved = 0;
    let stillPending = 0;
    let timedOut = 0;

    for (const pending of batch) {
      const result = await this.useCase.resumePendingReference(pending.id);

      if (result.status === WagerTransactionStatus.Processed) {
        resolved += 1;
      } else if (result.status === WagerTransactionStatus.Rejected) {
        timedOut += 1;
      } else {
        stillPending += 1;
      }
    }

    return { resolved, stillPending, timedOut };
  }
}
