import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import {
  LabelStyle,
  NodeForm,
  NodeKind,
  ObjectType,
  PlaygroundType,
  SectorType,
  SeatType,
  VenueType,
} from "../constants/seating-plan.constants";

// ### ValidationPipe включён с whitelist и forbidNonWhitelisted, а неявное приведение типов
// ### выключено: поле без декоратора роняет запрос в 400, числа из query приходят
// ### строками — приводим их Number() уже в сервисе.

export class CreatePlanDto {
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsString() roomTitle?: string;
  @IsOptional() @IsString() currency?: string;
}

export class PlanIdDto {
  @IsOptional() @IsString() id?: string;
}

export class UpdatePlanDto {
  @IsInt() @IsPositive() id: number;
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsString() currency?: string;
  @IsOptional() @IsInt() preview?: number;
}

export class SavePlanDto {
  @IsInt() @IsPositive() id: number;
  @IsString() title: string;
}

export class DuplicatePlanDto {
  @IsInt() @IsPositive() id: number;
  @IsOptional() @IsString() title?: string;
}

export class DeletePlanDto {
  @IsInt() @IsPositive() id: number;
}

export class PublishPlanDto {
  @IsInt() @IsPositive() id: number;
  @IsInt() @IsPositive() eventId: number;
}

export class UnpublishPlanDto {
  @IsInt() @IsPositive() id: number;
}

// ### Мягкий патч опубликованного плана: только то, что не меняет идентичность мест
export class PatchPublishedDto {
  @IsInt() @IsPositive() id: number;
  @IsArray() nodes: { id: number; ticket?: object; title?: string; color?: string; photo?: number }[];
}

export class ListPlansDto {
  @IsOptional() @IsString() search?: string;
  @IsOptional() @IsString() status?: string;
  @IsOptional() @IsString() page?: string;
  @IsOptional() @IsString() limit?: string;
  @IsOptional() @IsString() sort?: string;
  @IsOptional() @IsString() order?: string;
}

export class GetPlanDto {
  @IsString() id: string;
}

export class SummaryDto {
  @IsString() id: string;
  @IsOptional() @IsString() nodeId?: string;
}

export class ExpandSectorDto {
  @IsString() id: string;
}

export class ClearCanvasDto {
  @IsInt() @IsPositive() planId: number;
  @IsOptional() @IsInt() roomId?: number;
}

export class CreateRoomDto {
  @IsInt() @IsPositive() planId: number;
  @IsOptional() @IsString() title?: string;
  // ### Модалка Add Room заодно переименовывает основной холст
  @IsOptional() @IsString() mainRoomTitle?: string;
  @IsOptional() @IsObject() canvas?: object;
}

export class UpdateRoomDto {
  @IsInt() @IsPositive() id: number;
  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsInt() order?: number;
  @IsOptional() @IsObject() canvas?: object;
}

export class DeleteRoomDto {
  @IsInt() @IsPositive() id: number;
}

// ### geometry/ticket/numbering объявлены как объекты и проверяются в сервисе —
// ### расписывать всё дерево через ValidateNested здесь смысла нет, форма ещё меняется
export class CreateNodeDto {
  @IsInt() @IsPositive() planId: number;
  @IsInt() @IsPositive() roomId: number;
  @IsEnum(NodeKind) kind: NodeKind;

  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsObject() geometry?: object;
  @IsOptional() @IsString() color?: string;

  @IsOptional() @IsEnum(VenueType) venueType?: VenueType;
  @IsOptional() @IsEnum(PlaygroundType) playgroundType?: PlaygroundType;
  @IsOptional() @IsEnum(NodeForm) form?: NodeForm;

  @IsOptional() @IsEnum(SectorType) sectorType?: SectorType;
  @IsOptional() @IsInt() @Min(0) rowsCount?: number;
  @IsOptional() @IsInt() @Min(0) seatsPerRow?: number;
  @IsOptional() @IsInt() @Min(0) capacity?: number;
  @IsOptional() @IsEnum(SeatType) seatType?: SeatType;
  @IsOptional() @IsObject() numbering?: object;
  @IsOptional() @IsObject() ticket?: object;

