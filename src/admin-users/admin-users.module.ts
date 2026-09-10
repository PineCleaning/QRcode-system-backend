import { Module } from '@nestjs/common';
import { AdminUsersCleanupService } from './admin-users-cleanup.service';
import { AdminUsersController } from './admin-users.controller';
import { AdminUsersService } from './admin-users.service';

@Module({
  controllers: [AdminUsersController],
  providers: [AdminUsersService, AdminUsersCleanupService],
  exports: [AdminUsersService],
})
export class AdminUsersModule {}
