import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import mongoose from 'mongoose';
import { TELEGRAM_RECIPIENT_ERROR } from '../constants/telegram.constants';
import { CreateTelegramRecipientDto } from '../dto/create-telegram-recipient.dto';
import { TelegramRecipientResponseDto } from '../dto/telegram-recipient-response.dto';
import {
  ITelegramUser,
  TelegramUserSchema,
} from '../schemas/telegram-user.schema';
import {
  IUserTelegramUser,
  UserTelegramUserSchema,
} from '../schemas/user-telegram-user.schema';
import {
  isValidTelegramUsername,
  normalizeTelegramUsername,
} from '../utils/telegram-username.util';

type LinkedRecipient = IUserTelegramUser & { telegramUser: ITelegramUser | null };

@Injectable()
export class TelegramRecipientsService {
  private get telegramUserModel(): mongoose.Model<ITelegramUser> {
    return (mongoose.models.TelegramUser as mongoose.Model<ITelegramUser>) ??
      mongoose.model<ITelegramUser>('TelegramUser', TelegramUserSchema);
  }

  private get userTelegramUserModel(): mongoose.Model<IUserTelegramUser> {
    return (mongoose.models.UserTelegramUser as mongoose.Model<IUserTelegramUser>) ??
      mongoose.model<IUserTelegramUser>('UserTelegramUser', UserTelegramUserSchema);
  }

  async findAllByUserId(userIdRaw: string): Promise<TelegramRecipientResponseDto[]> {
    const userId = Number(userIdRaw);
    const links = await this.userTelegramUserModel
      .find({ userId })
      .sort({ createdAt: -1 })
      .lean()
      .exec();

    if (links.length === 0) {
      return [];
    }

    const telegramUserIds = links.map((link) => link.telegramUserId);
    const telegramUsers = await this.telegramUserModel
      .find({ id: { $in: telegramUserIds } })
      .lean()
      .exec();
    const telegramUserById = new Map(telegramUsers.map((item) => [item.id, item]));

    return links.map((link) =>
      this.toResponse(link, telegramUserById.get(link.telegramUserId) ?? null),
    );
  }

  async create(
    userIdRaw: string,
    dto: CreateTelegramRecipientDto,
  ): Promise<TelegramRecipientResponseDto> {
    const userId = Number(userIdRaw);
    const usernameFromAdmin = normalizeTelegramUsername(dto.username);
    if (!isValidTelegramUsername(usernameFromAdmin)) {
      throw new BadRequestException(TELEGRAM_RECIPIENT_ERROR.INVALID_USERNAME);
    }

    const existingLinks = await this.userTelegramUserModel.find({ userId }).lean().exec();
    if (existingLinks.length > 0) {
      const telegramUserIds = existingLinks.map((link) => link.telegramUserId);
      const duplicate = await this.telegramUserModel
        .findOne({
          id: { $in: telegramUserIds },
          usernameFromAdmin,
        })
        .lean()
        .exec();
      if (duplicate) {
        throw new ConflictException(TELEGRAM_RECIPIENT_ERROR.USERNAME_ALREADY_ADDED);
      }
    }

    const telegramUser = await this.telegramUserModel.create({
      usernameFromAdmin,
      status: 'pending',
    });
    const link = await this.userTelegramUserModel.create({
      userId,
      telegramUserId: telegramUser.id,
      notificationsEnabled: true,
    });

    return this.toResponse(link, telegramUser);
  }

  async toggleNotifications(
    userIdRaw: string,
    linkId: number,
    notificationsEnabled: boolean,
  ): Promise<TelegramRecipientResponseDto> {
    const userId = Number(userIdRaw);
    const link = await this.userTelegramUserModel
      .findOne({ id: linkId, userId })
      .exec();
    if (!link) {
      throw new NotFoundException(TELEGRAM_RECIPIENT_ERROR.RECIPIENT_NOT_FOUND);
    }

    link.notificationsEnabled = notificationsEnabled;
    await link.save();

    const telegramUser = await this.telegramUserModel
      .findOne({ id: link.telegramUserId })
      .exec();

    return this.toResponse(link, telegramUser);
  }

  async remove(userIdRaw: string, linkId: number): Promise<{ ok: true }> {
    const userId = Number(userIdRaw);
    const link = await this.userTelegramUserModel
      .findOne({ id: linkId, userId })
      .exec();
    if (!link) {
      throw new NotFoundException(TELEGRAM_RECIPIENT_ERROR.RECIPIENT_NOT_FOUND);
    }

    const telegramUserId = link.telegramUserId;
    await link.deleteOne();

    const remainingLinks = await this.userTelegramUserModel
      .countDocuments({ telegramUserId })
      .exec();
    if (remainingLinks === 0) {
      await this.telegramUserModel.deleteOne({ id: telegramUserId }).exec();
    }

    return { ok: true };
  }

  private toResponse(
    link: IUserTelegramUser | (IUserTelegramUser & mongoose.Document),
    telegramUser: ITelegramUser | null,
  ): TelegramRecipientResponseDto {
    const linkObj = 'toObject' in link ? link.toObject() : link;
    const tg = telegramUser && 'toObject' in telegramUser ? telegramUser.toObject() : telegramUser;

    return {
      id: linkObj.id,
      telegramUserId: linkObj.telegramUserId,
      usernameFromAdmin: tg?.usernameFromAdmin ?? '',
      realTelegramUserId: tg?.realTelegramUserId ?? null,
      realTelegramUsername: tg?.realTelegramUsername ?? null,
      chatId: tg?.chatId ?? null,
      status: tg?.status ?? 'pending',
      notificationsEnabled: linkObj.notificationsEnabled,
      startedAt: tg?.startedAt ? tg.startedAt.toISOString() : null,
      createdAt: linkObj.createdAt.toISOString(),
    };
  }
}
