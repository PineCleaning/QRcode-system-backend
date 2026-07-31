import { IsString, MaxLength, MinLength } from 'class-validator';

/** No siteCode/slug here - both are system-generated (see SitesService.create). */
export class CreateSiteDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  siteName!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(300)
  address!: string;
}
