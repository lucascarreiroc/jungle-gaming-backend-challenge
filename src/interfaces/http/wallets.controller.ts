import { Body, Controller, Get, HttpException, HttpStatus, Inject, Param, Post, Query } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Wallet } from '../../domain/wallet';
import { Money } from '../../domain/money';
import { WagerTransaction } from '../../domain/wager-transaction';
import { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import { LedgerDirection } from '../../domain/wager-transaction';
import type {
  WalletRepository,
  WagerTransactionRepository,
  LedgerRepository,
  UnitOfWork,
} from '../../application/ports';
import { TOKENS } from '../../tokens';

interface CreateWalletBody {
  playerId: string;
  initialBalance: { amount: string; currency: string };
}

@Controller('wallets')
export class WalletsController {
  constructor(
    @Inject(TOKENS.UNIT_OF_WORK) private readonly uow: UnitOfWork,
    @Inject(TOKENS.WALLET_REPOSITORY) private readonly wallets: WalletRepository,
    @Inject(TOKENS.WAGER_TRANSACTION_REPOSITORY) private readonly transactions: WagerTransactionRepository,
    @Inject(TOKENS.LEDGER_REPOSITORY) private readonly ledger: LedgerRepository,
  ) {}

  @Post()
  async create(@Body() body: CreateWalletBody) {
    const initialBalance = Money.from(body.initialBalance);

    try {
      return await this.uow.run(async (tx) => {
        const existing = await this.wallets.findByPlayerAndCurrency(
          body.playerId,
          initialBalance.currency,
          tx,
        );
        if (existing) {
          throw new HttpException(
            { failureCode: 'CONFLICT_WALLET_ALREADY_EXISTS' },
            HttpStatus.CONFLICT,
          );
        }

        const wallet = Wallet.open({
          id: randomUUID(),
          playerId: body.playerId,
          initialBalance: Money.zero(initialBalance.currency),
        });
        await this.wallets.insert(wallet, tx);

        if (initialBalance.isPositive()) {
          const opening = WagerTransaction.createOpening({
            id: randomUUID(),
            walletId: wallet.id,
            playerId: wallet.playerId,
            money: initialBalance,
          });
          const mutation = wallet.credit(initialBalance);
          await this.transactions.insert(opening, tx);
          opening.markProcessed(undefined, new Date());
          await this.transactions.update(opening, tx);

          await this.wallets.updateWithOptimisticLock(wallet, 1, tx);

          const entry = WalletLedgerEntry.create({
            id: randomUUID(),
            walletId: wallet.id,
            transactionId: opening.id,
            direction: LedgerDirection.Credit,
            money: initialBalance,
            balanceBefore: mutation.balanceBefore,
            balanceAfter: mutation.balanceAfter,
          });
          await this.ledger.insert(entry, tx);
        } else {
          await this.wallets.updateWithOptimisticLock(wallet, wallet.version, tx);
        }

        return {
          id: wallet.id,
          playerId: wallet.playerId,
          balance: wallet.balance.toJSON(),
          version: wallet.version,
        };
      });
    } catch (err) {
      if (err instanceof HttpException) throw err;
      throw err;
    }
  }

  @Get(':walletId')
  async getById(@Param('walletId') walletId: string) {
    const wallet = await this.uow.run((tx: unknown) => this.wallets.findById(walletId, tx));
    if (!wallet) throw new HttpException('Wallet not found', HttpStatus.NOT_FOUND);
    return { id: wallet.id, playerId: wallet.playerId, balance: wallet.balance.toJSON(), version: wallet.version };
  }

  @Get(':walletId/ledger')
  async getLedger(
    @Param('walletId') walletId: string,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit = '50',
  ) {
    const entries = await this.uow.run((tx) =>
      this.ledger.listByWallet(walletId, cursor, Number(limit), tx),
    );
    return {
      entries: entries.map((e) => ({
        id: e.id,
        direction: e.direction,
        money: e.money.toJSON(),
        balanceBefore: e.balanceBefore.toJSON(),
        balanceAfter: e.balanceAfter.toJSON(),
        createdAt: e.createdAt,
      })),
    };
  }

  @Post(':walletId/reconciliation')
  async reconcile(@Param('walletId') walletId: string) {
    const wallet = await this.uow.run((tx) => this.wallets.findById(walletId, tx));
    if (!wallet) throw new HttpException('Wallet not found', HttpStatus.NOT_FOUND);

    const { balance: calculatedBalanceRaw, count } = await this.uow.run((tx) =>
      this.ledger.sumByWallet(walletId, tx),
    );

    const storedBalance = wallet.balance;
    const calculatedBalance = Money.from({
      amount: normalizeDecimalString(calculatedBalanceRaw),
      currency: wallet.currency,
    });
    const difference = storedBalance.subtract(calculatedBalance);
    const consistent = difference.isZero();

    if (!consistent) {
      console.error(
        `[Reconciliation] MISMATCH walletId=${walletId} stored=${storedBalance.toString()} calculated=${calculatedBalance.toString()}`,
      );
    }

    return {
      walletId,
      storedBalance: storedBalance.toJSON(),
      calculatedBalance: calculatedBalance.toJSON(),
      difference: difference.toJSON(),
      consistent,
      checkedEntries: count,
    };
  }
}

function normalizeDecimalString(raw: string): string {
  const [whole, fraction = ''] = raw.split('.');
  return `${whole}.${fraction.padEnd(2, '0').slice(0, 2)}`;
}
