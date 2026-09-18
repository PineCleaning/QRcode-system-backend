import { IsIn, IsInt, IsOptional, IsPositive, IsString } from 'class-validator';

/** Same shape as FeedbackMediaDto - see src/feedback/dto/create-feedback.dto.ts. */
export class InspectionMediaDto {
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
