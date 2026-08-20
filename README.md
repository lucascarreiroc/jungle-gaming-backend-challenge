# Distributed Wagering Processor

Solução para o desafio técnico da Jungle Gaming. Ver `ARCHITECTURE.md` para
decisões de design, trade-offs e limitações conhecidas — leitura recomendada
antes da apresentação.

## Status deste repositório

Este é um **scaffold funcional em progresso**, não uma solução 100% completa.
O domínio (Money, Wallet, WagerTransaction, Ledger, Inbox/Outbox), o caso de
uso central (`SubmitWagerTransactionUseCase`), a API HTTP, e o `SqsConsumer`
estão implementados. Testes de unidade e de concorrência (com paralelismo
real contra Postgres) estão passando. Testes de integração mais amplos,
observabilidade e o endpoint de reconciliação **ainda não foram
implementados** — ver a seção 10 de `ARCHITECTURE.md` para a lista completa
e priorizada do que falta.

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

# 3. A migration já roda automaticamente na primeira inicialização do
#    volume do Postgres (ver docker-compose.yml). Para rodar manualmente:
#    Get-Content migrations/001_init.sql | docker exec -i jungle-gaming-challenge-postgres-1 psql -U wagering -d wagering

# 4. Rodar os testes
bun test test/unit
bun test test/concurrency   # requer DATABASE_URL setado, ver abaixo

# 5. Subir a aplicação (API HTTP)
$env:DATABASE_URL="postgres://wagering:wagering@localhost:5433/wagering"
$env:PORT="3000"
bun run src/main.ts
```

**Nota sobre a porta do Postgres:** o `docker-compose.yml` expõe o Postgres
na porta `5433` do host (não `5432`), porque `5432` colide com um
PostgreSQL nativo instalado no Windows em algumas máquinas de
desenvolvimento. A porta interna da rede Docker continua `5432` — isso não
afeta a comunicação entre containers, só o acesso a partir do seu SO.

## Testando o SqsConsumer

O consumer não roda por padrão junto com a API HTTP — é ativado por uma
variável de ambiente, para simplificar a demonstração local no mesmo
processo (em produção real, rodaria como um deployment separado).

```bash
# 1. Cria a fila e a DLQ no LocalStack (a fila FIFO exige o sufixo .fifo)
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
$env:ENABLE_SQS_CONSUMER="true"
$env:PORT="3000"
bun run src/main.ts

# 3. Em outro terminal, publica uma mensagem de teste
docker exec -it jungle-gaming-challenge-localstack-1 awslocal sqs send-message `
  --queue-url http://localhost:4566/000000000000/wager-transactions.fifo `
  --message-group-id "wallet-test" `
  --message-body '{\"messageId\":\"msg-1\",\"type\":\"WagerTransactionRequested\",\"occurredAt\":\"2026-01-01T00:00:00.000Z\",\"data\":{\"providerId\":\"provider-a\",\"externalTransactionId\":\"tx-sqs-1\",\"idempotencyKey\":\"provider-a:tx-sqs-1\",\"playerId\":\"SEU_PLAYER_ID\",\"walletId\":\"SEU_WALLET_ID\",\"roundId\":\"round-1\",\"gameId\":\"fortune-chimp\",\"kind\":\"BET\",\"money\":{\"amount\":\"10.00\",\"currency\":\"BRL\"}}}'
```

O log da aplicação deve mostrar a mensagem sendo processada e removida da
fila. Consulte `GET /wallets/:walletId` para confirmar que o saldo mudou.

## Testes

```bash
bun test test/unit          # implementado e passando
bun test test/integration   # estrutura criada, specs pendentes
bun test test/concurrency   # estrutura criada, specs pendentes
```

## Próximos passos antes da submissão final

Em ordem de prioridade (pela tabela de avaliação do desafio):

1. ~~Testes de concorrência com paralelismo real~~ — ✅ feito
   (`test/concurrency/`).
2. ~~`SqsConsumer`~~ — ✅ implementado (`src/infrastructure/sqs/sqs-consumer.ts`),
   incluindo dedup via inbox, distinção de erro de negócio/transitório/permanente,
   e shutdown gracioso em SIGTERM. **Validado manualmente e funcionando**
   (ver seção "Testando o SqsConsumer" acima). **Ainda falta**: um teste de
   integração automatizado (hoje só validado manualmente) e provisionamento
   automático das filas (hoje é um comando manual via `awslocal`).
3. **Testes de integração** mais amplos com Postgres/LocalStack reais em
   container (10 pts) — migrations/constraints isoladamente, o SqsConsumer
   fim-a-fim, DLQ, redelivery.
4. ~~Endpoint de reconciliação~~ — ✅ implementado
   (`POST /wallets/:walletId/reconciliation`).
5. Observabilidade (logs estruturados, métricas).

## Comandos de teste de carga (quando implementado)

```bash
bun run test:load
```
