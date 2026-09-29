export const MANAGER_TYPES = ['Cashier', 'Marketing', 'Admin'] as const;

export type ManagerType = (typeof MANAGER_TYPES)[number];
