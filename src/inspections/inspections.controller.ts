import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import type { AdminUser } from '../../generated/prisma/client';
import { CurrentAdmin } from '../auth/current-admin.decorator';
import { FlagDto } from '../common/dto/flag.dto';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { CreateInspectionItemDto } from './dto/create-inspection-item.dto';
import { UpdateInspectionItemDto } from './dto/update-inspection-item.dto';
import { InspectionReportService } from './inspection-report.service';
import { InspectionsService } from './inspections.service';

@Controller()
@UseGuards(SupabaseAuthGuard, RolesGuard)
export class InspectionsController {
  constructor(
    private readonly inspections: InspectionsService,
    private readonly reports: InspectionReportService,
  ) {}

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

  /** Week 3 Wed - the last 10 completed sessions for a site, for the "Completed Inspections" list. */
  @Get('sites/:siteId/inspections/completed')
  findCompletedForSite(@Param('siteId') siteId: string) {
    return this.inspections.findCompletedForSite(siteId);
  }

  @Get('inspections/:id')
  findOne(@Param('id') id: string) {
    return this.inspections.findOne(id);
  }

  /** Week 4 Mon - PDF of a completed session, open to both roles like viewing the inspection itself. */
  @Get('inspections/:id/report.pdf')
  async downloadReport(@Param('id') id: string, @Res() res: Response) {
    const buffer = await this.reports.getReportPdf(id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="inspection-report-${id}.pdf"`);
    res.send(buffer);
  }

  /** Open to both roles, same as add/edit item - only delete is Admin-only in this module. */
  @Post('inspections/:id/finish')
  finishInspection(@Param('id') id: string, @CurrentAdmin() admin: AdminUser) {
    return this.inspections.finishInspection(id, admin.id);
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

  /** Every flagged item across every site/client, for the Flagged tab. Must stay above :itemId routes - it's a literal path segment, not a param, but keeping the specific route first avoids any ambiguity. */
  @Get('inspections/items/flagged')
  findFlaggedItems() {
    return this.inspections.findFlaggedItems();
  }

  /** Open to both roles, same as add/edit item - toggles independent of the session's OPEN/COMPLETED status. */
  @Patch('inspections/items/:itemId/flag')
  setItemFlagged(@Param('itemId') itemId: string, @Body() dto: FlagDto) {
    return this.inspections.setItemFlagged(itemId, dto.flagged);
  }

  /** Admin-only, same as the Media page and Inventory delete - matches the app's existing "delete = Admin only" convention. */
  @Delete('inspections/media/:mediaId')
  @Roles('ADMIN')
  @HttpCode(204)
  removeMedia(@Param('mediaId') mediaId: string) {
    return this.inspections.removeMedia(mediaId);
  }
}
