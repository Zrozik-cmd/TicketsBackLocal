import { IsIn, IsOptional } from 'class-validator';
import type { BannerLocale } from '../types/banner.types';

const LOCALES: BannerLocale[] = ['en', 'ru', 'th'];

export class PublicBannersQueryDto {
  @IsOptional()
  @IsIn(LOCALES)
  locale?: BannerLocale;
}
