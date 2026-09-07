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
import {
  INSPECTION_RATINGS,
  MAX_ATTACHMENTS,
} from './create-inspection-item.dto';
import { InspectionMediaDto } from './inspection-media.dto';

export class UpdateInspectionItemDto {
  @IsString()
  @MinLength(1)
  @IsOptional()
  spaceName?: string;

  @IsOptional()
  @IsBoolean()
  isNotApplicable?: boolean;

  @ValidateIf((dto: UpdateInspectionItemDto) => !dto.isNotApplicable)
  @IsIn(INSPECTION_RATINGS)
  rating?: (typeof INSPECTION_RATINGS)[number];

  @ValidateIf((dto: UpdateInspectionItemDto) => !dto.isNotApplicable)
  @IsInt()
  @Min(0)
  @Max(100)
  percentage?: number;

  @IsOptional()
  @IsString()
  notes?: string;

  /** Additive - new files to attach on top of whatever the item already has, not a replacement list. See InspectionsService.updateItem. */
  @ValidateNested({ each: true })
  @Type(() => InspectionMediaDto)
  @ArrayMaxSize(MAX_ATTACHMENTS, {
    message: `A maximum of ${MAX_ATTACHMENTS} files can be attached per item`,
  })
  @IsOptional()
  media?: InspectionMediaDto[];
}
