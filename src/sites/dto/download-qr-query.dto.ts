import { IsIn, IsOptional } from 'class-validator';

export class DownloadQrQueryDto {
  @IsIn(['png', 'pdf'])
  @IsOptional()
  format?: 'png' | 'pdf' = 'png';

  /** Only relevant when format=pdf. */
  @IsIn(['A4', 'A5'])
  @IsOptional()
  size?: 'A4' | 'A5' = 'A4';
}
