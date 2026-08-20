# Distributed Wagering Processor

Minha solução para o desafio técnico da Jungle Gaming. As decisões de design, trade-offs e limitações que assumi estão detalhadas no `ARCHITECTURE.md`, recomendo dar uma lida lá antes de revisar o código, porque várias escolhas (principalmente em concorrência e idempotência) só fazem sentido com o contexto do porquê.

## Onde as coisas estão

Implementei o domínio completo (Money, Wallet, WagerTransaction, Ledger, Inbox/Outbox), o caso de uso central com idempotência e concorrência real, a API HTTP inteira (incluindo reconciliação e as consultas por transactionId/externalId), o consumer SQS com dedup/retry/shutdown gracioso, o worker que resolve referências pendentes, o outbox publisher rodando por padrão, e uma camada básica de observabilidade (logs estruturados + métricas em `/metrics`).

Os testes de unidade, concorrência (com paralelismo real contra Postgres) e integração estão passando. Deixei documentadas as limitações que ainda existem na seção 10 do `ARCHITECTURE.md`, nenhuma delas mexe nas garantias que o desafio pede como centrais (correção financeira, concorrência, idempotência).

## Stack

- Bun 1.x (runtime, package manager e test runner)
- TypeScript em modo estrito
- NestJS
- PostgreSQL (acesso direto via `pg`, não MikroORM, explico o porquê no ARCHITECTURE.md)
- AWS SQS via LocalStack
- Docker Compose

## Rodando localmente

```bash
# instala as dependências
bun install

# sobe Postgres e LocalStack
docker compose up -d postgres localstack

# as migrations rodam sozinhas na primeira subida do volume do Postgres.
# se você já tinha o volume de antes da migration 002 existir, roda manualmente:
Get-Content migrations/002_add_reference_check_attempts.sql | docker exec -i jungle-gaming-challenge-postgres-1 psql -U wagering -d wagering

# testes
bun test test/unit
bun test test/concurrency    # precisa de DATABASE_URL, ver abaixo
bun test test/integration    # idem

# sobe a aplicação (API + outbox publisher + pending reference worker)
$env:DATABASE_URL="postgres://wagering:wagering@localhost:5433/wagering"
$env:PORT="3000"
bun run src/main.ts
```

Uma observação sobre a porta: deixei o Postgres do Docker na `5433` em vez da `5432` padrão, porque na minha máquina Windows já tinha um Postgres nativo instalado ocupando a `5432` e os dois entravam em conflito. A porta interna da rede do Docker continua `5432` normalmente, isso só afeta como você acessa de fora.

## Os dois workers que rodam sozinhos

Assim que a aplicação sobe, dois workers já começam a rodar em background, sem precisar configurar nada a mais:

- **PendingReferenceWorker**, a cada 5s fica de olho em REFUND/ROLLBACK que chegaram antes da transação que eles referenciam, e tenta resolver.
- **OutboxPublisherWorker**, a cada 2s publica os eventos pendentes no SQS. Só funciona de verdade se você tiver setado `WAGER_EVENTS_QUEUE_URL`; sem isso, os eventos continuam sendo gravados na tabela `outbox_messages` normalmente, só não saem pra fila.

Pra ativar a publicação de eventos:

```bash
docker exec -it jungle-gaming-challenge-localstack-1 awslocal sqs create-queue \
  --queue-name wager-events.fifo --attributes FifoQueue=true

$env:WAGER_EVENTS_QUEUE_URL="http://localhost:4566/000000000000/wager-events.fifo"
```

## Testando o consumer de entrada

O consumer que processa a fila `wager-transactions.fifo` é opcional, ligado por variável de ambiente:

```bash
# cria a fila e a DLQ
docker exec -it jungle-gaming-challenge-localstack-1 awslocal sqs create-queue \
  --queue-name wager-transactions-dlq.fifo --attributes FifoQueue=true
docker exec -it jungle-gaming-challenge-localstack-1 awslocal sqs create-queue \
  --queue-name wager-transactions.fifo --attributes FifoQueue=true

# sobe a aplicação com o consumer ligado
$env:DATABASE_URL="postgres://wagering:wagering@localhost:5433/wagering"
$env:AWS_ENDPOINT="http://localhost:4566"
$env:AWS_REGION="us-east-1"
$env:AWS_ACCESS_KEY_ID="test"
$env:AWS_SECRET_ACCESS_KEY="test"
$env:SQS_QUEUE_URL="http://localhost:4566/000000000000/wager-transactions.fifo"
$env:SQS_DLQ_URL="http://localhost:4566/000000000000/wager-transactions-dlq.fifo"
$env:ENABLE_SQS_CONSUMER="true"
$env:PORT="3000"
bun run src/main.ts

# em outro terminal, manda uma mensagem de teste. Salvei o JSON num arquivo
# e copiei pra dentro do container em vez de passar direto na linha de
# comando, porque tive bastante dor de cabeça com escaping de aspas entre
# PowerShell -> Docker -> shell do container (detalhes no ARCHITECTURE.md
# se você passar pelo mesmo problema)
docker cp message.json jungle-gaming-challenge-localstack-1:/tmp/message.json
docker exec -i jungle-gaming-challenge-localstack-1 awslocal sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id "wallet-test" --message-deduplication-id "msg-1" \
  --message-body file:///tmp/message.json
```

Se der certo, aparece `[SqsConsumer] processed messageId=... status=...` no log.

## Métricas e logs

```bash
curl http://localhost:3000/metrics
```

Isso devolve métricas em formato Prometheus: transações por status, quantas duplicatas idempotentes foram pegas, conflitos de optimistic lock, retries e lag da outbox, redeliveries do SQS e profundidade da DLQ (quando `SQS_DLQ_URL` está configurada). Os logs saem em JSON pro stdout, com `correlationId`/`transactionId`/`walletId`/`providerId` quando fizer sentido.

## Testes

```bash
bun test test/unit          # domínio puro, sem infra
bun test test/concurrency   # paralelismo real contra Postgres
bun test test/integration   # constraints do schema, atomicidade, outbox, referências fora de ordem
```

Os dois últimos precisam do `DATABASE_URL` setado e dos containers de pé.

## O que ainda ficou faltando

Tudo documentado com mais detalhe na seção 10 do `ARCHITECTURE.md`, mas resumindo: não escrevi um teste automatizado dedicado pro consumer de entrada (validei manualmente, e a lógica de negócio que ele usa já está coberta pelos testes de concorrência); não implementei autenticação (o desafio deixa isso como opcional, documentei a decisão); e não fiz teste de carga (`bun run test:load`), que é diferencial, não obrigatório.