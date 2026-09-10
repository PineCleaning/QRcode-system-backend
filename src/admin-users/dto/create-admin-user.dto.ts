import { IsEmail, IsIn, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * 'ADMIN' is deliberately never a selectable value here - confirmed
 * with the user 2026-09-10: there is exactly one Admin, ever
 * (test@example.com), enforced as a hard DB guarantee via
 * uq_admin_users_single_admin. This is the app-layer half of that -
 * even if the DB constraint were somehow bypassed, this endpoint
 * itself can never be asked to create a second Admin. Manager and
 * Admin Support get identical access to Supervisor (this app's whole
 * authorization model is binary: ADMIN vs. everyone else).
 */
export class CreateAdminUserDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  fullName!: string;

  @IsIn(['SUPERVISOR', 'MANAGER', 'ADMIN_SUPPORT'])
  role!: 'SUPERVISOR' | 'MANAGER' | 'ADMIN_SUPPORT';
}
