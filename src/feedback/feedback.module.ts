import { Module } from '@nestjs/common';
import { ClickupModule } from '../clickup/clickup.module';
import { CloudinaryModule } from '../cloudinary/cloudinary.module';
import { IntegrationJobsModule } from '../integration-jobs/integration-jobs.module';
import { FeedbackController } from './feedback.controller';
import { FeedbackService } from './feedback.service';

@Module({
  imports: [ClickupModule, CloudinaryModule, IntegrationJobsModule],
  controllers: [FeedbackController],
  providers: [FeedbackService],
})
export class FeedbackModule {}
