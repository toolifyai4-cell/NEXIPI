import type { FileMetadata } from '../types.js';

export interface BudgetEstimator {
  readonly unit: string;
  estimateCost(file: FileMetadata): number;
  estimateCostFromSize(size: number): number;
}

export interface ContextBudgetOptions {
  readonly maxBudget: number;
  readonly estimator: BudgetEstimator;
}

export interface BudgetResult {
  readonly maxBudget: number;
  readonly usedBudget: number;
  readonly remainingBudget: number;
  readonly exceeded: boolean;
  canAfford(cost: number): boolean;
}

export class ByteBudgetEstimator implements BudgetEstimator {
  readonly unit: string;
  private readonly perFileBaseCost: number;
  private readonly perByteCost: number;

  constructor(perFileBaseCost = 512, perByteCost = 0.001) {
    this.unit = 'bytes';
    this.perFileBaseCost = perFileBaseCost;
    this.perByteCost = perByteCost;
  }

  estimateCost(file: FileMetadata): number {
    const size = file.size ?? 0;
    return this.perFileBaseCost + size * this.perByteCost;
  }

  estimateCostFromSize(size: number): number {
    return this.perFileBaseCost + size * this.perByteCost;
  }
}

export class ContextBudget {
  private readonly maxBudget: number;
  private readonly estimator: BudgetEstimator;
  private usedBudget = 0;

  constructor(options: ContextBudgetOptions) {
    this.maxBudget = options.maxBudget;
    this.estimator = options.estimator;
  }

  getUnit(): string {
    return this.estimator.unit;
  }

  getMaxBudget(): number {
    return this.maxBudget;
  }

  getUsedBudget(): number {
    return this.usedBudget;
  }

  getRemainingBudget(): number {
    return Math.max(0, this.maxBudget - this.usedBudget);
  }

  isExceeded(): boolean {
    return this.usedBudget >= this.maxBudget;
  }

  canAfford(cost: number): boolean {
    return this.usedBudget + cost <= this.maxBudget;
  }

  estimateCost(file: FileMetadata): number {
    return this.estimator.estimateCost(file);
  }

  reserve(cost: number): boolean {
    if (!this.canAfford(cost)) {
      return false;
    }
    this.usedBudget += cost;
    return true;
  }

  release(cost: number): void {
    this.usedBudget = Math.max(0, this.usedBudget - cost);
  }

  toResult(): BudgetResult {
    return {
      maxBudget: this.maxBudget,
      usedBudget: this.usedBudget,
      remainingBudget: this.getRemainingBudget(),
      exceeded: this.isExceeded(),
      canAfford: (cost) => this.canAfford(cost),
    };
  }
}

export function createByteBudgetEstimator(
  perFileBaseCost: number,
  perByteCost: number
): BudgetEstimator {
  return new ByteBudgetEstimator(perFileBaseCost, perByteCost);
}

export function createContextBudget(
  maxBudget: number,
  estimator: BudgetEstimator
): ContextBudget {
  return new ContextBudget({ maxBudget, estimator });
}
