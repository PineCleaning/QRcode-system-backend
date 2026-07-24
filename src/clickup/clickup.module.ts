import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ClickupApiClient } from './clickup-api.client';
import { ClickupConnectionService } from './clickup-connection.service';
import { ClickupController } from './clickup.controller';
import { ClickupService } from './clickup.service';

@Module({
  imports: [AuthModule],
  controllers: [ClickupController],
  providers: [ClickupApiClient, ClickupConnectionService, ClickupService],
  exports: [ClickupService],
})
export class ClickupModule {}
