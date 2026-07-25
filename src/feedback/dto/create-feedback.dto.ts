import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsIn,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

const MAX_ATTACHMENTS = 5;

export class FeedbackMediaDto {
  @IsString()
  cloudinaryPublicId!: string;

  @IsIn(['IMAGE', 'VIDEO'])
  resourceType!: 'IMAGE' | 'VIDEO';

  @IsString()
  @IsOptional()
  originalFilename?: string;

  @IsString()
  mimeType!: string;

  @IsInt()
  @IsPositive()
  sizeBytes!: number;
}

export class CreateFeedbackDto {
  /** Generated client-side (plain UUID v4) at form-mount time - guarantees a retried submission never creates two tickets. */
  @IsUUID('4')
  idempotencyKey!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  feedback!: string;

  @IsString()
  @MaxLength(32)
  @IsOptional()
  mobileNumber?: string;

  @ValidateNested({ each: true })
  @Type(() => FeedbackMediaDto)
  @ArrayMaxSize(MAX_ATTACHMENTS, { message: `A maximum of ${MAX_ATTACHMENTS} files can be attached per submission` })
  @IsOptional()
  media?: FeedbackMediaDto[];
}
