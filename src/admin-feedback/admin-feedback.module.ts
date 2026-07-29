import { Module } from '@nestjs/common';
import { CloudinaryModule } from '../cloudinary/cloudinary.module';
import { IntegrationJobsModule } from '../integration-jobs/integration-jobs.module';
import { AdminFeedbackController } from './admin-feedback.controller';
import { AdminFeedbackService } from './admin-feedback.service';

@Module({
  imports: [CloudinaryModule, IntegrationJobsModule],
  controllers: [AdminFeedbackController],
  providers: [AdminFeedbackService],
})
export class AdminFeedbackModule {}
