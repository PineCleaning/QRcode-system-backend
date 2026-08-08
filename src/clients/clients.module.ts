import { Module } from '@nestjs/common';
import { AdminFeedbackModule } from '../admin-feedback/admin-feedback.module';
import { AuthModule } from '../auth/auth.module';
import { ClientsController } from './clients.controller';
import { ClientsService } from './clients.service';

@Module({
  imports: [AuthModule, AdminFeedbackModule],
  controllers: [ClientsController],
  providers: [ClientsService],
  exports: [ClientsService],
})
export class ClientsModule {}
