import { IsEmail, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

const CLIENT_CODE_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** Matches CONTACT_PHONE_PATTERN in csv-import.service.ts - keep both in sync. */
const CONTACT_PHONE_PATTERN = /^[0-9+-]+$/;

export class CreateClientDto {
  /** Immutable after creation - it's baked into every site's slug ({client_code}-{site_code}). */
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  @Matches(CLIENT_CODE_PATTERN, {
    message: 'clientCode must be lowercase alphanumeric with optional hyphens (e.g. "acme001")',
  })
  clientCode!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsEmail()
  @IsOptional()
  contactEmail?: string;

  @IsString()
  @MaxLength(32)
  @Matches(CONTACT_PHONE_PATTERN, {
    message: 'contactPhone must contain only digits, + and - (e.g. "+61-2-1111-1111")',
  })
  @IsOptional()
  contactPhone?: string;
}
