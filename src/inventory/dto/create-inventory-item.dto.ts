import { IsDateString, IsIn, IsInt, IsOptional, IsString, Min, MinLength } from 'class-validator';

const STATUSES = [
  'IN_STOCK',
  'LOW_STOCK',
  'URGENT_LOW_STOCK',
  'OUT_OF_STOCK',
  'GOOD',
  'NEEDS_REPAIR',
  'OUT_OF_SERVICE',
] as const;

const CATEGORIES = [
  'CHEMICAL',
  'PPE',
  'CONSUMABLES',
  'CLEANING_TOOLS_MANUAL',
  'POWERED_EQUIPMENT_MACHINERY',
  'SPARE_PARTS',
  'OTHER',
] as const;

export class CreateInventoryItemDto {
  @IsString()
  @MinLength(1)
  item!: string;

  @IsIn(CATEGORIES)
  category!: (typeof CATEGORIES)[number];

  @IsIn(STATUSES)
  status!: (typeof STATUSES)[number];

  @IsInt()
  @Min(0)
  quantity!: number;

  @IsDateString()
  @IsOptional()
  lastSupplyDate?: string;

  @IsString()
  @IsOptional()
  notes?: string;
}
