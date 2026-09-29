import { Injectable } from "@nestjs/common";
import mongoose, { PipelineStage } from "mongoose";
import {
  CustomerSchema,
  ICustomer,
} from "../../customers/schemas/customer.schema";
import {
  MockOrderSchema,
  IMockOrder,
} from "../../mock-orders/schemas/mock-order.schema";
import { TicketSchema, ITicket } from "../../tickets/schemas/ticket.schema";
import {
  ReferralLinkSchema,
  IReferralLink,
} from "../../referral-links/schemas/referral-link.schema";
import { AdminCustomersQueryDto } from "../dto/admin-customers-query.dto";
import type {
  AdminCustomerListItem,
  AdminCustomersListResult,
} from "../types/admin-customer.types";

@Injectable()
export class AdminCustomersService {
  private get customerModel(): mongoose.Model<ICustomer> {
    return (
      (mongoose.models.Customer as mongoose.Model<ICustomer>) ??
      mongoose.model<ICustomer>("Customer", CustomerSchema)
    );
  }

  private get mockOrderModel(): mongoose.Model<IMockOrder> {
    return (
      (mongoose.models.MockOrder as mongoose.Model<IMockOrder>) ??
      mongoose.model<IMockOrder>("MockOrder", MockOrderSchema)
    );
  }

  private get ticketModel(): mongoose.Model<ITicket> {
    return (
      (mongoose.models.Ticket as mongoose.Model<ITicket>) ??
      mongoose.model<ITicket>("Ticket", TicketSchema)
    );
  }

  private get referralLinkModel(): mongoose.Model<IReferralLink> {
    return (
      (mongoose.models.ReferralLink as mongoose.Model<IReferralLink>) ??
      mongoose.model<IReferralLink>("ReferralLink", ReferralLinkSchema)
    );
  }

  async getCustomers(
    query: AdminCustomersQueryDto,
  ): Promise<AdminCustomersListResult> {
    const page = Math.max(query.page ?? 1, 1);
    const limit = Math.min(Math.max(query.limit ?? 20, 1), 100);
    const skip = (page - 1) * limit;
    const order = query.order === "asc" ? 1 : -1;
    const sortBy = query.sortBy ?? "createdAt";

    const sortFieldMap: Record<string, string> = {
      createdAt: "createdAt",
      email: "email",
      fullname: "fullname",
      ordersCount: "ordersCount",
      ticketsCount: "ticketsCount",
      totalSpent: "totalSpent",
    };
    const sortKey = sortFieldMap[sortBy] ?? "createdAt";

    const ordersColl = this.mockOrderModel.collection.name;
    const ticketsColl = this.ticketModel.collection.name;
    const refColl = this.referralLinkModel.collection.name;

    const pipeline: PipelineStage[] = [];

    const search = query.search?.trim();
    if (search) {
      const term = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(term, "i");
      pipeline.push({
        $match: {
          $or: [{ fullname: re }, { email: re }, { phone: re }],
        },
      });
    }

    pipeline.push(
      {
        $lookup: {
          from: ordersColl,
          let: { cid: "$id" },
          pipeline: [{ $match: { $expr: { $eq: ["$customer", "$$cid"] } } }],
          as: "orders",
        },
      },
      {
        $addFields: {
          ordersCount: { $size: { $ifNull: ["$orders", []] } },
          paidOrders: {
            $filter: {
              input: { $ifNull: ["$orders", []] },
              as: "o",
              cond: { $eq: ["$$o.status", "paid"] },
            },
          },
        },
      },
      {
        $addFields: {
          paidOrderCount: { $size: { $ifNull: ["$paidOrders", []] } },
          hasPaidOrder: {
            $gt: [{ $size: { $ifNull: ["$paidOrders", []] } }, 0],
          },
          totalSpent: {
            $reduce: {
              input: { $ifNull: ["$paidOrders", []] },
              initialValue: 0,
              in: { $add: ["$$value", "$$this.total_price"] },
            },
          },
        },
      },
      {
        $lookup: {
          from: ticketsColl,
          let: { cid: "$id" },
          pipeline: [{ $match: { $expr: { $eq: ["$customer", "$$cid"] } } }],
          as: "ticketDocs",
        },
      },
      {
        $addFields: {
          ticketsCount: { $size: { $ifNull: ["$ticketDocs", []] } },
        },
      },
      {
        $lookup: {
          from: refColl,
          localField: "referralLink",
          foreignField: "_id",
          as: "refDoc",
        },
      },
      {
        $addFields: {
          referralLinkName: {
            $let: {
              vars: {
                nm: { $arrayElemAt: ["$refDoc.internalName", 0] },
              },
              in: {
                $cond: [
                  { $gt: [{ $strLenCP: { $ifNull: ["$$nm", ""] } }, 0] },
                  "$$nm",
                  null,
                ],
              },
            },
          },
          status: {
            $cond: ["$hasPaidOrder", "active", "inactive"],
          },
        },
      },
    );

    const filter = query.filter ?? "all";
    if (filter === "active") {
      pipeline.push({ $match: { hasPaidOrder: true } });
    } else if (filter === "inactive") {
      pipeline.push({ $match: { hasPaidOrder: false } });
    } else if (filter === "referral") {
      pipeline.push({
        $match: {
          referralLink: { $exists: true, $ne: null },
        },
      });
    }

    pipeline.push({
      $facet: {
        totalCount: [{ $count: "count" }],
        rows: [
          { $sort: { [sortKey]: order } },
          { $skip: skip },
          { $limit: limit },
          {
            $project: {
              _id: 0,
              id: 1,
              fullname: 1,
              email: 1,
              phone: { $ifNull: ["$phone", ""] },
              createdAt: 1,
              lastActivity: { $ifNull: ["$lastActivity", null] },
              ordersCount: 1,
              paidOrderCount: 1,
              ticketsCount: 1,
              totalSpent: 1,
              referralLinkName: 1,
              status: 1,
            },
          },
        ],
      },
    });

    const agg = await this.customerModel.aggregate<{
      totalCount: Array<{ count: number }>;
      rows: AdminCustomerListItem[];
    }>(pipeline);

    const bucket = agg[0] ?? { totalCount: [], rows: [] };
    const total = bucket.totalCount[0]?.count ?? 0;
    const items = bucket.rows ?? [];

    return { items, total, page, limit };
  }
}
