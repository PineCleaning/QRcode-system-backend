import { IsEmail, IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

/** Matches CONTACT_PHONE_PATTERN in create-client.dto.ts and csv-import.service.ts - keep all three in sync. */
const CONTACT_PHONE_PATTERN = /^[0-9+-]+$/;

/** No clientCode here - it's immutable after creation (see CreateClientDto). */
export class UpdateClientDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  @IsOptional()
  name?: string;

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

  @IsIn(['ACTIVE', 'INACTIVE'])
  @IsOptional()
  status?: 'ACTIVE' | 'INACTIVE';
}
