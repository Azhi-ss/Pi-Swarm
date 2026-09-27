export interface BudgetConfig {
  maxSteps: number; // default: 50
  enabled: boolean; // default: true
}

export interface BudgetStatus {
  consumedSteps: number;
  maxSteps: number;
  remainingSteps: number;
  isTripped: boolean;
  trippedAt?: string;
  trippedReason?: string;
}
