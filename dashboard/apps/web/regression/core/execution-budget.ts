/** One source for the nested runner's execution, teardown and termination budgets. */
export const executionBudget = Object.freeze({
  scenarioMs: 3_600_000,
  preparationMs: 600_000,
  cleanupMs: 600_000,
  scenarioProcessMs: 5_400_000,
  childTerminationMs: 720_000,
  outerTerminationMs: 840_000,
  podTerminationSeconds: 900,
  campaignMs: 86_400_000,
  finalReserveMs: 1_800_000,
});
