import { Body, Controller, Param, Post } from '@nestjs/common';
import { CreateFeedbackDto } from './dto/create-feedback.dto';
import { FeedbackService } from './feedback.service';

@Controller('feedback')
export class FeedbackController {
  constructor(private readonly feedback: FeedbackService) {}

  /** Public - no SupabaseAuthGuard. This is what the anonymous public feedback form (Day 4) submits to. */
  @Post(':slug')
  submit(@Param('slug') slug: string, @Body() dto: CreateFeedbackDto) {
    return this.feedback.submit(slug, dto);
  }
}
