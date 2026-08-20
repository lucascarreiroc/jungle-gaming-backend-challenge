# ARCHITECTURE.md - Distributed Wagering Processor

## 1. Como organizei o código

Separei em três camadas:

- **Domain** (`src/domain`): entidades e value objects puros, sem depender de framework, ORM ou infra nenhuma. `Money`, `Wallet`, `WagerTransaction`, `WalletLedgerEntry`, `InboxMessage`, `OutboxMessage`.
- **Application** (`src/application`): os casos de uso e as portas (interfaces) que o domínio usa pra falar com o mundo de fora, sem saber como esse mundo é implementado (`ports.ts`).
- **Infrastructure/Interfaces** (`src/infrastructure`, `src/interfaces`): as implementações concretas, Postgres via `pg`, controllers HTTP do NestJS, o consumer SQS.

Fiz essa separação principalmente porque queria conseguir testar o domínio e os casos de uso inteiramente em memória (os testes de unidade), sem precisar subir Postgres nem LocalStack pra isso. De quebra, também fica mais fácil trocar a forma de persistir sem mexer em regra de negócio.

## 2. Money - por que Decimal em vez de number

`amount` nunca passa por `number`/`float`/`double` em lugar nenhum do fluxo: chega como string decimal na API, vira `Decimal` (uso a lib `decimal.js`) dentro do domínio, e é persistido como `NUMERIC(19,2)` no Postgres, que também não trabalha com ponto flutuante binário.

A escala fica fixa em 2 casas decimais logo na entrada (`Money.from`), o que já elimina qualquer ambiguidade de arredondamento, nunca existe um "quase 25.00", ou é exatamente "25.00" ou a operação é rejeitada ali mesmo.

## 3. Como resolvi concorrência

A unidade de concorrência é a `walletId`, como o desafio pede. Optei por **optimistic locking com retry limitado**, e não lock pessimista (`SELECT ... FOR UPDATE`). Alguns motivos:

- Apostas são operações curtas e de alta frequência, lock pessimista aumentaria a contenção em wallets "quentes" (jogador muito ativo) sem necessidade real, já que a maioria das tentativas nem chega a colidir de fato.
- O optimistic lock (coluna `version`, `UPDATE ... WHERE id = ? AND version = ?`) é barato: falha rápido (0 linhas afetadas) e deixa o use case decidir o que fazer, reler e tentar de novo, até `MAX_OPTIMISTIC_LOCK_RETRIES = 5`.
- Cada wallet fica serializada só contra ela mesma, wallets diferentes processam em paralelo sem nenhum lock compartilhado entre elas, que é justamente o que o desafio pede quando fala pra não usar lock global.

**Trade-off que assumi conscientemente**: sob contenção muito extrema numa única wallet (muitas requisições ao mesmo tempo pro mesmo jogador), o retry pode esgotar as 5 tentativas e a transação vira `FAILED` com `INFRA_TRANSIENT_FAILURE`, sinalizando pro provedor reenviar. Acho isso aceitável no domínio de apostas (na prática um jogador não dispara 5+ apostas simultâneas), mas seria uma escolha diferente se fosse, por exemplo, uma wallet corporativa recebendo milhares de transações por segundo, aí um lock pessimista com fila explícita seria mais previsível.

### O cenário obrigatório do desafio

Saldo inicial 100.00, duas apostas de 80.00 ao mesmo tempo:

1. As duas requisições leem a wallet com `version = 1`, `balance = 100.00`.
2. As duas aplicam `wallet.debit(80.00)` em memória, cada uma calcula `balance = 20.00`, `version = 2` no seu próprio processo (isso é seguro porque é estado em memória local, não compartilhado ainda).
3. As duas tentam `UPDATE wallets SET balance=20.00, version=2 WHERE id=? AND version=1`.
4. O Postgres serializa os dois UPDATEs. O primeiro que chegar afeta 1 linha e grava `version=2`. O segundo, avaliado depois, não acha mais nenhuma linha com `version=1` afeta 0 linhas.
5. O primeiro segue o caminho normal de sucesso (ledger, outbox, `PROCESSED`).
6. O segundo recebe `updated: false`, relê a wallet (agora com `version=2`, `balance=20.00`), tenta `wallet.debit(80.00)` de novo, e aí sim `InsufficientBalanceError` estoura porque `20.00 < 80.00`. Fica `REJECTED` com `BUSINESS_INSUFFICIENT_BALANCE`.

