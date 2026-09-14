import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Both optional and independent - GET /sites/:siteId/inventory with
 * neither param set keeps returning the full unpaginated array, same
 * backward-compatible convention as FindAllClientsQueryDto. Only sending
 * page/pageSize switches the response to the paginated { data, total, ... }
 * shape - see InventoryService.findAllForSite.
 */
export class FindAllInventoryQueryDto {
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
