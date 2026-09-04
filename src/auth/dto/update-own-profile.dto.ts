import { IsString, MinLength } from 'class-validator';

/** Self-service profile edit - fullName only. Role/status/email are deliberately not editable here at all (not just omitted from the DTO): role changes stay Admin-only via AdminUsersController, email is immutable app-wide. */
export class UpdateOwnProfileDto {
  @IsString()
  @MinLength(1)
  fullName!: string;
}