Resultado: uma `PROCESSED`, uma `REJECTED`, saldo final `20.00`, um único lançamento de débito no ledger. O `test/unit/wallet.spec.ts` mostra o comportamento do domínio isolado, e `test/concurrency/` prova isso com paralelismo de verdade contra Postgres.

## 4. Idempotência

A fonte da verdade é o `UNIQUE (provider_id, idempotency_key)` no schema (`wager_transactions`), não um cache em memória. O fluxo:

1. Faço `SELECT` por `(provider_id, idempotency_key)` dentro da mesma transação que vai fazer o `INSERT`, se já existir, comparo o `payloadHash`.
2. Payload igual → devolvo uma resposta de replay (`idempotentReplay: true`), com o `status` e o saldo observados *no momento original*, não recalculados.
3. Payload diferente → `IdempotencyConflictError` (409).
4. Se não existir, o `INSERT` segue normalmente. Agora, se duas requisições concorrentes com a mesma key chegarem realmente ao mesmo tempo (as duas passam pelo `SELECT` antes de qualquer `INSERT` committar), o Postgres resolve isso no nível do `INSERT`: a segunda transação **bloqueia** até a primeira committar, e aí recebe um erro `unique_violation` (SQLSTATE `23505`) na constraint `uq_wager_tx_idempotency`. Achei esse caso enquanto escrevia o teste de 50 requisições em paralelo e precisei tratar explicitamente: o `SubmitWagerTransactionUseCase.execute()` captura esse erro específico, abre uma transação nova e curta, busca a linha que venceu, e devolve a mesma resposta de replay que o caminho normal devolveria, quem chamou nunca vê essa corrida como erro. Está coberto no `test/concurrency/wallet-concurrency.spec.ts` ("the same bet submitted 50 times in parallel").

O `payloadHash` é um SHA-256 de um JSON canônico (chaves ordenadas) do subconjunto de campos de negócio, nunca inclui o header `Idempotency-Key` em si nem nada de transporte. Está em `computePayloadHash`, dentro de `submit-wager-transaction.use-case.ts`.

## 5. Transactional Outbox

Toda mutação financeira (wallet + ledger + transação + eventos) acontece dentro de uma única transação SQL (`UnitOfWork.run`). Os eventos de integração são serializados e inseridos na tabela `outbox_messages` **na mesma transação**, nunca publico direto no SQS de dentro do caso de uso, que é justamente a garantia de "nunca publicar evento antes do commit".

Um worker separado (`OutboxPublisherWorker`) roda de tempos em tempos, faz `SELECT ... FOR UPDATE SKIP LOCKED` pra pegar um lote de mensagens pendentes sem esbarrar em outros publishers, publica cada uma no SQS, e marca `published_at` numa transação curta separada.

**Um trade-off que quero deixar claro**: o lock (`SKIP LOCKED`) é liberado assim que a transação de leitura do lote termina, ele não fica segurando a linha durante a chamada de rede pro SQS (isso travaria a linha pelo tempo inteiro da chamada, o que é ruim). Isso significa que, numa janela pequena, duas instâncias *poderiam* teoricamente pegar a mesma mensagem em lotes que se sobrepõem no tempo. A segurança final não vem de o lock ser exclusivo durante toda a publicação, e sim do **consumidor final fazer dedup via Inbox**, publicação duplicada é algo que o próprio desafio já assume como aceitável. Vale deixar isso explícito porque é fácil assumir errado que `SKIP LOCKED` sozinho já garante exclusividade ponta a ponta.

## 6. Inbox e o consumo do SQS

`InboxMessage` é deduplicada por `(consumer_name, message_id)`, chave primária composta, dedup persistente, não em memória. O `INSERT ... ON CONFLICT DO NOTHING` garante que, mesmo com duas instâncias processando a mesma mensagem ao mesmo tempo (SQS é at-least-once), só uma segue adiante pra aplicar o efeito de negócio.

O `SqsConsumer` (`src/infrastructure/sqs/sqs-consumer.ts`) reutiliza o mesmo `SubmitWagerTransactionUseCase` que o controller HTTP usa, não existe uma segunda cópia da lógica de negócio pro caminho de fila. O fluxo:

