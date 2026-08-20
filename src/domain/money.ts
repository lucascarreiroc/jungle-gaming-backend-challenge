import Decimal from 'decimal.js';

export interface MoneyProps {
  amount: string; // decimal string, ex.: "25.00"
  currency: string; // ISO-4217
}

export class DomainError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export class InvalidMoneyError extends DomainError {
  constructor(message: string) {
    super(message, 'INVALID_MONEY');
  }
}

export class CurrencyMismatchError extends DomainError {
  constructor(a: string, b: string) {
    super(`Currency mismatch: ${a} !== ${b}`, 'CURRENCY_MISMATCH');
  }
}

const DECIMAL_STRING_REGEX = /^\d+\.\d{2}$/;

/**
 * Money é um Value Object imutável. Toda operação retorna uma nova instância.
 *
 * Decisões de design (ver ARCHITECTURE.md):
 * - Nunca usa number/float internamente — usa Decimal.js.
 * - amount é sempre serializado como string decimal com escala fixa de 2 casas.
 * - Rejeita entradas inválidas na fronteira (NaN, Infinity, notação científica,
 *   string vazia, mais de 2 casas decimais, valores negativos em contratos de entrada).
 * - Não depende de tipos monetários do ORM nem de decorators do NestJS —
 *   é POJO puro de domínio.
 */
export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    if (!props || typeof props.amount !== 'string') {
      throw new InvalidMoneyError('amount must be a decimal string');
    }
    if (!props.currency || typeof props.currency !== 'string' || props.currency.length !== 3) {
      throw new InvalidMoneyError('currency must be a valid ISO-4217 code');
    }
    if (props.amount.trim() === '' || !DECIMAL_STRING_REGEX.test(props.amount)) {
      // Rejects NaN, Infinity, scientific notation, empty string, wrong scale.
      throw new InvalidMoneyError(
        `amount must be a decimal string with exactly 2 decimal places, got "${props.amount}"`,
      );
    }

    const decimal = new Decimal(props.amount);
    if (decimal.isNegative()) {
      throw new InvalidMoneyError('amount must not be negative in input contracts');
    }

    return new Money(decimal, props.currency.toUpperCase());
  }

  /**
   * Uso interno de domínio (ex.: negate(), diferenças de reconciliação) onde
   * um valor negativo é uma representação legítima de uma operação, não uma
   * entrada de usuário. Não exposto como API pública de contrato.
   */
  private static fromDecimal(value: Decimal, currency: string): Money {
    return new Money(value, currency);
  }

  static zero(currency: string): Money {
    return new Money(new Decimal('0.00'), currency.toUpperCase());
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromDecimal(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return Money.fromDecimal(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return Money.fromDecimal(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.isPositive() && !this.value.isZero();
  }

  isNegative(): boolean {
    return this.value.isNegative();
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lessThan(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.equals(other.value);
  }

  toJSON(): MoneyProps {
    return {
      amount: this.value.toFixed(2),
      currency: this.currency,
    };
  }

  toString(): string {
    return `${this.value.toFixed(2)} ${this.currency}`;
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}
