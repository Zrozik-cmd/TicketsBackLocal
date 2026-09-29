import {
  Injectable,
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
  Logger,
} from "@nestjs/common";
import mongoose from "mongoose";
import { UserSchema, IUser } from "./schemas/user.schema";
import { RegisterDto } from "./dto/register.dto";
import { MediaService } from "../media/media.service";

const USER_ERROR = {
  EMAIL_ALREADY_REGISTERED: "email_already_registered",
  PHONE_ALREADY_REGISTERED: "phone_already_registered",
  USER_NOT_FOUND: "user_not_found",
  DBD_DOCUMENT_UPLOAD_FAILED: "dbd_document_upload_failed",
} as const;

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(private readonly mediaService: MediaService) {}

  private get userModel(): mongoose.Model<IUser> {
    return (
      (mongoose.models.User as mongoose.Model<IUser>) ??
      mongoose.model<IUser>("User", UserSchema)
    );
  }

  async create(dto: RegisterDto): Promise<IUser> {
    const existingEmail = await this.userModel
      .findOne({ email: dto.email })
      .exec();
    if (existingEmail) {
      throw new ConflictException(USER_ERROR.EMAIL_ALREADY_REGISTERED);
    }
    const existingPhone = await this.userModel
      .findOne({ phoneNumber: dto.phoneNumber })
      .exec();
    if (existingPhone) {
      throw new ConflictException(USER_ERROR.PHONE_ALREADY_REGISTERED);
    }
    const user = new this.userModel({
      email: dto.email,
      phoneNumber: dto.phoneNumber,
      emailVerified: true,
      phoneVerified: true,
      companyVenueName: dto.companyVenueName,
      displayName: dto.displayName,
      responsiblePersonFullName: dto.responsiblePersonFullName,
      category: dto.category,
      websiteOrSocialLink: dto.websiteOrSocialLink,
      businessAddress: dto.businessAddress,
      city: dto.city,
      provinceRegion: dto.provinceRegion,
      country: dto.country,
      shortDescription: dto.shortDescription,
      locale: dto.locale,
      taxRegistrationId: dto.taxRegistrationId,
      companyRegistrationDbd: dto.companyRegistrationDbd,
      eventsPerMonth: dto.eventsPerMonth,
      termsAcceptedAt: dto.termsAccepted ? new Date() : undefined,
    });
    const saved = await user.save();

    /*
     * Выписку DBD сохраняем ПОСЛЕ создания аккаунта: медиа привязывается к
     * владельцу, а до save числового id ещё нет. Документ обязателен, поэтому
     * при неудаче откатываем аккаунт целиком: дозагрузить выписку из
     * интерфейса негде, и организатор остался бы с учёткой, которая никогда не
     * пройдёт проверку. Отменённая регистрация хотя бы повторяется.
     */
    let dbdMediaId: number | undefined;
    try {
      dbdMediaId = await this.mediaService.createFromDataUrl(
        dto.companyRegistrationDbdFile,
        saved.id,
        'application/pdf',
        { isPrivate: true },
      );
      saved.companyRegistrationDbdMediaId = dbdMediaId;
      await saved.save();
    } catch (error) {
      this.logger.error(
        `DBD document upload failed for user ${saved.id}, registration rolled back: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      /*
       * Упасть могло и на втором save(), когда файл уже лежит в media. Тогда
       * выписка реальной компании осталась бы без владельца: публично она не
       * отдаётся, в админку не попадает, и удалить её было бы уже нечем.
       */
      if (dbdMediaId !== undefined) {
        await this.mediaService.removeById(dbdMediaId).catch(() => undefined);
      }
      await this.userModel.deleteOne({ _id: saved._id }).exec();
      throw new InternalServerErrorException(
        USER_ERROR.DBD_DOCUMENT_UPLOAD_FAILED,
      );
    }

    this.logger.log(`User created: ${saved._id}`);
    return saved;
  }

  /** Find user by numeric id (used in JWT and relations). */
  async findById(id: string): Promise<IUser | null> {
    const n = parseInt(id, 10);
    if (Number.isNaN(n)) return null;
    const user = await this.userModel
      .findOne({ id: n })
      .select("-passwordHash")
      .lean()
      .exec();
    return user as IUser | null;
  }

  /** Batch load by numeric `User.id` (e.g. `Event.creator`). */
  async findManyByNumericIds(ids: number[]): Promise<Map<number, IUser>> {
    const unique = [...new Set(ids)].filter((n) => Number.isFinite(n));
    if (!unique.length) {
      return new Map();
    }
    const users = await this.userModel
      .find({ id: { $in: unique } })
      .select("-passwordHash")
      .lean()
      .exec();
    const map = new Map<number, IUser>();
    for (const u of users as IUser[]) {
      map.set(u.id, u);
    }
    return map;
  }

  async getMe(id: string): Promise<IUser> {
    const user = await this.findById(id);
    if (!user) {
      throw new NotFoundException(USER_ERROR.USER_NOT_FOUND);
    }
    return user;
  }

  async findByEmailOrPhone(
    email?: string,
    phoneNumber?: string,
  ): Promise<(IUser & { passwordHash?: string }) | null> {
    if (email) {
      const user = await this.userModel.findOne({ email }).lean().exec();
      return user as (IUser & { passwordHash?: string }) | null;
    }
    if (phoneNumber) {
      const user = await this.userModel.findOne({ phoneNumber }).lean().exec();
      return user as (IUser & { passwordHash?: string }) | null;
    }
    return null;
  }
}
