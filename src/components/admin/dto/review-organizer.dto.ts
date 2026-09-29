import { IsIn, IsOptional, IsString, MaxLength } from "class-validator";

/** Решение админа по заявке организатора на проверку документов. */
export class ReviewOrganizerDto {
  @IsIn(["approve", "reject"])
  action: "approve" | "reject";

  /**
   * Причина отказа. Обязательна при reject — проверяется в сервисе, а не
   * здесь: при approve поле не нужно, и разделять DTO ради этого избыточно.
   */
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}
