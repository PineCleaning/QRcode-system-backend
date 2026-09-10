import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, UseGuards } from '@nestjs/common';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { AdminUsersService } from './admin-users.service';
import { CreateAdminUserDto } from './dto/create-admin-user.dto';
import { UpdateAdminUserDto } from './dto/update-admin-user.dto';

/** Every route here is Admin-only, at the controller level - there is no supervisor-accessible sub-resource, unlike Clients/Sites which at least allow read access to both roles. */
@Controller('admin-users')
@UseGuards(SupabaseAuthGuard, RolesGuard)
@Roles('ADMIN')
export class AdminUsersController {
  constructor(private readonly service: AdminUsersService) {}

  @Get()
  findAll() {
    return this.service.findAll();
  }

  @Post()
  create(@Body() dto: CreateAdminUserDto) {
    return this.service.create(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateAdminUserDto) {
    return this.service.update(id, dto);
  }

  @Post(':id/reset-password')
  @HttpCode(200)
  resetPassword(@Param('id') id: string) {
    return this.service.resetPassword(id);
  }

  /** Admin-only (already true for the whole controller). Blocks deleting the Admin account itself - see AdminUsersService.remove(). */
  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
