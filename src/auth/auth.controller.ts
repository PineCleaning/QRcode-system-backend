import { Controller, Get, UseGuards } from '@nestjs/common';
import type { AdminUser } from '../../generated/prisma/client';
import { CurrentAdmin } from './current-admin.decorator';
import { SupabaseAuthGuard } from './supabase-auth.guard';

@Controller('auth')
export class AuthController {
  @Get('me')
  @UseGuards(SupabaseAuthGuard)
  me(@CurrentAdmin() adminUser: AdminUser) {
    return adminUser;
  }
}
