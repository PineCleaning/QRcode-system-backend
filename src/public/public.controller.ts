import { Controller, Get, Param } from '@nestjs/common';
import { PublicService } from './public.service';

@Controller('public')
export class PublicController {
  /** Public - no SupabaseAuthGuard. Called by the anonymous public form before it renders. */
  constructor(private readonly publicService: PublicService) {}

  @Get(':slug')
  resolveSlug(@Param('slug') slug: string) {
    return this.publicService.resolveSlug(slug);
  }
}
