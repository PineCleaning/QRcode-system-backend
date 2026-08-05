import { Module } from '@nestjs/common';
import { ClickupModule } from '../clickup/clickup.module';
import { CloudinaryModule } from '../cloudinary/cloudinary.module';
import { IntegrationJobsModule } from '../integration-jobs/integration-jobs.module';
import { AdminFeedbackController } from './admin-feedback.controller';
import { AdminFeedbackService } from './admin-feedback.service';
import { FeedbackReconciliationService } from './feedback-reconciliation.service';

@Module({
  imports: [CloudinaryModule, IntegrationJobsModule, ClickupModule],
  controllers: [AdminFeedbackController],
  providers: [AdminFeedbackService, FeedbackReconciliationService],
})
export class AdminFeedbackModule {}