1. Faz long polling na fila via `ReceiveMessageCommand`.
2. Pra cada mensagem, checa o Inbox primeiro (leitura rápida), se já foi processada, dá ack na hora sem chamar o use case de novo.
3. Chama o use case. Três desfechos possíveis:
   - **Sucesso** (`PROCESSED`, `REJECTED` ou `PENDING_REFERENCE`, todos devolvidos normalmente sem exceção) → grava no Inbox como processada e dá ack. Uma rejeição de negócio, pro consumer, é um resultado "tratado com sucesso": o use case rodou até o fim e o resultado ficou gravado no banco.
   - **`DomainError` lançado** (por exemplo, conflito de idempotência com payload diferente) → é problema de dado, não de infra. Grava no Inbox e dá ack, já que reentregar não resolveria nada.
   - **Qualquer outro erro** (Postgres fora do ar, timeout de rede) → trato como transitório. **Não** dou ack. A mensagem volta a ficar visível depois do `VisibilityTimeout` e o SQS reentrega sozinho.
4. Em `SIGTERM`/`SIGINT` (capturado no `main.ts`), o consumer para de puxar mensagens novas e espera as que já estão em andamento terminarem (ack ou não) antes do processo encerrar de vez pra não matar o processo no meio do trabalho.

**Outro trade-off que assumi**: marcar o `InboxMessage` como processada acontece numa transação **separada** da mutação financeira do use case (que já commitou a própria transação antes mesmo do consumer saber o resultado). Isso quer dizer que, num crash bem no meio, depois do use case retornar mas antes do Inbox ser gravado, uma redelivery reprocessaria a mensagem. Mas isso é seguro por design: quem garante a idempotência de verdade é a constraint `UNIQUE(provider_id, idempotency_key)` (seção 4), não o Inbox. O Inbox aqui é só uma otimização de custo (evita chamar o use case inteiro de novo pra algo obviamente repetido), não a garantia final, então essa janela não compromete a correção, só perde um pouco de eficiência num cenário raro.

**Sobre a DLQ**: quem decide quando uma mensagem vai pra DLQ é a política de `maxReceiveCount` configurada na própria fila (fora do código da aplicação isso seria parte de um script de provisionamento de infra, que não cheguei a escrever). O consumer não decide "manda isso pra DLQ agora"; ele só decide "dou ack (acabou aqui)" ou "não dou ack (deixo o SQS decidir o que fazer com a redelivery)".

**Limitação que assumo**: não escrevi um teste de integração automatizado pro `SqsConsumer` em si, validei manualmente publicando mensagens via `awslocal` (ver README). A lógica de negócio que ele usa por baixo já está coberta pelos testes de concorrência, então o risco real aqui é baixo, mas o teste end-to-end da parte SQS ficou de fora.

## 7. Por que não usei MikroORM

O desafio recomenda MikroORM como opção preferencial. Optei por acessar o Postgres direto via `pg` (node-postgres) porque a operação mais crítica do sistema, o `UPDATE` otimista da wallet com `WHERE version = ?` e a checagem explícita de quantas linhas foram afetadas, fica bem mais direta de escrever, ler e auditar em SQL puro do que atrás do `EntityManager.transactional()` e do `LockMode` de um ORM.

Os repositórios implementam as mesmas portas (`WalletRepository`, `WagerTransactionRepository`, etc.) que o caso de uso depende, então trocar isso por MikroORM depois (usando `EntityManager.transactional()` como `UnitOfWork` e `LockMode.OPTIMISTIC` nos `em.findOne`) seria uma troca mecânica só na camada de infra, sem tocar em domínio nem casos de uso.

## 8. Testes

**Unidade** (`test/unit/`): `Money` (escala, arredondamento, entradas inválidas, ausência de drift de float), `Wallet` (todas as invariantes de saldo, incluindo o cenário obrigatório testado single-threaded), e as transições de estado de `WagerTransaction`.

**Concorrência** (`test/concurrency/`), contra Postgres real via docker-compose, com paralelismo genuíno (`Promise.all`), sem mock nenhum:
- o cenário obrigatório (duas apostas de 80.00 contra saldo de 100.00 → uma `PROCESSED`, uma `REJECTED`, saldo final 20.00, um único débito);
- a mesma aposta enviada 50 vezes em paralelo (a corrida de `unique_violation` que expliquei na seção 4);
- wallets diferentes processando em paralelo sem se bloquearem;
- três instâncias disputando a mesma wallet ao mesmo tempo.

