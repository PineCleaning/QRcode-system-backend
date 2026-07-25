import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ClickupModule } from '../clickup/clickup.module';
import { ClientsController } from './clients.controller';
import { ClientsService } from './clients.service';

@Module({
  imports: [AuthModule, ClickupModule],
  controllers: [ClientsController],
  providers: [ClientsService],
  exports: [ClientsService],
})
export class ClientsModule {}
