import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as bcrypt from "bcrypt";
import mongoose from "mongoose";
import { AdminSchema, IAdmin } from "../schemas/admin.schema";

const BCRYPT_ROUNDS = 10;

const ADMIN_ERROR = {
  ADMIN_NOT_FOUND: "admin_not_found",
} as const;

@Injectable()
export class AdminsService {
  private readonly logger = new Logger(AdminsService.name);

  constructor(private readonly config: ConfigService) {}

  private get adminModel(): mongoose.Model<IAdmin> {
    return (
      (mongoose.models.Admin as mongoose.Model<IAdmin>) ??
      mongoose.model<IAdmin>("Admin", AdminSchema)
    );
  }

  async bootstrapFromEnvIfNeeded(): Promise<void> {
    const email = this.config
      .get<string>("ADMIN_BOOTSTRAP_EMAIL")
      ?.trim()
      .toLowerCase();
    const password = this.config.get<string>("ADMIN_BOOTSTRAP_PASSWORD");
    if (!email || !password) {
      return;
    }
    const existing = await this.adminModel.findOne({ email }).exec();
    if (existing) {
      return;
    }
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    await new this.adminModel({ email, passwordHash }).save();
    this.logger.log(`Bootstrap admin created for email ${email}`);
  }

  async findByEmailWithPassword(email: string): Promise<IAdmin | null> {
    return this.adminModel
      .findOne({ email: email.toLowerCase().trim() })
      .select("+passwordHash")
      .exec() as Promise<IAdmin | null>;
  }

  async findByIdPublic(
    id: string,
  ): Promise<Omit<IAdmin, "passwordHash"> | null> {
    const n = parseInt(id, 10);
    if (Number.isNaN(n)) return null;
    const doc = await this.adminModel.findOne({ id: n }).lean().exec();
    if (!doc) return null;
    const publicDoc = { ...doc } as Record<string, unknown> & {
      passwordHash?: string;
    };
    delete publicDoc.passwordHash;
    return publicDoc as Omit<IAdmin, "passwordHash">;
  }

  validatePassword(plain: string, passwordHash: string): Promise<boolean> {
    return bcrypt.compare(plain, passwordHash);
  }

  async getMe(id: string): Promise<Omit<IAdmin, "passwordHash">> {
    const admin = await this.findByIdPublic(id);
    if (!admin) {
      throw new NotFoundException(ADMIN_ERROR.ADMIN_NOT_FOUND);
    }
    return admin;
  }
}
