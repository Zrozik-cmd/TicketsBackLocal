import { IsDefined, ValidateNested } from "class-validator";
import { Type } from "class-transformer";
import { LocalizedTextDto } from "../../events/dto/shared.dto";

export class UpdateEventDescriptionDto {
  @IsDefined()
  @ValidateNested()
  @Type(() => LocalizedTextDto)
  description!: LocalizedTextDto;
}
