import { Module } from '@nestjs/common';
import { CsvImportController } from './csv-import.controller';
import { CsvImportService } from './csv-import.service';

@Module({
  controllers: [CsvImportController],
  providers: [CsvImportService],
})
export class CsvImportModule {}
