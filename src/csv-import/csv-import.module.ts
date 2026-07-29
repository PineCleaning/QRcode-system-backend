import { Module } from '@nestjs/common';
import { ClickupModule } from '../clickup/clickup.module';
import { CsvImportController } from './csv-import.controller';
import { CsvImportService } from './csv-import.service';

@Module({
  imports: [ClickupModule],
  controllers: [CsvImportController],
  providers: [CsvImportService],
})
export class CsvImportModule {}
