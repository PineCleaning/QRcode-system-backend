import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Both optional and independent - GET /clients with neither param set
 * keeps returning the full unpaginated array (existing callers like the
 * Feedback/Assets filter dropdowns rely on that shape and never send
 * these params). Only sending page/pageSize switches the response to
 * the paginated { data, total, ... } shape - see ClientsService.findAll.
 */
export class FindAllClientsQueryDto {
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
