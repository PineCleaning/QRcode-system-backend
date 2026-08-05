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

  /** Defaults to "REQUEST DETAILS" - the plain-text field written with feedback text + mobile number + attachment links. */
  @IsString()
  @IsOptional()
  requestDetailsFieldName?: string;

  /** Defaults to "REQUEST TYPE" - the dropdown field every ticket's Request Type gets set on. */
  @IsString()
  @IsOptional()
  requestTypeFieldName?: string;

  /** Defaults to "Other" - the dropdown option every ticket uses (no "Feedback" option exists, per the client). */
  @IsString()
  @IsOptional()
  requestTypeOptionName?: string;

  /** Defaults to "CLIENT ID" - the field on the COMPANIES list matched against our client_id, to disambiguate same-named clients. Optional: falls back to name-only matching if not found. */
  @IsString()
  @IsOptional()
  companyClientIdFieldName?: string;
}
