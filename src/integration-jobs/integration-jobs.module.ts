import { Module } from '@nestjs/common';
import { ClickupModule } from '../clickup/clickup.module';
import { IntegrationJobsService } from './integration-jobs.service';
import { RetryWorkerService } from './retry-worker.service';

@Module({
  imports: [ClickupModule],
  providers: [IntegrationJobsService, RetryWorkerService],
  exports: [IntegrationJobsService],
})
export class IntegrationJobsModule {}
