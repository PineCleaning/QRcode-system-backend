import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** No siteCode/slug here - both are permanent once created (printed on physical QR codes). */
export class UpdateSiteDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  @IsOptional()
  businessName?: string;

  @IsString()
  @MaxLength(300)
  @IsOptional()
  address?: string;

  @IsIn(['ACTIVE', 'INACTIVE'])
  @IsOptional()
  status?: 'ACTIVE' | 'INACTIVE';
}
