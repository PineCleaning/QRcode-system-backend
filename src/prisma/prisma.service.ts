import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../generated/prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor() {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      // Fail fast with a clear message, matching the getOrThrow() pattern
      // used by every other service's required config (Supabase,
      // Cloudinary, ClickUp) - without this, a missing DATABASE_URL
      // surfaces as a confusing low-level pg connection error instead.
      throw new Error('DATABASE_URL is required but was not set. Check your .env file.');
    }
    super({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  }

  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
