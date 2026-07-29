import { BadRequestException, Controller, Post, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { AdminUser } from '../../generated/prisma/client';
import { CurrentAdmin } from '../auth/current-admin.decorator';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { CsvImportService } from './csv-import.service';

@Controller('clients')
@UseGuards(SupabaseAuthGuard)
export class CsvImportController {
  constructor(private readonly service: CsvImportService) {}

  @Post('bulk-upload')
  @UseInterceptors(FileInterceptor('file'))
  async bulkUpload(@UploadedFile() file: Express.Multer.File, @CurrentAdmin() admin: AdminUser) {
    if (!file) {
      throw new BadRequestException('No file uploaded');
    }
    if (!file.originalname.toLowerCase().endsWith('.csv')) {
      throw new BadRequestException('File must be a .csv file');
    }
    return this.service.processFile(file.buffer, file.originalname, admin.id);
  }
}
