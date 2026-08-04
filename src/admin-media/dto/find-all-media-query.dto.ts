import { IsOptional, IsUUID } from 'class-validator';

export class FindAllMediaQueryDto {
  @IsUUID()
  @IsOptional()
  clientCode?: string;

  @IsUUID()
  @IsOptional()
  siteId?: string;
}
