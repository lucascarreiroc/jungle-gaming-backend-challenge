# Distributed Wagering Processor

Solução para o desafio técnico da Jungle Gaming. Ver `ARCHITECTURE.md` para
decisões de design, trade-offs e limitações conhecidas.

## Status deste repositório

Todos os requisitos funcionais obrigatórios do desafio estão implementados:
domínio completo (Money, Wallet, WagerTransaction, Ledger, Inbox/Outbox),
caso de uso central com idempotência e concorrência real, API HTTP completa
(incluindo reconciliação e consultas por transactionId/externalId), consumer
SQS com dedup/retry/shutdown gracioso, worker de referências pendentes com
limite de tentativas, outbox publisher rodando por padrão, e observabilidade
básica (logs estruturados + métricas em `/metrics`).

Testes de unidade, concorrência (paralelismo real contra Postgres) e
integração (constraints do schema, atomicidade, outbox, referências fora de
ordem, reconciliação) estão implementados e passando. As limitações
conhecidas e remanescentes estão documentadas na seção 10 de
`ARCHITECTURE.md` — nenhuma delas afeta as garantias centrais do desafio
(correção financeira, concorrência, idempotência).

## Stack

- Runtime: Bun 1.x (test runner) / Node.js (compatível para desenvolvimento)
- Linguagem: TypeScript em modo estrito
- Framework: NestJS
- Banco: PostgreSQL (acesso via `pg`, ver ARCHITECTURE.md seção 7 sobre a
  escolha de não usar MikroORM diretamente)
- Mensageria: AWS SQS via LocalStack
- Orquestração local: Docker Compose

## Setup

```bash
# 1. Instalar dependências
bun install

# 2. Subir Postgres e LocalStack
docker compose up -d postgres localstack

# 3. As migrations rodam automaticamente na primeira inicialização do
#    volume do Postgres (ver docker-compose.yml). Se o volume já existia
#    de uma execução anterior (antes da migration 002 existir), aplique
#    manualmente:
#    Get-Content migrations/002_add_reference_check_attempts.sql | docker exec -i jungle-gaming-challenge-postgres-1 psql -U wagering -d wagering

# 4. Rodar os testes
bun test test/unit
bun test test/concurrency    # requer DATABASE_URL setado, ver abaixo
bun test test/integration    # idem

# 5. Subir a aplicação (API HTTP + outbox publisher + pending reference worker)
$env:DATABASE_URL="postgres://wagering:wagering@localhost:5433/wagering"
$env:PORT="3000"
bun run src/main.ts
```

**Nota sobre a porta do Postgres:** o `docker-compose.yml` expõe o Postgres
na porta `5433` do host (não `5432`), porque `5432` colide com um
PostgreSQL nativo instalado no Windows em algumas máquinas de
desenvolvimento. A porta interna da rede Docker continua `5432`.

## Workers automáticos

Sempre que a aplicação sobe (`bun run src/main.ts`), dois workers rodam em
background automaticamente, sem configuração extra:

- **PendingReferenceWorker** (a cada 5s) — resolve REFUND/ROLLBACK que
  chegaram antes da transação referenciada.
- **OutboxPublisherWorker** (a cada 2s) — publica eventos pendentes no SQS.
  Só ativa de fato se `WAGER_EVENTS_QUEUE_URL` estiver definida (ver abaixo);
  caso contrário, os eventos continuam sendo gravados na tabela
  `outbox_messages` normalmente, só não são publicados.

Para ativar a publicação de eventos de verdade:

```bash
docker exec -it jungle-gaming-challenge-localstack-1 awslocal sqs create-queue \
  --queue-name wager-events.fifo --attributes FifoQueue=true

$env:WAGER_EVENTS_QUEUE_URL="http://localhost:4566/000000000000/wager-events.fifo"
```

## Testando o SqsConsumer (entrada de transações via fila)

O consumer de entrada (que processa `wager-transactions.fifo`) é opcional e
ativado por variável de ambiente:

```bash
# 1. Cria a fila de entrada e a DLQ
docker exec -it jungle-gaming-challenge-localstack-1 awslocal sqs create-queue \
  --queue-name wager-transactions-dlq.fifo --attributes FifoQueue=true
docker exec -it jungle-gaming-challenge-localstack-1 awslocal sqs create-queue \
  --queue-name wager-transactions.fifo --attributes FifoQueue=true

# 2. Sobe a aplicação com o consumer habilitado
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

# 3. Em outro terminal, publica uma mensagem de teste (salve o JSON num
#    arquivo e copie para dentro do container, para evitar problemas de
#    escaping de aspas entre PowerShell/Docker/shell interno — ver
#    ARCHITECTURE.md se precisar do passo a passo detalhado)
docker cp message.json jungle-gaming-challenge-localstack-1:/tmp/message.json
docker exec -i jungle-gaming-challenge-localstack-1 awslocal sqs send-message \
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo \
  --message-group-id "wallet-test" --message-deduplication-id "msg-1" \
  --message-body file:///tmp/message.json
```

O log da aplicação mostra `[SqsConsumer] processed messageId=... status=...`
quando a mensagem é processada com sucesso.

## Métricas e logs

```bash
curl http://localhost:3000/metrics
```

Retorna métricas em formato de texto do Prometheus: transações por status,
duplicatas idempotentes detectadas, conflitos de optimistic lock, retries e
lag da outbox, redeliveries do SQS, e profundidade da DLQ (se
`SQS_DLQ_URL` estiver configurada). Logs de aplicação saem em JSON
estruturado (`stdout`), com `correlationId`/`transactionId`/`walletId`/
`providerId` quando aplicável.

## Testes

```bash
bun test test/unit          # domínio, sem dependências externas
bun test test/concurrency   # paralelismo real contra Postgres
bun test test/integration   # constraints, atomicidade, outbox, referências fora de ordem
```

Os dois últimos exigem `DATABASE_URL` setado e os containers rodando.

## Limitações conhecidas

Ver seção 10 de `ARCHITECTURE.md` para a lista completa. Resumo: o
`SqsConsumer` de entrada foi validado manualmente mas não tem teste
automatizado dedicado (a lógica de idempotência/dedup que ele reutiliza,
porém, está coberta pelos testes de concorrência); autenticação não foi
implementada (decisão documentada, conforme permitido pela seção 2 do
desafio); teste de carga (`bun run test:load`) não foi implementado —
diferencial opcional, não requisito.
