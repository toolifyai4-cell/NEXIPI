import { describe, it, expect } from 'vitest';
import {
  ContextBudget,
  ByteBudgetEstimator,
  type BudgetEstimator,
  type ContextBudgetOptions,
} from '../context-budget.js';
import { makeFileMetadata } from './test-helpers.js';

class FixedCostEstimator implements BudgetEstimator {
  readonly unit = 'test-units';
  private readonly cost: number;
  constructor(cost: number) {
    this.cost = cost;
  }
  estimateCost(): number {
    return this.cost;
  }
  estimateCostFromSize(size: number): number {
    return this.cost;
  }
}

describe('ContextBudget', () => {
  describe('construction', () => {
    it('creates budget with max and estimator', () => {
      const estimator = new ByteBudgetEstimator();
      const budget = new ContextBudget({ maxBudget: 1000, estimator });
      expect(budget.getMaxBudget()).toBe(1000);
      expect(budget.getUsedBudget()).toBe(0);
      expect(budget.getRemainingBudget()).toBe(1000);
      expect(budget.isExceeded()).toBe(false);
    });

    it('reports unit from estimator', () => {
      const estimator = new FixedCostEstimator(10);
      const budget = new ContextBudget({ maxBudget: 100, estimator });
      expect(budget.getUnit()).toBe('test-units');
    });
  });

  describe('reserve', () => {
    it('reserves budget when affordable', () => {
      const budget = new ContextBudget({ maxBudget: 100, estimator: new ByteBudgetEstimator() });
      expect(budget.reserve(30)).toBe(true);
      expect(budget.getUsedBudget()).toBe(30);
      expect(budget.getRemainingBudget()).toBe(70);
    });

    it('rejects reservation when unaffordable', () => {
      const budget = new ContextBudget({ maxBudget: 100, estimator: new ByteBudgetEstimator() });
      expect(budget.reserve(150)).toBe(false);
      expect(budget.getUsedBudget()).toBe(0);
    });

    it('allows exact budget consumption', () => {
      const budget = new ContextBudget({ maxBudget: 100, estimator: new ByteBudgetEstimator() });
      expect(budget.reserve(100)).toBe(true);
      expect(budget.isExceeded()).toBe(true);
      expect(budget.canAfford(1)).toBe(false);
    });

    it('tracks multiple reservations', () => {
      const budget = new ContextBudget({ maxBudget: 100, estimator: new ByteBudgetEstimator() });
      budget.reserve(25);
      budget.reserve(25);
      expect(budget.getUsedBudget()).toBe(50);
    });
  });

  describe('release', () => {
    it('releases reserved budget', () => {
      const budget = new ContextBudget({ maxBudget: 100, estimator: new ByteBudgetEstimator() });
      budget.reserve(40);
      budget.release(10);
      expect(budget.getUsedBudget()).toBe(30);
    });

    it('does not go below zero', () => {
      const budget = new ContextBudget({ maxBudget: 100, estimator: new ByteBudgetEstimator() });
      budget.reserve(10);
      budget.release(100);
      expect(budget.getUsedBudget()).toBe(0);
    });
  });

  describe('canAfford', () => {
    it('reports affordability correctly', () => {
      const budget = new ContextBudget({ maxBudget: 100, estimator: new ByteBudgetEstimator() });
      expect(budget.canAfford(50)).toBe(true);
      budget.reserve(60);
      expect(budget.canAfford(40)).toBe(true);
      expect(budget.canAfford(41)).toBe(false);
    });
  });

  describe('toResult', () => {
    it('returns budget state', () => {
      const budget = new ContextBudget({ maxBudget: 200, estimator: new ByteBudgetEstimator() });
      budget.reserve(75);
      const result = budget.toResult();
      expect(result.maxBudget).toBe(200);
      expect(result.usedBudget).toBe(75);
      expect(result.remainingBudget).toBe(125);
      expect(result.exceeded).toBe(false);
      expect(result.canAfford(50)).toBe(true);
    });
  });
});

describe('ByteBudgetEstimator', () => {
  it('estimates cost from base cost plus per-byte', () => {
    const estimator = new ByteBudgetEstimator(512, 0.001);
    const file = makeFileMetadata({ size: 1000 });
    const cost = estimator.estimateCost(file);
    expect(cost).toBe(512 + 1000 * 0.001);
  });

  it('estimates cost from size directly', () => {
    const estimator = new ByteBudgetEstimator(512, 0.001);
    const cost = estimator.estimateCostFromSize(1000);
    expect(cost).toBe(512 + 1);
  });

  it('reports bytes as unit', () => {
    const estimator = new ByteBudgetEstimator();
    expect(estimator.unit).toBe('bytes');
  });

  it('handles zero size file', () => {
    const estimator = new ByteBudgetEstimator(512, 0.001);
    const file = makeFileMetadata({ size: 0 });
    expect(estimator.estimateCost(file)).toBe(512);
  });

  it('uses custom base and per-byte costs', () => {
    const estimator = new ByteBudgetEstimator(100, 0.01);
    const file = makeFileMetadata({ size: 500 });
    expect(estimator.estimateCost(file)).toBe(100 + 500 * 0.01);
  });
});

describe('BudgetResult', () => {
  it('canAfford reflects remaining budget', () => {
    const budget = new ContextBudget({ maxBudget: 100, estimator: new ByteBudgetEstimator() });
    budget.reserve(80);
    const result = budget.toResult();
    expect(result.canAfford(15)).toBe(true);
    expect(result.canAfford(21)).toBe(false);
  });
});
