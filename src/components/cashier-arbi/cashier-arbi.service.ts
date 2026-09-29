import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import mongoose from 'mongoose';
import { NotificationService } from '../../services/NotificationService/notification.service';
import { isLocationRepeaterId } from '../content-cms/constants/location-card.constants';
import {
  CmsPageSchema,
  ICmsPage,
} from '../content-cms/schemas/cms-page.schema';
import {
  CmsRepeaterItem,
} from '../content-cms/types/cms.types';
import { CashierArbiAuthTokensHelper } from './cashier-arbi-auth-tokens.helper';
import { CreateCashierArbiDto } from './dto/create-cashier-arbi.dto';
import { UpdateCashierArbiDto } from './dto/update-cashier-arbi.dto';
import {
  CASHIER_ARBI_ROLE,
  CashierArbiSchema,
  ICashierArbi,
} from './schemas/cashier-arbi.schema';

const BCRYPT_ROUNDS = 10;

@Injectable()
export class CashierArbiService {
  constructor(
    private readonly config: ConfigService,
    private readonly notificationService: NotificationService,
    private readonly tokens: CashierArbiAuthTokensHelper,
  ) {}

  private get cashierModel(): mongoose.Model<ICashierArbi> {
    return (
      (mongoose.models.CashierArbi as mongoose.Model<ICashierArbi>) ??
      mongoose.model<ICashierArbi>('CashierArbi', CashierArbiSchema)
    );
  }

  private get cmsPageModel(): mongoose.Model<ICmsPage> {
    return (
      (mongoose.models.ContentCmsPage as mongoose.Model<ICmsPage>) ??
      mongoose.model<ICmsPage>('ContentCmsPage', CmsPageSchema)
    );
  }

  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  private normalizeLocationIdentifier(value?: string): string {
    return value?.trim().toLocaleLowerCase() ?? '';
  }

  private locationMatches(
    item: CmsRepeaterItem,
    identifier: string,
  ): boolean {
    const titleField = item.fields.find((field) => field.id === 'title');
    const localizedTitles =
      titleField &&
      (titleField.type === 'text' ||
        titleField.type === 'textarea' ||
        titleField.type === 'richText')
        ? Object.values(titleField.value)
        : [];
    const candidates = [
      item.id,
      item.unique_id,
      item.title,
      ...localizedTitles,
    ];
    return candidates.some(
      (candidate) =>
        this.normalizeLocationIdentifier(candidate) === identifier,
    );
  }

  private async resolvePosLocationUniqueId(posLocation: string): Promise<string> {
    const identifier = this.normalizeLocationIdentifier(posLocation);
    const pages = await this.cmsPageModel
      .find({ publication: 'published' })
      .select({ sections: 1 })
      .lean()
      .exec();

    for (const page of pages) {
      for (const section of page.sections ?? []) {
        if (!section.visible) continue;
        for (const field of section.fields ?? []) {
          if (field.type !== 'repeater' || !isLocationRepeaterId(field.id)) {
            continue;
          }
          const item = field.items.find(
            (candidate) =>
              candidate.showCard !== false &&
              this.locationMatches(candidate, identifier),
          );
          if (item?.unique_id) {
            return item.unique_id;
          }
        }
      }
    }

    throw new NotFoundException('cashier_arbi_pos_location_not_found');
  }

  private toPublic(
    cashier: ICashierArbi | Record<string, unknown>,
    options?: { includePassword?: boolean },
  ) {
    const base = {
      id: Number(cashier.id),
      email: String(cashier.email ?? ''),
      role: CASHIER_ARBI_ROLE,
      pos_location: String(cashier.posLocation ?? ''),
      pos_location_unique_id: String(cashier.posLocationUniqueId ?? ''),
      is_active: cashier.isActive !== false,
      createdAt: cashier.createdAt instanceof Date ? cashier.createdAt.toISOString() : cashier.createdAt,
      updatedAt: cashier.updatedAt instanceof Date ? cashier.updatedAt.toISOString() : cashier.updatedAt,
    };
    if (!options?.includePassword) {
      return base;
    }
    return {
      ...base,
      password: String(cashier.password ?? ''),
    };
  }

  async create(dto: CreateCashierArbiDto) {
    const email = this.normalizeEmail(dto.email);
    const posLocation = dto.pos_location.trim();
    const posLocationUniqueId =
      await this.resolvePosLocationUniqueId(posLocation);
    const existing = await this.cashierModel.exists({ email });
    if (existing) {
      throw new ConflictException('cashier_arbi_email_already_exists');
    }
    const password = dto.password;
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const cashier = await new this.cashierModel({
      email,
      password,
      passwordHash,
      posLocation,
      posLocationUniqueId,
      role: CASHIER_ARBI_ROLE,
    }).save();
    await this.sendCredentialsEmail(email, password, posLocation);
    return this.toPublic(cashier, { includePassword: true });
  }

