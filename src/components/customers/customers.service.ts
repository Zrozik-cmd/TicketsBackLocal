import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import mongoose, { Types } from 'mongoose';
import { CustomerSchema, ICustomer } from './schemas/customer.schema';

const CUSTOMER_ERROR = {
  EMAIL_ALREADY_REGISTERED: 'email_already_registered',
  CUSTOMER_NOT_FOUND: 'customer_not_found',
} as const;

@Injectable()
export class CustomersService {
  private get customerModel(): mongoose.Model<ICustomer> {
    return (mongoose.models.Customer as mongoose.Model<ICustomer>) ?? mongoose.model<ICustomer>('Customer', CustomerSchema);
  }

  async create(data: {
    fullname: string;
    email: string;
    phone?: string;
    referralLinkId?: Types.ObjectId;
  }): Promise<ICustomer> {
    const existing = await this.customerModel.findOne({ email: data.email.toLowerCase().trim() }).exec();
    if (existing) {
      throw new ConflictException(CUSTOMER_ERROR.EMAIL_ALREADY_REGISTERED);
    }
    const payload: {
      fullname: string;
      email: string;
      phone?: string;
      referralLink?: Types.ObjectId;
    } = {
      fullname: data.fullname.trim(),
      email: data.email.toLowerCase().trim(),
    };
    if (data.phone?.trim()) {
      payload.phone = data.phone.trim();
    }
    if (data.referralLinkId) {
      payload.referralLink = data.referralLinkId;
    }
    const customer = new this.customerModel(payload);
    return customer.save();
  }

  async findByEmail(email: string): Promise<ICustomer | null> {
    return this.customerModel.findOne({ email: email.toLowerCase().trim() }).lean().exec() as Promise<ICustomer | null>;
  }

  async findByEmailOrPhone(email?: string, phone?: string): Promise<ICustomer | null> {
    if (email) {
      return this.customerModel.findOne({ email: email.toLowerCase().trim() }).lean().exec() as Promise<ICustomer | null>;
    }
    if (phone?.trim()) {
      return this.customerModel.findOne({ phone: phone.trim() }).lean().exec() as Promise<ICustomer | null>;
    }
    return null;
  }

  async findById(id: string): Promise<ICustomer | null> {
    const n = parseInt(id, 10);
    if (Number.isNaN(n)) return null;
    return this.customerModel.findOne({ id: n }).lean().exec() as Promise<ICustomer | null>;
  }

  async updateLastActivity(id: string, lastActivity: Date): Promise<void> {
    const n = parseInt(id, 10);
    if (Number.isNaN(n)) throw new NotFoundException(CUSTOMER_ERROR.CUSTOMER_NOT_FOUND);
    const result = await this.customerModel
      .updateOne({ id: n }, { $set: { lastActivity } })
      .exec();
    if (result.matchedCount === 0) throw new NotFoundException(CUSTOMER_ERROR.CUSTOMER_NOT_FOUND);
  }

  async updateFullname(id: string, fullname: string): Promise<ICustomer> {
    const n = parseInt(id, 10);
    if (Number.isNaN(n)) throw new NotFoundException(CUSTOMER_ERROR.CUSTOMER_NOT_FOUND);
    const customer = await this.customerModel.findOneAndUpdate(
      { id: n },
      { $set: { fullname: fullname.trim() } },
      { new: true },
    ).lean().exec();
    if (!customer) throw new NotFoundException(CUSTOMER_ERROR.CUSTOMER_NOT_FOUND);
    return customer as ICustomer;
  }

  async setEmailMarketingConsent(id: number, consent: boolean): Promise<void> {
    await this.customerModel
      .updateOne(
        { id },
        { $set: { emailMarketingConsent: consent, emailMarketingConsentAt: new Date() } },
      )
      .exec();
  }

  async getMe(id: string): Promise<ICustomer> {
    const customer = await this.findById(id);
    if (!customer) {
      throw new NotFoundException(CUSTOMER_ERROR.CUSTOMER_NOT_FOUND);
    }
    return customer;
  }
}