  @IsOptional() @IsEnum(ObjectType) objectType?: ObjectType;
  @IsOptional() @IsInt() @Min(0) tableNumber?: number;
  // ### Декор (стол, стул, диван, места для МГН): мест не даёт, ticket игнорируется
  @IsOptional() @IsBoolean() decor?: boolean;
  // ### Подпись (objectType: text_label): многострочный текст через \n
  @IsOptional() @IsString() @MaxLength(500) text?: string;
  @IsOptional() @IsNumber() @Min(8) @Max(120) fontSize?: number;
  @IsOptional() @IsEnum(LabelStyle) labelStyle?: LabelStyle;
}

export class UpdateNodeDto {
  @IsInt() @IsPositive() id: number;

  @IsOptional() @IsString() title?: string;
  @IsOptional() @IsObject() geometry?: object;
  @IsOptional() @IsString() color?: string;
  @IsOptional() @IsBoolean() locked?: boolean;

  @IsOptional() @IsEnum(VenueType) venueType?: VenueType;
  @IsOptional() @IsEnum(PlaygroundType) playgroundType?: PlaygroundType;
  @IsOptional() @IsEnum(NodeForm) form?: NodeForm;

  @IsOptional() @IsEnum(SectorType) sectorType?: SectorType;
  @IsOptional() @IsInt() @Min(0) rowsCount?: number;
  @IsOptional() @IsInt() @Min(0) seatsPerRow?: number;
  @IsOptional() @IsInt() @Min(0) capacity?: number;
  @IsOptional() @IsEnum(SeatType) seatType?: SeatType;
  @IsOptional() @IsObject() numbering?: object;
  @IsOptional() @IsObject() ticket?: object;

  @IsOptional() @IsEnum(ObjectType) objectType?: ObjectType;
  @IsOptional() @IsInt() @Min(0) tableNumber?: number;
  // ### Декор (стол, стул, диван, места для МГН): мест не даёт, ticket игнорируется
  @IsOptional() @IsBoolean() decor?: boolean;
  // ### Подпись (objectType: text_label): многострочный текст через \n
  @IsOptional() @IsString() @MaxLength(500) text?: string;
  @IsOptional() @IsNumber() @Min(8) @Max(120) fontSize?: number;
  @IsOptional() @IsEnum(LabelStyle) labelStyle?: LabelStyle;
}

// ### Один запрос на завершённый drag или поворот группы: без него конструктор
// ### молотил бы сеть на каждый mousemove
export class BulkUpdateNodesDto {
  @IsInt() @IsPositive() planId: number;
  @IsArray() items: { id: number; geometry: object }[];
}

export class NodeIdDto {
  @IsInt() @IsPositive() id: number;
}

export class NodePhotoDto {
  @IsInt() @IsPositive() id: number;
  // ### Уже загруженное фото (Media.id) этого организатора; null снимает фото
  @IsOptional() @IsNumber() mediaId?: number | null;
  // ### Новое фото data-URL'ом: бек сам кладёт его в Media, как обложки событий
  @IsOptional() @IsString() @MaxLength(8 * 1024 * 1024) image?: string;
}

export class ReparentNodeDto {
  @IsInt() @IsPositive() id: number;
  @IsOptional() @IsNumber() parentId?: number | null;
}

export class UpdateRowDto {
  @IsInt() @IsPositive() id: number;
  @IsOptional() @IsString() label?: string;
  @IsOptional() @IsInt() @Min(0) seatsCount?: number;
  @IsOptional() @IsString() seatType?: string;
  @IsOptional() @IsString() color?: string;
  @IsOptional() @IsObject() ticket?: object;
  @IsOptional() @IsObject() numbering?: object;
  @IsOptional() @IsObject() geometry?: object;
}

// ### Применение настройки ко "Всему сектору" из правой панели
export class BulkUpdateRowsDto {
  @IsInt() @IsPositive() sectorId: number;
  @IsObject() patch: object;
}

export class UpdateSeatDto {
  @IsInt() @IsPositive() rowId: number;
  @IsInt() @Min(0) index: number;
  @IsOptional() @IsString() label?: string;
  @IsOptional() @IsString() seatType?: string;
  @IsOptional() @IsString() color?: string;
  @IsOptional() @IsObject() ticket?: object;
  @IsOptional() @IsBoolean() disabled?: boolean;
}

export class BulkUpdateSeatsDto {
  @IsInt() @IsPositive() sectorId: number;
  @IsArray() seats: { rowId: number; index: number; patch: object }[];
}

export class ResetSeatDto {
  @IsInt() @IsPositive() rowId: number;
  @IsInt() @Min(0) index: number;
}
