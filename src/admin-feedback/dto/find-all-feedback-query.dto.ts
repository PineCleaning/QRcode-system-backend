import { IsOptional, IsUUID } from 'class-validator';

export class FindAllFeedbackQueryDto {
  @IsUUID()
  @IsOptional()
  clientId?: string;

  @IsUUID()
  @IsOptional()
  siteId?: string;
}
