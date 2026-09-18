import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { FlagDto } from '../common/dto/flag.dto';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { AdminFeedbackService } from './admin-feedback.service';
import { FindAllFeedbackQueryDto } from './dto/find-all-feedback-query.dto';

@Controller('admin/feedback')
@UseGuards(SupabaseAuthGuard, RolesGuard)
export class AdminFeedbackController {
  constructor(private readonly service: AdminFeedbackService) {}

  @Get()
  findAll(@Query() query: FindAllFeedbackQueryDto) {
    return this.service.findAll(query.clientCode, query.siteId, query.page, query.pageSize, query.flagged);
  }

  @Post(':id/retry')
  @HttpCode(204)
  retry(@Param('id') id: string) {
    return this.service.retry(id);
  }

  /** Open to both roles - flagging isn't a delete/user-mgmt/client-mgmt action. */
  @Patch(':id/flag')
  setFlagged(@Param('id') id: string, @Body() dto: FlagDto) {
    return this.service.setFlagged(id, dto.flagged);
  }

  @Delete(':id')
  @Roles('ADMIN')
  @HttpCode(204)
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
