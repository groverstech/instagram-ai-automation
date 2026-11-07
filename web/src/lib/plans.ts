export const PLANS = {
  starter: { label: "Starter", price: 0, brands: 1, seats: 2, aiRunsPerMonth: 200, socialAccounts: 3 },
  growth: { label: "Growth", price: 79, brands: 3, seats: 5, aiRunsPerMonth: 2000, socialAccounts: 12 },
  agency: { label: "Agency", price: 299, brands: 25, seats: 25, aiRunsPerMonth: 20000, socialAccounts: 150 },
} as const;
export type PlanId = keyof typeof PLANS;
