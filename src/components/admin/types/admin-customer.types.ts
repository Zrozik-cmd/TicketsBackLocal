export type AdminCustomerListItem = {
  id: number;
  fullname: string;
  email: string;
  phone: string;
  createdAt: Date;
  lastActivity: Date | null;
  ordersCount: number;
  paidOrderCount: number;
  ticketsCount: number;
  totalSpent: number;
  referralLinkName: string | null;
  status: "active" | "inactive";
};

export type AdminCustomersListResult = {
  items: AdminCustomerListItem[];
  total: number;
  page: number;
  limit: number;
};
