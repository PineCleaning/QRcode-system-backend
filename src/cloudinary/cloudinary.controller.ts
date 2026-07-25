import { Body, Controller, Post } from '@nestjs/common';
import { CloudinaryService } from './cloudinary.service';
import { SignatureRequestDto } from './dto/signature-request.dto';

@Controller('uploads')
export class CloudinaryController {
  constructor(private readonly cloudinary: CloudinaryService) {}

  /**
   * Public - no SupabaseAuthGuard. Called from the anonymous public
   * feedback form (Day 4), not just the admin portal, so it can't
   * require an admin session.
   */
  @Post('cloudinary-signature')
  getSignature(@Body() dto: SignatureRequestDto) {
    return this.cloudinary.generateSignedUploadParams(dto.folder);
  }
}
