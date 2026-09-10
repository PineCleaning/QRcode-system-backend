import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

export class FindAllFeedbackQueryDto {
  @IsUUID()
  @IsOptional()
  clientCode?: string;

  @IsUUID()
  @IsOptional()
  siteId?: string;

  /**
   * Undefined -> no filter (all feedback). Powers both the Feedback page and
   * the Flagged tab. Query strings arrive as "true"/"false" text, not real
   * booleans - a plain `@Type(() => Boolean)` would coerce the string
   * "false" to `true` (any non-empty string is truthy), so this maps the
   * two expected literal values explicitly instead.
   */
  @Transform(({ value }) => (value === 'true' ? true : value === 'false' ? false : value))
  @IsBoolean()
  @IsOptional()
  flagged?: boolean;

  /** No page/pageSize -> unchanged full-array response (see AdminFeedbackService.findAll). */
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @IsOptional()
  page?: number;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  @IsOptional()
  pageSize?: number;
}
