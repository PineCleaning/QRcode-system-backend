import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  MinLength,
  ValidateNested,
  ValidateIf,
} from 'class-validator';
import { InspectionMediaDto } from './inspection-media.dto';

export const INSPECTION_RATINGS = [
  'EXCELLENT',
  'ABOVE_AVERAGE',
  'AVERAGE',
  'BELOW_AVERAGE',
  'VERY_POOR',
] as const;

/** Matches feedback's cap (Open Decision #11) - same per-item ceiling, not per-inspection. */
export const MAX_ATTACHMENTS = 5;

export class CreateInspectionItemDto {
  @IsString()
  @MinLength(1)
  spaceName!: string;

  @IsOptional()
  @IsBoolean()
  isNotApplicable?: boolean;

  /** Required unless isNotApplicable - rating/percentage are meaningless for a space that wasn't inspected. */
  @ValidateIf((dto: CreateInspectionItemDto) => !dto.isNotApplicable)
  @IsIn(INSPECTION_RATINGS)
  rating?: (typeof INSPECTION_RATINGS)[number];

  /** Cross-checked against the selected rating's own range in the service (e.g. EXCELLENT: 95-100) - the 0-100 bound here is just the basic shape check. */
  @ValidateIf((dto: CreateInspectionItemDto) => !dto.isNotApplicable)
  @IsInt()
  @Min(0)
  @Max(100)
  percentage?: number;

  @IsOptional()
  @IsString()
  notes?: string;

  @ValidateNested({ each: true })
  @Type(() => InspectionMediaDto)
  @ArrayMaxSize(MAX_ATTACHMENTS, {
    message: `A maximum of ${MAX_ATTACHMENTS} files can be attached per item`,
  })
  @IsOptional()
  media?: InspectionMediaDto[];
}
