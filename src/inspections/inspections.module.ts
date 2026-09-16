import { Module } from '@nestjs/common';
import { CloudinaryModule } from '../cloudinary/cloudinary.module';
import { InspectionReportService } from './inspection-report.service';
import { InspectionsController } from './inspections.controller';
import { InspectionsService } from './inspections.service';

@Module({
  imports: [CloudinaryModule],
  controllers: [InspectionsController],
  providers: [InspectionsService, InspectionReportService],
})
export class InspectionsModule {}
