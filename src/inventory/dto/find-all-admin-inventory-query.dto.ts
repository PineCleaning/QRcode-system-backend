import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

export class FindAllAdminInventoryQueryDto {
  @IsUUID()
  @IsOptional()
  clientCode?: string;

  @IsUUID()
  @IsOptional()
  siteId?: string;

  /** No page/pageSize -> unchanged full-array response (see InventoryService.findAllGlobal). */
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
