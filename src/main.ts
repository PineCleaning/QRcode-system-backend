import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // Required for accurate per-IP rate limiting once deployed behind
  // Railway's reverse proxy - without this, every request's req.ip
  // resolves to the proxy itself, not the real client.
  app.getHttpAdapter().getInstance().set('trust proxy', 1);
  app.enableCors({
    origin: ['https://www.cleanfeedbackhub.com.au', 'http://localhost:3001'],
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter());
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
