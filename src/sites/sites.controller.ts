import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { SupabaseAuthGuard } from '../auth/supabase-auth.guard';
import { QrService } from '../qr/qr.service';
import { DownloadQrQueryDto } from './dto/download-qr-query.dto';
import { CreateSiteDto } from './dto/create-site.dto';
import { FindAllSitesQueryDto } from './dto/find-all-sites-query.dto';
import { UpdateSiteDto } from './dto/update-site.dto';
import { SitesService } from './sites.service';

@Controller()
@UseGuards(SupabaseAuthGuard)
export class SitesController {
  constructor(
    private readonly sites: SitesService,
    private readonly qr: QrService,
  ) {}

  @Post('clients/:clientCode/sites')
  create(@Param('clientCode') clientCode: string, @Body() dto: CreateSiteDto) {
    return this.sites.create(clientCode, dto);
  }

  @Get('clients/:clientCode/sites')
  findAllForClient(@Param('clientCode') clientCode: string, @Query() query: FindAllSitesQueryDto) {
    return this.sites.findAllForClient(clientCode, query.page, query.pageSize);
  }

  @Get('sites/:id')
  findOne(@Param('id') id: string) {
    return this.sites.findOne(id);
  }

  @Put('sites/:id')
  update(@Param('id') id: string, @Body() dto: UpdateSiteDto) {
    return this.sites.update(id, dto);
  }

  @Delete('sites/:id')
  @HttpCode(204)
  remove(@Param('id') id: string) {
    return this.sites.remove(id);
  }

  @Get('sites/:id/feedback')
  findFeedback(@Param('id') id: string) {
    return this.sites.findFeedbackForSite(id);
  }

  @Get('sites/:id/qr')
  async downloadQr(@Param('id') id: string, @Query() query: DownloadQrQueryDto, @Req() req: Request, @Res() res: Response) {
    const site = await this.sites.findOneWithClient(id);
    const isPdf = query.format === 'pdf';

    const asset = isPdf
      ? await this.qr.getPdf(
          { slug: site.slug, businessName: site.businessName, clientName: site.client.clientName },
          query.size ?? 'A4',
        )
      : await this.qr.getPng(site.slug);

    res.setHeader('Content-Type', isPdf ? 'application/pdf' : 'image/png');
    res.setHeader('Content-Disposition', `attachment; filename="${site.slug}.${isPdf ? 'pdf' : 'png'}"`);
    res.setHeader('ETag', asset.etag);
    // A site's slug is immutable, so its QR content for a given
    // format/size never changes once generated - safe to let the
    // browser cache indefinitely and just revalidate via ETag instead
    // of re-downloading on every repeat view.
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');

    if (req.headers['if-none-match'] === asset.etag) {
      res.status(304).end();
      return;
    }

    res.send(asset.buffer);
  }
}
