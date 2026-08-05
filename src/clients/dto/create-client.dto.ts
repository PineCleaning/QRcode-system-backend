import { IsEmail, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

/** Case-insensitive input - ClientsService.create() lowercases before saving, so "ACME" and "acme" always resolve to the same stored clientId. */
const CLIENT_CODE_PATTERN = /^[a-zA-Z0-9]+(-[a-zA-Z0-9]+)*$/;
/** Matches CONTACT_PHONE_PATTERN in csv-import.service.ts - keep both in sync. */
const CONTACT_PHONE_PATTERN = /^[0-9+-]+$/;

export class CreateClientDto {
  /** Immutable after creation - identifies the client throughout the admin portal (site slugs no longer derive from this, see SitesService.create). */
  @IsString()
  @MinLength(2)
  @MaxLength(50)
  @Matches(CLIENT_CODE_PATTERN, {
    message: 'clientId must be alphanumeric with optional hyphens (e.g. "acme001")',
  })
  clientId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  clientName!: string;

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
