import { Type } from 'class-transformer';
import {
  Allow,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import {
  CMS_ATOMIC_FIELD_TYPES,
  CMS_FIELD_TYPES,
  CMS_LOCALES,
  type CmsAtomicFieldType,
  type CmsFieldType,
  type CmsLocale,
  type CmsPublicationStatus,
} from '../types/cms.types';

export class CmsLocaleQueryDto {
  @IsOptional()
  @IsIn(CMS_LOCALES)
  lang?: CmsLocale;
}

export class CreateCmsPageDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  slug?: string;

  @IsOptional()
  @IsIn(['draft', 'published'])
  publication?: CmsPublicationStatus;

  @IsOptional()
  @IsArray()
  @Allow()
  sections?: unknown[];
}

export class UpdateCmsPageDto extends CreateCmsPageDto {}

export class CreateCmsSectionDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  name?: string;

  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  visible?: boolean;

  @IsOptional()
  @IsArray()
  @Allow()
  fields?: unknown[];
}

export class UpdateCmsSectionDto extends CreateCmsSectionDto {}

export class CreateCmsFieldDto {
  @IsIn(CMS_FIELD_TYPES)
  type: CmsFieldType;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  label?: string;

  @Allow()
  payload?: unknown;
}

export class CreateCmsAtomicFieldDto {
  @IsIn(CMS_ATOMIC_FIELD_TYPES)
  type: CmsAtomicFieldType;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  label?: string;

  @Allow()
  payload?: unknown;
}

export class ReorderCmsItemsDto {
  @IsArray()
  @IsString({ each: true })
  ids: string[];
}

export class CreateCmsRepeaterItemDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  title?: string;

  @IsOptional()
  @IsArray()
  @Allow()
  fields?: unknown[];
}

/** Body for POST .../repeaters/:repeaterId/location-cards */
export class CreateCmsLocationCardDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  title?: string;

  /** When false, card is stored but omitted from public content API. Default true. */
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  showCard?: boolean;

  @IsOptional()
  @IsArray()
  @Allow()
  fields?: unknown[];
}

export class UploadCmsImageDto {
  @IsOptional()
  @IsString()
  dataUrl?: string;

  @IsOptional()
  @IsString()
  imageUrl?: string;

  @IsOptional()
  @IsString()
  fileName?: string;

  @IsOptional()
  @IsString()
  mimeType?: string;
}

export class AutoTranslateCmsDto {
  @IsIn(CMS_LOCALES)
  sourceLang: CmsLocale;

  @Allow()
  value: unknown;
}
