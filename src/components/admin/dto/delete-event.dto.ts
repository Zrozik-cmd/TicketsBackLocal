import { IsString, MaxLength } from "class-validator";

export class DeleteEventDto {
  @IsString()
  @MaxLength(100)
  confirmation!: string;
}
