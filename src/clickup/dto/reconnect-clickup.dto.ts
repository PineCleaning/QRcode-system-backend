import { IsNotEmpty, IsString } from 'class-validator';

export class ReconnectClickupDto {
  /** A fresh ClickUp personal API token (starts with "pk_"), pasted by an admin after regenerating it in ClickUp. */
  @IsString()
  @IsNotEmpty()
  token!: string;
}
