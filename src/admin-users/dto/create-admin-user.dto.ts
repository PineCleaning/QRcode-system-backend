import { IsEmail, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateAdminUserDto {
  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(200)
  @IsOptional()
  fullName?: string;

  @IsIn(['ADMIN', 'SUPERVISOR'])
  role!: 'ADMIN' | 'SUPERVISOR';
}
