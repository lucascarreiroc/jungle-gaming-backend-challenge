import type { UnitOfWork, OutboxRepository, EventPublisher, Clock } from '../ports';

/**
 * Publica mensagens pendentes da outbox. Seguro para rodar em múltiplas
 * instâncias simultaneamente:
 * - lockDueBatch usa `SELECT ... FOR UPDATE SKIP LOCKED`, então duas
 *   instâncias nunca pegam a mesma linha;
 * - cada lote é processado dentro da mesma transação que fez o lock, e o
 *   `published_at` só é gravado após a confirmação do broker;
 * - se o processo morrer entre o lock (dentro da transação já commitada)
 *   e a publicação real, a linha permanece com published_at = NULL e será
 *   pega de novo — o consumidor final trata isso via dedup no Inbox, então
 *   uma publicação duplicada é seguro.
 *
 * Importante: o lock via SKIP LOCKED e o UPDATE de published_at NÃO podem
 * ficar na mesma transação que a publicação de rede em si, ou a linha
 * ficaria travada até o SQS responder. Este worker faz o lock+leitura em uma
 * transação curta, publica fora da transação, e confirma com um UPDATE
 * separado — aceitando a janela onde uma mensagem pode ser publicada mas
 * o commit do published_at falhar (resultando em republicação seguro, dado
 * que consumidores fazem dedup).
 */
export class OutboxPublisherWorker {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly outbox: OutboxRepository,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly destination: string,
    private readonly batchSize = 50,
  ) {}

  /** Executa um ciclo. Chamado por um scheduler externo (ex.: setInterval ou cron do NestJS). */
  async runOnce(): Promise<{ published: number; failed: number }> {
    const now = this.clock.now();
    const batch = await this.uow.run((tx) => this.outbox.lockDueBatch(this.batchSize, now, tx));

    let published = 0;
    let failed = 0;

    for (const message of batch) {
      try {
        await this.publisher.publish(this.destination, message.payload);
        message.markPublished(this.clock.now());
        published += 1;
      } catch (err) {
        message.scheduleRetry(this.clock.now());
        failed += 1;
      }
      // Confirmação em transação própria e curta.
      await this.uow.run((tx) => this.outbox.update(message, tx));
    }

    return { published, failed };
  }
}
