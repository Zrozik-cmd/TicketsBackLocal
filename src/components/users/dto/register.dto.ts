import {
  IsEmail,
  IsIn,
  IsString,
  IsOptional,
  IsUrl,
  IsBoolean,
  Length,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
  IsDefined,
} from 'class-validator';
import { Type } from 'class-transformer';

export class CategoryDto {
  @IsString()
  id: string;

  @IsString()
  @MaxLength(200)
  label: string;
}

export class RegisterDto {
  @IsDefined()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  companyVenueName: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  displayName?: string;

  @IsDefined()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  responsiblePersonFullName: string;

  @IsDefined()
  @ValidateNested()
  @Type(() => CategoryDto)
  category: CategoryDto;

  @IsEmail()
  email: string;

  @IsString()
  @MinLength(10)
  @MaxLength(25)
  @Matches(/^[+]?[0-9\s()-]+$/, { message: 'phoneNumber must contain only digits and optional + - ( )' })
  phoneNumber: string;

  @IsOptional()
  @IsUrl()
  @MaxLength(500)
  websiteOrSocialLink?: string;

  @IsDefined()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  businessAddress: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  city?: string;

  @IsDefined()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  provinceRegion: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  country?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  shortDescription?: string;

  /** Язык интерфейса при регистрации — на нём организатору идут письма. */
  @IsOptional()
  @IsIn(['en', 'ru', 'th'])
  locale?: 'en' | 'ru' | 'th';

  @IsOptional()
  @IsString()
  @MaxLength(50)
  taxRegistrationId?: string;

  /*
   * Номер регистрации компании в DBD (Департамент развития бизнеса Таиланда).
   * Обязателен: без него платформа не может проверить организатора. Ровно 13
   * цифр — форма режет ввод по той же длине, и расходиться они не должны.
   */
  @IsDefined({ message: 'companyRegistrationDbd is required' })
  @IsString()
  @Matches(/^\d{13}$/, {
    message: 'companyRegistrationDbd must be exactly 13 digits',
  })
  companyRegistrationDbd: string;

  /*
   * Выписка DBD (e-Certificate / Affidavit) — PDF в виде data URL, тоже
   * обязательна. Предел длины подобран под тело запроса: express настроен на
   * 12 МБ, а base64 раздувает файл примерно в 1.37 раза. MinLength отсекает
   * пустой data URL — по префиксу он неотличим от настоящего файла.
   */
  @IsDefined({ message: 'companyRegistrationDbdFile is required' })
  @IsString()
  @MinLength(200, {
    message: 'companyRegistrationDbdFile must be a non-empty PDF',
  })
  @MaxLength(11500000)
  @Matches(/^data:application\/pdf;base64,/, {
    message: 'companyRegistrationDbdFile must be a base64 PDF data URL',
  })
  companyRegistrationDbdFile: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  eventsPerMonth?: string;

  @IsString()
  @Length(6, 6, { message: 'emailCode must be exactly 6 characters' })
  emailCode: string;

  @IsString()
  @Length(6, 6, { message: 'phoneCode must be exactly 6 characters' })
  phoneCode: string;

  @IsBoolean()
  termsAccepted: boolean; // must be true to complete registration (checkbox on form)
}
