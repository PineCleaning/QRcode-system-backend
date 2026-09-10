import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * No email here - immutable after creation, matches the pattern
 * already used by clientId/siteCode elsewhere in this app.
 *
 * 'ADMIN' is deliberately never a settable value here either - no one
 * can be promoted to Admin, matching CreateAdminUserDto (see its
 * comment). The sole existing Admin's own role is therefore never
 * sent by the Edit form at all (see EditAdminUserModal.tsx) - not
 * "kept as ADMIN via this field," just never included in the request.
 */
export class UpdateAdminUserDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  @IsOptional()
  fullName?: string;

  @IsIn(['SUPERVISOR', 'MANAGER', 'ADMIN_SUPPORT'])
  @IsOptional()
  role?: 'SUPERVISOR' | 'MANAGER' | 'ADMIN_SUPPORT';

  @IsIn(['ACTIVE', 'INACTIVE'])
  @IsOptional()
  status?: 'ACTIVE' | 'INACTIVE';
}
