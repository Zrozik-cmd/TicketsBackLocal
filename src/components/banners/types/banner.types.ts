import type { ILocalizedText } from '../../events/schemas/event.schema';
import type { ILocalizedImage } from '../schemas/banner.schema';

export type BannerLocale = 'en' | 'ru' | 'th';

export type LocalizedImageUrl = {
  th?: string;
  en?: string;
  ru?: string;
};

export type PublicBannerCard = {
  tag?: string;
  title?: string;
  description?: string;
  buttonText?: string;
  bgImage: string;
  href: string;
};

export type AdminBannerListItem = {
  id: number;
  tag?: ILocalizedText;
  title?: ILocalizedText;
  description?: ILocalizedText;
  buttonText?: ILocalizedText;
  bgImage: ILocalizedImage;
  bgImageUrl: LocalizedImageUrl;
  href: string;
  sortOrder: number;
  isActive: boolean;
  scheduleEnabled: boolean;
  startsAt?: string;
  endsAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type AdminBannerDetails = AdminBannerListItem;

export type AdminBannersListResult = {
  items: AdminBannerListItem[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};
