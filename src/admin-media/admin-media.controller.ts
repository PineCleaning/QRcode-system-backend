import { Controller, Delete, Get, HttpCode, Param, Query, UseGuards } from '@nestjs/common';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { AdminMediaService } from './admin-media.service';
import { FindAllMediaQueryDto } from './dto/find-all-media-query.dto';

@Controller('admin/media')
@UseGuards(SupabaseAuthGuard)
export class AdminMediaController {
  constructor(private readonly service: AdminMediaService) {}

  @Get()
  findAll(@Query() query: FindAllMediaQueryDto) {
    return this.service.findAll(query.clientCode, query.siteId);
  }

  @Get('storage-usage')
  getStorageUsage() {
    return this.service.getStorageUsage();
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
