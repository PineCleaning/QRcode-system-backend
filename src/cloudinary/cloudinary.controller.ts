import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { CloudinaryService } from './cloudinary.service';
import { SignatureRequestDto } from './dto/signature-request.dto';

@Controller('uploads')
export class CloudinaryController {
  constructor(private readonly cloudinary: CloudinaryService) {}

  /**
   * Public - no SupabaseAuthGuard. Called from the anonymous public
   * feedback form (Day 4), not just the admin portal, so it can't
   * require an admin session.
   *
   * Rate limited to 10 requests / 10 min per IP. Max 5 attachments per
   * submission means legitimate use is 1-3 calls per session with room
   * for retries - kept tighter than the feedback endpoint itself because
   * each signature is effectively "permission to push a file to
   * Cloudinary," an abuse/cost vector even before a submission happens.
   */
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 600_000 } })
  @Post('cloudinary-signature')
  getSignature(@Body() dto: SignatureRequestDto) {
    return this.cloudinary.generateSignedUploadParams(dto.folder);
  }
}
