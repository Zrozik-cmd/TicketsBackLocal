import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import {
  LINE_CHANNEL_ACCESS_TOKEN_MAX_LENGTH,
  LINE_CHANNEL_SECRET_MAX_LENGTH,
  LINE_GROUP_ID_PATTERN,
} from '../constants/event-messengers.constants';

export class LineIntegrationTriggersDto {
  @IsOptional()
  @IsBoolean()
  orderPaid?: boolean;

  @IsOptional()
  @IsBoolean()
  sessionCancelled?: boolean;

  @IsOptional()
  @IsBoolean()
  salesClosed?: boolean;

  @IsOptional()
  @IsBoolean()
  salesOpened?: boolean;

  @IsOptional()
  @IsBoolean()
  reviewCreated?: boolean;
}

/**
 * `PUT admin/events/:id/messengers/line` — create or update. Every field is optional;
 * creating needs both credentials. Omitted credentials keep the stored ones.
 */
export class UpdateLineIntegrationDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(LINE_CHANNEL_ACCESS_TOKEN_MAX_LENGTH)
  channelAccessToken?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(LINE_CHANNEL_SECRET_MAX_LENGTH)
  channelSecret?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @ValidateNested()
  @Type(() => LineIntegrationTriggersDto)
  triggers?: LineIntegrationTriggersDto;

  /** Manual fallback when the `join` webhook never arrived; `null` disconnects the group. */
  @IsOptional()
  @IsString()
  @Matches(LINE_GROUP_ID_PATTERN, { message: 'groupId must look like C followed by 32 hex digits' })
  groupId?: string | null;
}
