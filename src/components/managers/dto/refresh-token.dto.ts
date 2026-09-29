import { IsString, MinLength } from 'class-validator';

export class ManagerRefreshTokenDto {
  @IsString()
  @MinLength(10)
  refreshToken: string;
}
