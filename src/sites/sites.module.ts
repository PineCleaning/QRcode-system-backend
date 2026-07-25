import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { QrModule } from '../qr/qr.module';
import { SitesController } from './sites.controller';
import { SitesService } from './sites.service';

@Module({
  imports: [AuthModule, QrModule],
  controllers: [SitesController],
  providers: [SitesService],
  exports: [SitesService],
})
export class SitesModule {}
