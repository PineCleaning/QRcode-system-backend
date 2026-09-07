import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import type { AdminUser } from '../../generated/prisma/client';
import { CurrentAdmin } from '../auth/current-admin.decorator';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { CreateInspectionItemDto } from './dto/create-inspection-item.dto';
import { UpdateInspectionItemDto } from './dto/update-inspection-item.dto';
import { InspectionsService } from './inspections.service';

@Controller()
@UseGuards(SupabaseAuthGuard, RolesGuard)
export class InspectionsController {
  constructor(private readonly inspections: InspectionsService) {}

  @Post('sites/:siteId/inspections')
  openOrResume(
    @Param('siteId') siteId: string,
    @CurrentAdmin() admin: AdminUser,
  ) {
    return this.inspections.openOrResume(siteId, admin.id);
  }

  @Get('sites/:siteId/inspections')
  findAllForSite(@Param('siteId') siteId: string) {
    return this.inspections.findAllForSite(siteId);
  }

  @Get('inspections/:id')
  findOne(@Param('id') id: string) {
    return this.inspections.findOne(id);
  }

  @Post('inspections/:id/items')
  addItem(
    @Param('id') id: string,
    @Body() dto: CreateInspectionItemDto,
    @CurrentAdmin() admin: AdminUser,
  ) {
    return this.inspections.addItem(id, dto, admin.id);
  }

  @Put('inspections/items/:itemId')
  updateItem(
    @Param('itemId') itemId: string,
    @Body() dto: UpdateInspectionItemDto,
  ) {
    return this.inspections.updateItem(itemId, dto);
  }

  /** Admin-only, same as the Media page and Inventory delete - matches the app's existing "delete = Admin only" convention. */
  @Delete('inspections/media/:mediaId')
  @Roles('ADMIN')
  @HttpCode(204)
  removeMedia(@Param('mediaId') mediaId: string) {
    return this.inspections.removeMedia(mediaId);
  }
}
