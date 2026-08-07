import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** No clientId here - it's immutable after creation (see CreateClientDto). */
export class UpdateClientDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  @IsOptional()
  clientName?: string;

  @IsIn(['ACTIVE', 'INACTIVE'])
  @IsOptional()
  status?: 'ACTIVE' | 'INACTIVE';
}
