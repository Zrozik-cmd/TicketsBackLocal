import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import mongoose from 'mongoose';
import { MediaService } from '../../media/media.service';
import type { ILocalizedText } from '../../events/schemas/event.schema';
import type { LocalizedImageDto } from '../../events/dto/shared.dto';
import { AdminBannersQueryDto } from '../dto/admin-banners-query.dto';
import { CreateBannerDto } from '../dto/create-banner.dto';
import { ReorderBannersDto } from '../dto/reorder-banners.dto';
import { UpdateBannerDto } from '../dto/update-banner.dto';
import { BannerSchema, IBanner, ILocalizedImage } from '../schemas/banner.schema';
import type {
  AdminBannerDetails,
  AdminBannerListItem,
  AdminBannersListResult,
  BannerLocale,
  LocalizedImageUrl,
  PublicBannerCard,
} from '../types/banner.types';

const PLATFORM_MEDIA_USER_ID = 0;

const BANNER_LOCALES: BannerLocale[] = ['th', 'en', 'ru'];

function localeFallbackOrder(locale: BannerLocale): BannerLocale[] {
  return locale === 'th'
    ? ['th', 'en', 'ru']
    : locale === 'ru'
      ? ['ru', 'en', 'th']
      : ['en', 'th', 'ru'];
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function pickLocalizedString(
  text: ILocalizedText | undefined,
  locale: BannerLocale,
): string {
  if (!text) {
    return '';
  }
  for (const key of localeFallbackOrder(locale)) {
    const value = text[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

function pickLocalizedMediaId(
  images: ILocalizedImage | undefined,
  locale: BannerLocale,
): number | undefined {
  if (!images) {
    return undefined;
  }
  for (const key of localeFallbackOrder(locale)) {
    const id = images[key];
    if (typeof id === 'number' && id > 0) {
      return id;
    }
  }
  return undefined;
}

function normalizeStoredBgImage(bgImage: ILocalizedImage | number | undefined): ILocalizedImage {
  if (typeof bgImage === 'number' && bgImage > 0) {
    return { th: bgImage, en: bgImage, ru: bgImage };
  }
  if (!bgImage || typeof bgImage !== 'object') {
    return {};
  }
  const normalized: ILocalizedImage = {};
  for (const locale of BANNER_LOCALES) {
    const id = bgImage[locale];
    if (typeof id === 'number' && id > 0) {
      normalized[locale] = id;
    }
  }
  return normalized;
}

function collectBgImageIds(bgImage: ILocalizedImage | number | undefined): number[] {
  const normalized = normalizeStoredBgImage(bgImage);
  const ids = new Set<number>();
  for (const locale of BANNER_LOCALES) {
    const id = normalized[locale];
    if (typeof id === 'number' && id > 0) {
      ids.add(id);
    }
  }
  return [...ids];
}

function toIsoDate(value: Date | undefined): string | undefined {
  return value instanceof Date ? value.toISOString() : undefined;
}

@Injectable()
export class BannersService {
  constructor(private readonly mediaService: MediaService) {}

  private get bannerModel(): mongoose.Model<IBanner> {
    return (
      (mongoose.models.Banner as mongoose.Model<IBanner>) ??
      mongoose.model<IBanner>('Banner', BannerSchema)
    );
  }

  private mediaUrl(mediaId: number): string {
    return Number.isFinite(mediaId) && mediaId > 0 ? `/media/${mediaId}` : '';
  }

  private toLocalizedImageUrls(bgImage: ILocalizedImage | number | undefined): LocalizedImageUrl {
    const normalized = normalizeStoredBgImage(bgImage);
    const urls: LocalizedImageUrl = {};
    for (const locale of BANNER_LOCALES) {
      const id = normalized[locale];
      if (typeof id === 'number' && id > 0) {
        urls[locale] = this.mediaUrl(id);
      }
    }
    return urls;
  }

  private toAdminListItem(banner: IBanner): AdminBannerListItem {
    const bgImage = normalizeStoredBgImage(banner.bgImage);
    return {
      id: banner.id,
      tag: banner.tag,
      title: banner.title,
      description: banner.description,
      buttonText: banner.buttonText,
      bgImage,
      bgImageUrl: this.toLocalizedImageUrls(bgImage),
      href: banner.href,
      sortOrder: banner.sortOrder,
      isActive: banner.isActive,
      scheduleEnabled: banner.scheduleEnabled ?? false,
      startsAt: toIsoDate(banner.startsAt),
      endsAt: toIsoDate(banner.endsAt),
      createdAt: banner.createdAt.toISOString(),
      updatedAt: banner.updatedAt.toISOString(),
    };
  }

  private validateDateRange(startsAt?: Date, endsAt?: Date): void {
    if (startsAt && endsAt && startsAt >= endsAt) {
      throw new BadRequestException('startsAt must be before endsAt');
    }
  }

  private parseOptionalDate(value?: string): Date | undefined {
    if (!value) {
      return undefined;
    }
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException('Invalid date');
    }
    return date;
  }

  private async createMediaIdFromImageData(image: {
    url: string;
    mimeType?: string;
  }): Promise<number> {
    return this.mediaService.createFromDataUrl(
      image.url,
      PLATFORM_MEDIA_USER_ID,
      image.mimeType,
    );
  }

  private async resolveLocalizedImageIds(
    image: LocalizedImageDto,
  ): Promise<ILocalizedImage> {
    const result: ILocalizedImage = {};
    await Promise.all(
      BANNER_LOCALES.map(async (locale) => {
        const data = image[locale];
        if (data) {
          result[locale] = await this.createMediaIdFromImageData(data);
        }
      }),
    );
    return result;
  }

  private hasLocalizedImageInput(image?: LocalizedImageDto): boolean {
    if (!image) {
      return false;
    }
    return BANNER_LOCALES.some((locale) => Boolean(image[locale]));
  }

  private async resolveNextSortOrder(explicit?: number): Promise<number> {
    if (explicit != null) {
      return explicit;
    }
    const latest = await this.bannerModel
      .findOne()
      .sort({ sortOrder: -1 })
      .select({ sortOrder: 1 })
      .lean()
      .exec();
    return (latest?.sortOrder ?? -1) + 1;
  }

  async listForAdmin(query: AdminBannersQueryDto): Promise<AdminBannersListResult> {
    const sortBy = query.sortBy ?? 'sortOrder';
    const order = query.order ?? 'asc';
    const page = Math.max(query.page ?? 1, 1);
    const pageLimit = Math.min(Math.max(query.limit ?? 20, 1), 100);
    const skip = (page - 1) * pageLimit;

    const filter: Record<string, unknown> = {};
    if (query.isActive !== undefined) {
      filter.isActive = query.isActive;
    }
    if (query.search?.trim()) {
      const term = escapeRegex(query.search.trim());
      const re = new RegExp(term, 'i');
      filter.$or = [
        { 'title.th': re },
        { 'title.en': re },
        { 'title.ru': re },
      ];
    }

    const sort: Record<string, 1 | -1> =
      sortBy === 'createdAt'
        ? { createdAt: order === 'asc' ? 1 : -1, id: order === 'asc' ? 1 : -1 }
        : { sortOrder: order === 'asc' ? 1 : -1, id: order === 'asc' ? 1 : -1 };

    const [total, raw] = await Promise.all([
      this.bannerModel.countDocuments(filter).exec(),
      this.bannerModel
        .find(filter)
        .sort(sort)
        .skip(skip)
        .limit(pageLimit)
        .lean()
        .exec(),
    ]);

    const items = raw.map((banner) =>
      this.toAdminListItem(banner as unknown as IBanner),
    );

    return {
      items,
      total,
      page,
      limit: pageLimit,
      totalPages: Math.max(1, Math.ceil(total / pageLimit)),
    };
  }

  async findByIdForAdmin(id: number): Promise<AdminBannerDetails> {
    const banner = await this.bannerModel.findOne({ id }).exec();
    if (!banner) {
      throw new NotFoundException('Banner not found');
    }
    return this.toAdminListItem(banner);
  }

  async create(dto: CreateBannerDto): Promise<AdminBannerDetails> {
    const scheduleEnabled = dto.scheduleEnabled ?? false;
    const startsAt = this.parseOptionalDate(dto.startsAt);
    const endsAt = this.parseOptionalDate(dto.endsAt);
    if (scheduleEnabled) {
      this.validateDateRange(startsAt, endsAt);
    }

    const bgImage = await this.resolveLocalizedImageIds(dto.bgImage);
    const sortOrder = await this.resolveNextSortOrder(dto.sortOrder);

    const banner = await this.bannerModel.create({
      tag: dto.tag,
      title: dto.title,
      description: dto.description,
      buttonText: dto.buttonText,
      bgImage,
      href: dto.href.trim(),
      sortOrder,
      isActive: dto.isActive ?? true,
      scheduleEnabled,
      startsAt,
      endsAt,
    });

    return this.toAdminListItem(banner);
  }

  async update(id: number, dto: UpdateBannerDto): Promise<AdminBannerDetails> {
    const banner = await this.bannerModel.findOne({ id }).exec();
    if (!banner) {
      throw new NotFoundException('Banner not found');
    }

    const scheduleEnabled =
      dto.scheduleEnabled !== undefined
        ? dto.scheduleEnabled
        : (banner.scheduleEnabled ?? false);
    const startsAt =
      dto.startsAt !== undefined
        ? this.parseOptionalDate(dto.startsAt)
        : banner.startsAt;
    const endsAt =
      dto.endsAt !== undefined ? this.parseOptionalDate(dto.endsAt) : banner.endsAt;
    if (scheduleEnabled) {
      this.validateDateRange(startsAt, endsAt);
    }

    const setPayload: Record<string, unknown> = {};
    if (dto.tag !== undefined) setPayload.tag = dto.tag;
    if (dto.title !== undefined) setPayload.title = dto.title;
    if (dto.description !== undefined) setPayload.description = dto.description;
    if (dto.buttonText !== undefined) setPayload.buttonText = dto.buttonText;
    if (dto.href !== undefined) setPayload.href = dto.href.trim();
    if (dto.isActive !== undefined) setPayload.isActive = dto.isActive;
    if (dto.scheduleEnabled !== undefined) setPayload.scheduleEnabled = dto.scheduleEnabled;
    if (dto.sortOrder !== undefined) setPayload.sortOrder = dto.sortOrder;
    if (dto.startsAt !== undefined) setPayload.startsAt = startsAt;
    if (dto.endsAt !== undefined) setPayload.endsAt = endsAt;

    let oldBgImagesToRemove: number[] = [];
    if (dto.bgImage) {
      if (!this.hasLocalizedImageInput(dto.bgImage)) {
        throw new BadRequestException(
          'At least one language image (th, en or ru) must be provided',
        );
      }

      const current = normalizeStoredBgImage(banner.bgImage);
      const next: ILocalizedImage = { ...current };

      for (const locale of BANNER_LOCALES) {
        const imageData = dto.bgImage[locale];
        if (!imageData) {
          continue;
        }
        const nextId = await this.createMediaIdFromImageData(imageData);
        const currentId = current[locale];
        if (currentId && currentId !== nextId) {
          oldBgImagesToRemove.push(currentId);
        }
        next[locale] = nextId;
      }

      setPayload.bgImage = next;
    }

    Object.assign(banner, setPayload);
    await banner.save();

    if (oldBgImagesToRemove.length) {
      await Promise.all(
        oldBgImagesToRemove.map((id) => this.mediaService.removeById(id)),
      );
    }

    return this.toAdminListItem(banner);
  }

  async remove(id: number): Promise<void> {
    const banner = await this.bannerModel.findOne({ id }).exec();
    if (!banner) {
      throw new NotFoundException('Banner not found');
    }

    const bgImageIds = collectBgImageIds(banner.bgImage);
    await this.bannerModel.deleteOne({ id }).exec();

    await Promise.all(
      bgImageIds.map((mediaId) => this.mediaService.removeById(mediaId)),
    );
  }

  async reorder(dto: ReorderBannersDto): Promise<{ updated: number }> {
    const ids = dto.items.map((item) => item.id);
    const existing = await this.bannerModel
      .find({ id: { $in: ids } })
      .select({ id: 1 })
      .lean()
      .exec();

    if (existing.length !== ids.length) {
      throw new BadRequestException('One or more banners not found');
    }

    await Promise.all(
      dto.items.map((item) =>
        this.bannerModel
          .updateOne({ id: item.id }, { $set: { sortOrder: item.sortOrder } })
          .exec(),
      ),
    );

    return { updated: dto.items.length };
  }

  async findPublic(locale: BannerLocale = 'en'): Promise<PublicBannerCard[]> {
    const now = new Date();
    const banners = await this.bannerModel
      .find({
        isActive: true,
        $or: [
          { scheduleEnabled: { $ne: true } },
          {
            scheduleEnabled: true,
            $and: [
              {
                $or: [
                  { startsAt: { $exists: false } },
                  { startsAt: null },
                  { startsAt: { $lte: now } },
                ],
              },
              {
                $or: [
                  { endsAt: { $exists: false } },
                  { endsAt: null },
                  { endsAt: { $gte: now } },
                ],
              },
            ],
          },
        ],
      })
      .sort({ sortOrder: 1, createdAt: 1 })
      .lean()
      .exec();

    return banners.map((banner) => {
      const tag = pickLocalizedString(banner.tag, locale);
      const description = pickLocalizedString(banner.description, locale);
      const buttonText = pickLocalizedString(banner.buttonText, locale);
      const title = pickLocalizedString(banner.title, locale);
      const bgImageId = pickLocalizedMediaId(
        normalizeStoredBgImage(banner.bgImage as ILocalizedImage | number | undefined),
        locale,
      );
      const card: PublicBannerCard = {
        bgImage: bgImageId ? this.mediaUrl(bgImageId) : '',
        href: banner.href,
      };
      if (title) {
        card.title = title;
      }
      if (tag) {
        card.tag = tag;
      }
      if (description) {
        card.description = description;
      }
      if (buttonText) {
        card.buttonText = buttonText;
      }
      return card;
    });
  }
}
