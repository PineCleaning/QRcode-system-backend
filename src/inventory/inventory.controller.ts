import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, UseGuards } from '@nestjs/common';
import type { AdminUser } from '../../generated/prisma/client';
import { CurrentAdmin } from '../auth/current-admin.decorator';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { CreateInventoryItemDto } from './dto/create-inventory-item.dto';
import { UpdateInventoryItemDto } from './dto/update-inventory-item.dto';
import { InventoryService } from './inventory.service';

@Controller()
@UseGuards(SupabaseAuthGuard, RolesGuard)
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  @Post('sites/:siteId/inventory')
  create(@Param('siteId') siteId: string, @Body() dto: CreateInventoryItemDto, @CurrentAdmin() admin: AdminUser) {
    return this.inventory.create(siteId, dto, admin.id);
  }

  @Get('sites/:siteId/inventory')
  findAllForSite(@Param('siteId') siteId: string) {
    return this.inventory.findAllForSite(siteId);
  }

  @Get('inventory/:id')
  findOne(@Param('id') id: string) {
    return this.inventory.findOne(id);
  }

  @Get('inventory/:id/history')
  findHistory(@Param('id') id: string) {
    return this.inventory.findHistory(id);
  }

  @Put('inventory/:id')
  update(@Param('id') id: string, @Body() dto: UpdateInventoryItemDto, @CurrentAdmin() admin: AdminUser) {
    return this.inventory.update(id, dto, admin.id);
  }

  @Delete('inventory/:id')
  @Roles('ADMIN')
  @HttpCode(204)
  remove(@Param('id') id: string) {
    return this.inventory.remove(id);
  }
}
