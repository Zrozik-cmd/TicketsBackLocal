import { IsString, Matches } from 'class-validator';

export class ManagerSignInWithPinDto {
  @IsString()
  @Matches(/^\d{6}$/, { message: 'pin must be a 6-digit numeric code' })
  pin: string;
}