  async findAll() {
    const cashiers = await this.cashierModel
      .find()
      .select('+password')
      .sort({ id: 1 })
      .lean()
      .exec();
    return cashiers.map((cashier) => this.toPublic(cashier, { includePassword: true }));
  }

  async update(id: number, dto: UpdateCashierArbiDto) {
    const cashier = await this.cashierModel.findOne({ id }).select('+password').exec();
    if (!cashier) {
      throw new NotFoundException('cashier_arbi_not_found');
    }

    let emailChanged = false;
    let passwordChanged = false;

    if (dto.email !== undefined) {
      const email = this.normalizeEmail(dto.email);
      const duplicate = await this.cashierModel.exists({
        email,
        id: { $ne: id },
      });
      if (duplicate) {
        throw new ConflictException('cashier_arbi_email_already_exists');
      }
      emailChanged = email !== this.normalizeEmail(cashier.email);
      cashier.email = email;
    }

    if (dto.pos_location !== undefined) {
      const posLocation = dto.pos_location.trim();
      cashier.posLocationUniqueId =
        await this.resolvePosLocationUniqueId(posLocation);
      cashier.posLocation = posLocation;
    }

    if (dto.password !== undefined) {
      cashier.password = dto.password;
      cashier.passwordHash = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);
      passwordChanged = true;
    }

    await cashier.save();

    if (emailChanged || passwordChanged) {
      const password = String(cashier.password ?? '');
      if (password) {
        await this.sendCredentialsEmail(
          cashier.email,
          password,
          cashier.posLocation,
        );
      }
    }

    return this.toPublic(cashier, { includePassword: true });
  }

  /**
   * Удаления больше нет: у кассира есть история подтверждённых заказов и
   * инкассаций, и она обязана переживать увольнение. Вместо этого — флаг.
   */
  async setActive(id: number, active: boolean) {
    const cashier = await this.cashierModel
      .findOne({ id })
      .select('+password')
      .exec();
    if (!cashier) {
      throw new NotFoundException('cashier_arbi_not_found');
    }
    cashier.isActive = active;
    await cashier.save();
    return this.toPublic(cashier, { includePassword: true });
  }

  async findById(id: string): Promise<ICashierArbi | null> {
    const numericId = Number(id);
    if (!Number.isInteger(numericId) || numericId < 1) {
      return null;
    }
    return this.cashierModel.findOne({ id: numericId }).lean().exec() as Promise<ICashierArbi | null>;
  }

  async signIn(emailRaw: string, password: string) {
    const email = this.normalizeEmail(emailRaw);
    const cashier = await this.cashierModel
      .findOne({ email })
      .select('+passwordHash')
      .exec();
    if (!cashier?.passwordHash) {
      throw new UnauthorizedException('invalid_credentials');
    }
    const ok = await bcrypt.compare(password, cashier.passwordHash);
    if (!ok) {
      throw new UnauthorizedException('invalid_credentials');
    }
    if (cashier.isActive === false) {
      throw new UnauthorizedException('cashier_arbi_deactivated');
    }
    const cashierId = String(cashier.id);
    const accessToken = this.tokens.signAccessToken({
      cashierId,
      email: cashier.email,
      posLocation: cashier.posLocation,
    });
    const refreshToken = this.tokens.signRefreshToken(cashierId);
    return {
      cashier: this.toPublic(cashier),
      accessToken,
      refreshToken,
    };
  }

  async refreshAccessToken(refreshToken: string) {
    const { cashierId } = this.tokens.verifyRefreshToken(refreshToken);
    const cashier = await this.findById(cashierId);
    if (!cashier) {
      throw new UnauthorizedException('cashier_arbi_not_found');
    }
    if (cashier.isActive === false) {
      throw new UnauthorizedException('cashier_arbi_deactivated');
    }
    return {
      accessToken: this.tokens.signAccessToken({
        cashierId,
        email: cashier.email,
        posLocation: cashier.posLocation,
      }),
    };
  }

  private async sendCredentialsEmail(email: string, password: string, posLocation: string): Promise<void> {
    const loginUrl =
      this.config.get<string>('CASHIER_ARBI_LOGIN_URL')?.trim() ||
      this.config.get<string>('FRONTEND_CASHIER_URL')?.trim() ||
      'https://crm.lotusarena.life/';
    const subject = 'Lotus Arena cashier access';
    const text = [
      'Your cashier account has been created.',
      `URL: ${loginUrl}`,
      `Email: ${email}`,
      `Password: ${password}`,
      `POS: ${posLocation}`,
    ].join('\n');
    const html = `
      <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111827;">
        <h2>Lotus Arena cashier access</h2>
        <p><strong>URL:</strong> <a href="${loginUrl}">${loginUrl}</a></p>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>Password:</strong> ${password}</p>
        <p><strong>POS:</strong> ${posLocation}</p>
      </div>`;
    await this.notificationService.sendEmail({
      to: email,
      subject,
      text,
      html,
    });
  }
}
