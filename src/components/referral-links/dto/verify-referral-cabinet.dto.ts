import { IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class VerifyReferralCabinetDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  internalName: string;

  @IsString()
  @Matches(/^\d{4}$/)
  pin: string;
}
