import { Controller, Get, HttpCode, Param, Post, Query, UseGuards } from '@nestjs/common';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { AdminFeedbackService } from './admin-feedback.service';
import { FindAllFeedbackQueryDto } from './dto/find-all-feedback-query.dto';

@Controller('admin/feedback')
@UseGuards(SupabaseAuthGuard)
export class AdminFeedbackController {
  constructor(private readonly service: AdminFeedbackService) {}

  @Get()
  findAll(@Query() query: FindAllFeedbackQueryDto) {
    return this.service.findAll(query.clientId, query.siteId);
  }

  @Post(':id/retry')
  @HttpCode(204)
  retry(@Param('id') id: string) {
    return this.service.retry(id);
  }
}
