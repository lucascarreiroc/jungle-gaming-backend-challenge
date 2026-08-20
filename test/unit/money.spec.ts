import { describe, expect, it } from 'bun:test';
import { Money, InvalidMoneyError, CurrencyMismatchError } from '../../src/domain/money';

describe('Money', () => {
  it('creates from a valid decimal string', () => {
    const m = Money.from({ amount: '25.00', currency: 'brl' });
    expect(m.toJSON()).toEqual({ amount: '25.00', currency: 'BRL' });
  });

  it('rejects NaN-like strings', () => {
    expect(() => Money.from({ amount: 'NaN', currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  it('rejects Infinity', () => {
    expect(() => Money.from({ amount: 'Infinity', currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  it('rejects scientific notation', () => {
    expect(() => Money.from({ amount: '2.5e1', currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  it('rejects empty string', () => {
    expect(() => Money.from({ amount: '', currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  it('rejects more than 2 decimal places', () => {
    expect(() => Money.from({ amount: '25.001', currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  it('rejects negative values in input contracts', () => {
    expect(() => Money.from({ amount: '-10.00', currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  it('rejects missing decimal places (integer-looking strings)', () => {
    expect(() => Money.from({ amount: '25', currency: 'BRL' })).toThrow(InvalidMoneyError);
  });

  it('adds two amounts of the same currency', () => {
    const a = Money.from({ amount: '10.50', currency: 'BRL' });
    const b = Money.from({ amount: '5.25', currency: 'BRL' });
    expect(a.add(b).toJSON().amount).toBe('15.75');
  });

  it('subtracts two amounts of the same currency', () => {
    const a = Money.from({ amount: '10.50', currency: 'BRL' });
    const b = Money.from({ amount: '5.25', currency: 'BRL' });
    expect(a.subtract(b).toJSON().amount).toBe('5.25');
  });

  it('throws on operations between different currencies', () => {
    const a = Money.from({ amount: '10.00', currency: 'BRL' });
    const b = Money.from({ amount: '10.00', currency: 'USD' });
    expect(() => a.add(b)).toThrow(CurrencyMismatchError);
    expect(() => a.subtract(b)).toThrow(CurrencyMismatchError);
    expect(() => a.isLessThan(b)).toThrow(CurrencyMismatchError);
  });

  it('is immutable - every operation returns a new instance', () => {
    const a = Money.from({ amount: '10.00', currency: 'BRL' });
    const b = Money.from({ amount: '5.00', currency: 'BRL' });
    const result = a.add(b);
    expect(a.toJSON().amount).toBe('10.00'); // a unchanged
    expect(result.toJSON().amount).toBe('15.00');
  });

  it('zero() creates a zero-value Money in the given currency', () => {
    const z = Money.zero('BRL');
    expect(z.isZero()).toBe(true);
    expect(z.toJSON()).toEqual({ amount: '0.00', currency: 'BRL' });
  });

  it('correctly compares equality across value and currency', () => {
    const a = Money.from({ amount: '10.00', currency: 'BRL' });
    const b = Money.from({ amount: '10.00', currency: 'BRL' });
    const c = Money.from({ amount: '10.00', currency: 'USD' });
    expect(a.equals(b)).toBe(true);
    expect(a.equals(c)).toBe(false);
  });

  it('negate() flips the sign without mutating the original', () => {
    const a = Money.from({ amount: '10.00', currency: 'BRL' });
    const negated = a.negate();
    expect(negated.isNegative()).toBe(true);
    expect(a.isPositive()).toBe(true); // original unchanged
  });

  it('isLessThan compares magnitudes correctly', () => {
    const a = Money.from({ amount: '5.00', currency: 'BRL' });
    const b = Money.from({ amount: '10.00', currency: 'BRL' });
    expect(a.isLessThan(b)).toBe(true);
    expect(b.isLessThan(a)).toBe(false);
  });

  it('does not lose precision across many additions (no float drift)', () => {
    let total = Money.zero('BRL');
    const cent = Money.from({ amount: '0.01', currency: 'BRL' });
    for (let i = 0; i < 1000; i++) {
      total = total.add(cent);
    }
    // 1000 * 0.01 = 10.00 exactly - with IEEE754 float this often drifts.
    expect(total.toJSON().amount).toBe('10.00');
  });
});
