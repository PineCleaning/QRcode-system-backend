import { IsBoolean } from 'class-validator';

/** Shared by admin-feedback and inspections - toggles the `flagged` boolean on a row. */
export class FlagDto {
  @IsBoolean()
  flagged!: boolean;
}
