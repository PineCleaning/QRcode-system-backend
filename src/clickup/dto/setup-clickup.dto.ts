import { IsNotEmpty, IsOptional, IsString } from 'class-validator';

export class SetupClickupDto {
  @IsString()
  @IsNotEmpty()
  ticketsListId!: string;

  @IsString()
  @IsNotEmpty()
  companiesListId!: string;

  /** Defaults to "CLIENT NAME" - the Relationship field name confirmed to already exist on the tickets list. */
  @IsString()
  @IsOptional()
  clientFieldName?: string;
}
