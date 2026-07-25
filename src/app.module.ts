import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './auth/auth.module';
import { ClickupModule } from './clickup/clickup.module';
import { ClientsModule } from './clients/clients.module';
import { CloudinaryModule } from './cloudinary/cloudinary.module';
import { FeedbackModule } from './feedback/feedback.module';
import { HealthController } from './health/health.controller';
import { PrismaModule } from './prisma/prisma.module';
import { PublicModule } from './public/public.module';
import { SitesModule } from './sites/sites.module';
import { SupabaseModule } from './supabase/supabase.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    PrismaModule,
    SupabaseModule,
    AuthModule,
    ClickupModule,
    ClientsModule,
    SitesModule,
    CloudinaryModule,
    FeedbackModule,
    PublicModule,
  ],
  controllers: [AppController, HealthController],
  providers: [AppService],
})
export class AppModule {}
