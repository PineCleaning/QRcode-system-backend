import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** No email here - immutable after creation, matches the pattern already used by clientId/siteCode elsewhere in this app. */
export class UpdateAdminUserDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  @IsOptional()
  fullName?: string;

  @IsIn(['ADMIN', 'SUPERVISOR'])
  @IsOptional()
  role?: 'ADMIN' | 'SUPERVISOR';

  @IsIn(['ACTIVE', 'INACTIVE'])
  @IsOptional()
  status?: 'ACTIVE' | 'INACTIVE';
}