**Integração** (`test/integration/`), também contra Postgres real:
- **constraints do schema**: tento inserir saldo negativo, wallet duplicada (mesmo playerId+currency) e lançamento de ledger desbalanceado direto via SQL, pra confirmar que é o banco que rejeita, não só o código;
- **atomicidade**: uma BET bem-sucedida atualiza a wallet, cria o lançamento no ledger e enfileira os eventos certos na outbox, tudo na mesma transação;
- **OutboxPublisherWorker**: publica mensagens pendentes com sucesso; lida com falha de publicação agendando retry com backoff sem perder a mensagem; duas instâncias do worker rodando juntas nunca publicam a mesma mensagem duas vezes;
- **referências fora de ordem**: um REFUND que chega antes da BET fica `PENDING_REFERENCE` e é resolvido certo quando o `PendingReferenceWorker` roda depois que a BET existe; uma referência que nunca aparece é rejeitada com `REFERENCE_NOT_FOUND_TIMEOUT` depois de esgotar as tentativas;
- **reconciliação**: saldo materializado bate com o saldo recalculado do ledger depois de uma sequência de operações misturadas.

Nesses testes de outbox, usei um `FakeEventPublisher` in-memory em vez de LocalStack de verdade. O que estava testando ali era o mecanismo de lock e retry do worker sobre o Postgres (a parte não trivial), não a integração de rede com o SQS em si, isso eu já validei manualmente, ponta a ponta, com LocalStack real (ver README, "Testando o consumer de entrada"), e uso a mesma classe `SqsEventPublisher` que rodaria de verdade. Isso deixou os testes rápidos e determinísticos sem duplicar cobertura.

O que ficou de fora: um teste de integração automatizado dedicado pro `SqsConsumer` de entrada (a lógica de negócio que ele usa já está coberta pelos testes de concorrência, já que é o mesmo use case), e o teste de carga (`bun run test:load`), que é diferencial e não obrigatório.

## 9. Autenticação

Não implementei. O desafio deixa explícito que isso é uma opção válida, desde que documentada: o ponto de extensão seria um `AuthGuard` no-op no NestJS, que depois seria trocado por um guard real validando JWT emitido por um IdP (Keycloak ou Zitadel) via OIDC, sem tabela própria de usuários.

## 10. Observabilidade

Logs estruturados em JSON (`src/infrastructure/observability/logger.ts`), pro stdout, com campos padronizados (`correlationId`, `transactionId`, `walletId`, `providerId`, `messageId` quando fizer sentido). Métricas em memória (`src/infrastructure/observability/metrics.ts`), expostas em `GET /metrics` no formato de texto do Prometheus:

- `wagering_transactions_total{status}` - transações por status;
- `wagering_idempotent_duplicates_total` - quantos replays de idempotência peguei;
- `wagering_optimistic_lock_conflicts_total` - conflitos de `version` na wallet;
- `wagering_outbox_retries_total` e `wagering_outbox_lag_ms` - saúde do publisher;
- `wagering_sqs_redeliveries_total` - mensagens SQS não confirmadas (erro transitório);
- `wagering_dlq_messages` - profundidade da DLQ, via polling periódico de `GetQueueAttributes` (o app só observa, quem decide mover pra DLQ é a redrive policy da própria fila);
- `wagering_processing_latency_ms` - latência do `execute()` do use case (p50/p95/p99 aproximados).

É um registro em memória por instância, não um Prometheus client de verdade nem OpenTelemetry, ambos explicitamente opcionais no desafio. Isso quer dizer que as métricas não se agregam entre réplicas e se perdem num restart. Num cenário real, um operador faria scraping periódico do `/metrics` em cada instância e agregaria isso externamente, que é exatamente o que o Prometheus faz, então o formato de exposição já é compatível com isso.

Os health checks (`/health/live`, `/health/ready`) não exigem autenticação, como o desafio pede.

## 11. Resumo do que ficou faltando

1. Teste de integração automatizado dedicado pro `SqsConsumer` de entrada, validei manualmente (ver README), e a lógica de negócio por trás já está coberta pelos testes de concorrência.
2. Criar as filas SQS no LocalStack é manual hoje (comando `awslocal`, documentado no README), não está automatizado no `docker-compose.yml`.
3. Autenticação não implementada, decisão documentada na seção 9, que o próprio desafio permite.
4. Métricas em memória, não Prometheus/OpenTelemetry de verdade (seção 10), os dois são opcionais no desafio.
5. Teste de carga (`bun run test:load`) não implementado, é diferencial, não requisito.

Nada disso mexe nas garantias centrais que o desafio avalia (correção financeira, concorrência, idempotência, atomicidade da outbox), essas estão todas implementadas e cobertas por teste automatizado, rodando contra Postgres real.