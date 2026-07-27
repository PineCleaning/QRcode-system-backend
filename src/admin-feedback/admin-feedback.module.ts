import { Module } from '@nestjs/common';
import { CloudinaryModule } from '../cloudinary/cloudinary.module';
import { AdminFeedbackController } from './admin-feedback.controller';
import { AdminFeedbackService } from './admin-feedback.service';

@Module({
  imports: [CloudinaryModule],
  controllers: [AdminFeedbackController],
  providers: [AdminFeedbackService],
})
export class AdminFeedbackModule {}
