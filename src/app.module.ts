import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { AdminFeedbackModule } from './admin-feedback/admin-feedback.module';
import { AdminMediaModule } from './admin-media/admin-media.module';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { ClickupModule } from './clickup/clickup.module';
import { ClientsModule } from './clients/clients.module';
import { CloudinaryModule } from './cloudinary/cloudinary.module';
import { CsvImportModule } from './csv-import/csv-import.module';
import { FeedbackModule } from './feedback/feedback.module';
import { HealthController } from './health/health.controller';
import { IntegrationJobsModule } from './integration-jobs/integration-jobs.module';
import { PrismaModule } from './prisma/prisma.module';
import { PublicModule } from './public/public.module';
import { SitesModule } from './sites/sites.module';
import { SupabaseModule } from './supabase/supabase.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    ScheduleModule.forRoot(),
    // Registered here for DI (storage/reflector) only - ThrottlerGuard is
    // NOT applied globally (no APP_GUARD). It's opted into per-route via
    // @UseGuards(ThrottlerGuard) + @Throttle(...) on just the public,
    // unauthenticated endpoints that need it (feedback submission, upload
    // signing, public slug resolution). Admin routes are already behind
    // SupabaseAuthGuard and don't need a second layer here; login isn't a
    // route in this backend at all - Supabase Auth handles it directly.
    // This "default" entry is a fallback that's never actually reached
    // since every throttled route below specifies its own limit/ttl.
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 100 }]),
    PrismaModule,
    SupabaseModule,
    AuthModule,
    ClickupModule,
    ClientsModule,
    SitesModule,
    CloudinaryModule,
    FeedbackModule,
    PublicModule,
    IntegrationJobsModule,
    AdminFeedbackModule,
    AdminMediaModule,
    CsvImportModule,
  ],
  controllers: [AppController, HealthController],
  providers: [AppService],
})
export class AppModule {}
