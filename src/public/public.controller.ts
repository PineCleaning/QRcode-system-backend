import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { PublicService } from './public.service';

@Controller('public')
export class PublicController {
  /** Public - no SupabaseAuthGuard. Called by the anonymous public form before it renders. */
  constructor(private readonly publicService: PublicService) {}

  /**
   * Rate limited to 30 requests / min per IP. Fires once per scan, but
   * phones on flaky connections retry a form load a few times. No
   * sensitive data returned (just business/site name), so the risk here
   * is load/scraping across slugs, not leakage - 30/min is generous for
   * real retries, tight enough to stop scripted enumeration.
   */
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get(':slug')
  resolveSlug(@Param('slug') slug: string) {
    return this.publicService.resolveSlug(slug);
  }
}
