import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, UseGuards } from '@nestjs/common';
import type { AdminUser } from '../../generated/prisma/client';
import { CurrentAdmin } from '../auth/current-admin.decorator';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { CreateInventoryItemDto } from './dto/create-inventory-item.dto';
import { FindAllAdminInventoryQueryDto } from './dto/find-all-admin-inventory-query.dto';
import { FindAllInventoryQueryDto } from './dto/find-all-inventory-query.dto';
import { UpdateInventoryItemDto } from './dto/update-inventory-item.dto';
import { InventoryService } from './inventory.service';

@Controller()
@UseGuards(SupabaseAuthGuard, RolesGuard)
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  /** Global cross-site list for the admin portal's "Inventory / Assets" nav tab - same clientCode/siteId filter convention as AdminFeedbackController/AdminMediaController. */
  @Get('admin/inventory')
  findAllGlobal(@Query() query: FindAllAdminInventoryQueryDto) {
    return this.inventory.findAllGlobal(query.clientCode, query.siteId, query.page, query.pageSize);
  }

  @Post('sites/:siteId/inventory')
  create(@Param('siteId') siteId: string, @Body() dto: CreateInventoryItemDto, @CurrentAdmin() admin: AdminUser) {
    return this.inventory.create(siteId, dto, admin.id);
  }

  @Get('sites/:siteId/inventory')
  findAllForSite(@Param('siteId') siteId: string, @Query() query: FindAllInventoryQueryDto) {
    return this.inventory.findAllForSite(siteId, query.page, query.pageSize);
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
