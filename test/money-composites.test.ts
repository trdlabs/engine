import { describe, expect, it } from 'vitest';
import { Decimal } from 'decimal.js';
import { ExecutionSimulator } from '../src/core/execution.js';
import { computeBarFunding } from '../src/core/funding.js';
import type { RealityModel } from '../src/contract/index.js';

// E2. Перевод `execution.ts` / `funding.ts` на `core/money.ts` не имеет права сдвинуть значения.
// Здесь рядом лежит ДОСЛОВНАЯ копия прежней арифметики (эталон), и обе стороны сравниваются
// побитово — `toBe`, а не `toBeCloseTo`: «примерно равно» здесь означало бы «мы не знаем».

Decimal.set({ rounding: Decimal.ROUND_HALF_EVEN });

const BPS_DENOM = 10_000;

/** Прежний приватный `fillPrice` из execution.ts, слово в слово. */
function refFillPrice(slippageBps: number, isBuy: boolean, base: number): Decimal {
  const slip = new Decimal(slippageBps).div(BPS_DENOM);
  const b = new Decimal(base);
  return isBuy ? b.times(slip.plus(1)) : b.times(new Decimal(1).minus(slip));
}

/** Прежний приватный `fee` из execution.ts, слово в слово. */
function refFee(feeBps: number, notional: Decimal): Decimal {
  return notional.times(new Decimal(feeBps).div(BPS_DENOM));
}

/** Прежний `computeBarFunding` из funding.ts, слово в слово. */
function refFunding(args: {
  side: 'long' | 'short';
  size: number;
  mark: number;
  rate8h: number;
  covered: boolean;
  barMinutes: number;
  intervalHours: number;
}): Decimal {
  if (!args.covered) return new Decimal(0);
  const notional = new Decimal(args.size).times(args.mark);
  return new Decimal(args.rate8h)
    .div(args.intervalHours * 60)
    .times(args.barMinutes)
    .times(notional)
    .times(args.side === 'long' ? 1 : -1);
}

function modelWith(slippageBps: number, feeBps: number): RealityModel {
  return {
    id: 'standard@1',
    fillModel: { kind: 'next_bar_open' },
    slippageModel: { kind: 'fixed_bps', bps: slippageBps },
    feeModel: { kind: 'fixed_bps', bps: feeBps },
  } as RealityModel;
}

/** Детерминированный генератор — выборка воспроизводима при падении. */
function makeRnd(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('E2 — арифметика исполнения побитово та же', () => {
  it('открывающий филл: цена, комиссия и размер', () => {
    const rnd = makeRnd(0x1234567);
    for (let i = 0; i < 5_000; i += 1) {
      const slippageBps = Math.floor(rnd() * 50);
      const feeBps = Math.floor(rnd() * 30);
      const base = rnd() * 10 ** Math.floor(rnd() * 8);
      const notional = rnd() * 10 ** Math.floor(rnd() * 7);
      if (base === 0) continue;
      const side = rnd() < 0.5 ? 'long' : 'short';
      const sim = new ExecutionSimulator(modelWith(slippageBps, feeBps));
      const got = sim.computeOpenFill(side, base, notional);
      const fp = refFillPrice(slippageBps, side === 'long', base);
      expect(got.fillPrice, `price i=${i}`).toBe(fp.toNumber());
      expect(got.fee, `fee i=${i}`).toBe(refFee(feeBps, new Decimal(notional)).toNumber());
      expect(got.size, `size i=${i}`).toBe(new Decimal(notional).div(fp).toNumber());
    }
  });

  it('закрывающий филл: цена и комиссия от нотионала закрытия', () => {
    const rnd = makeRnd(0x89abcdef);
    for (let i = 0; i < 5_000; i += 1) {
      const slippageBps = Math.floor(rnd() * 50);
      const feeBps = Math.floor(rnd() * 30);
      const base = rnd() * 10 ** Math.floor(rnd() * 8);
      const size = rnd() * 10 ** Math.floor(rnd() * 5);
      const side = rnd() < 0.5 ? 'long' : 'short';
      const sim = new ExecutionSimulator(modelWith(slippageBps, feeBps));
      const got = sim.computeCloseFill(side, base, size);
      const fp = refFillPrice(slippageBps, side === 'short', base);
      expect(got.fillPrice, `price i=${i}`).toBe(fp.toNumber());
      expect(got.fee, `fee i=${i}`).toBe(refFee(feeBps, fp.times(size)).toNumber());
    }
  });

  it('фандинг за бар', () => {
    const rnd = makeRnd(0xfeedbeef);
    for (let i = 0; i < 5_000; i += 1) {
      const args = {
        side: (rnd() < 0.5 ? 'long' : 'short') as 'long' | 'short',
        size: rnd() * 10 ** Math.floor(rnd() * 5),
        mark: rnd() * 10 ** Math.floor(rnd() * 6),
        rate8h: (rnd() - 0.5) * 0.01,
        covered: rnd() < 0.9,
        barMinutes: [1, 5, 15, 60, 240][Math.floor(rnd() * 5)]!,
        intervalHours: [1, 4, 8][Math.floor(rnd() * 3)]!,
      };
      expect(computeBarFunding(args), `i=${i}`).toBe(refFunding(args).toNumber());
    }
  });

  it('непокрытый бар возвращает ноль ДО проверки интервала (порядок проверок сохранён)', () => {
    expect(
      computeBarFunding({ side: 'long', size: 1, mark: 100, rate8h: 0.001, covered: false, barMinutes: 60, intervalHours: 0 }),
    ).toBe(0);
    expect(() =>
      computeBarFunding({ side: 'long', size: 1, mark: 100, rate8h: 0.001, covered: true, barMinutes: 60, intervalHours: 0 }),
    ).toThrow(/intervalHours must be > 0/);
  });
});
