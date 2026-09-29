import { Controller, Get, NotFoundException, Param, Res } from '@nestjs/common';
import { Response } from 'express';
import { MediaService } from './media.service';

@Controller('media')
export class MediaController {
  constructor(private readonly mediaService: MediaService) {}

  @Get(':id')
  async getById(@Param('id') id: string, @Res() res: Response) {
    const mediaId = Number.parseInt(id, 10);
    if (!Number.isFinite(mediaId) || mediaId <= 0) {
      throw new NotFoundException('Media not found');
    }

    const media = await this.mediaService.getPublicById(mediaId);
    res.setHeader('Content-Type', media.mimeType);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    return res.send(media.file);
  }
}
