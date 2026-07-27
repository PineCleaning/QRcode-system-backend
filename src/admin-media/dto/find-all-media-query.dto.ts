import { IsOptional, IsUUID } from 'class-validator';

export class FindAllMediaQueryDto {
  @IsUUID()
  @IsOptional()
  clientId?: string;

  @IsUUID()
  @IsOptional()
  siteId?: string;
}
