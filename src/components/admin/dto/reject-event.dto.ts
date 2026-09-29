import { IsString, MaxLength, MinLength } from "class-validator";

export class RejectEventDto {
  @IsString()
  @MinLength(1)
  @MaxLength(4000)
  rejectReason!: string;
}
