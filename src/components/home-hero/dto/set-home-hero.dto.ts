import { IsBoolean } from 'class-validator';

/** PUT /admin/events/:id/home-hero */
export class SetHomeHeroDto {
  /** `true` — показывать это событие на первом экране; `false` — вернуть режим по умолчанию. */
  @IsBoolean()
  featured!: boolean;
}
