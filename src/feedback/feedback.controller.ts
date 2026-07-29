import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { CreateFeedbackDto } from './dto/create-feedback.dto';
import { FeedbackService } from './feedback.service';

@Controller('feedback')
export class FeedbackController {
  constructor(private readonly feedback: FeedbackService) {}

  /**
   * Public - no SupabaseAuthGuard. This is what the anonymous public feedback form (Day 4) submits to.
   *
   * Rate limited to 5 submissions / 10 min, keyed by IP+slug (not IP alone) -
   * a real customer submits once, maybe retries once or twice on a bad
   * connection. Keying by slug too means multiple customers sharing one
   * public IP (job-site WiFi/NAT) can't lock each other out just because
   * they scanned the same or a different QR minutes apart.
   */
  @UseGuards(ThrottlerGuard)
  @Throttle({
    default: {
      limit: 5,
      ttl: 600_000,
      getTracker: (req) => `${req.ip}-${req.params.slug}`,
    },
  })
  @Post(':slug')
  submit(@Param('slug') slug: string, @Body() dto: CreateFeedbackDto) {
    return this.feedback.submit(slug, dto);
  }
}
