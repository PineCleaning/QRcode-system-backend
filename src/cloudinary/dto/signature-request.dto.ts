import { IsOptional, IsString, MaxLength } from 'class-validator';

export class SignatureRequestDto {
  /** e.g. "feedback/{slug}" - keeps uploads organized per site in Cloudinary. */
  @IsString()
  @MaxLength(200)
  @IsOptional()
  folder?: string;
}
