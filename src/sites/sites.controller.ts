import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, UseGuards } from '@nestjs/common';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { CreateSiteDto } from './dto/create-site.dto';
import { UpdateSiteDto } from './dto/update-site.dto';
import { SitesService } from './sites.service';

@Controller()
@UseGuards(SupabaseAuthGuard)
export class SitesController {
  constructor(private readonly sites: SitesService) {}

  @Post('clients/:clientId/sites')
  create(@Param('clientId') clientId: string, @Body() dto: CreateSiteDto) {
    return this.sites.create(clientId, dto);
  }

  @Get('clients/:clientId/sites')
  findAllForClient(@Param('clientId') clientId: string) {
    return this.sites.findAllForClient(clientId);
  }

  @Get('sites/:id')
  findOne(@Param('id') id: string) {
    return this.sites.findOne(id);
  }

  @Put('sites/:id')
  update(@Param('id') id: string, @Body() dto: UpdateSiteDto) {
    return this.sites.update(id, dto);
  }

  @Delete('sites/:id')
  @HttpCode(204)
  remove(@Param('id') id: string) {
    return this.sites.remove(id);
  }
}
