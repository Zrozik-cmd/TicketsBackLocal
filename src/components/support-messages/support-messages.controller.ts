import {
  Controller,
  Post,
  UseInterceptors,
  UploadedFiles,
  Body,
  BadRequestException,
} from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { SendSupportMessageDto } from './dto/send-support-message.dto';
import { SupportMessagesService } from './support-messages.service';

type UploadedAttachment = {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
};

const MAX_FILES = 10;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

const ALLOWED_ATTACHMENT_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/svg+xml',
]);

function assertAllowedAttachments(files: UploadedAttachment[] | undefined) {
  for (const file of files ?? []) {
    const mime = (file.mimetype || '').toLowerCase();
    if (!ALLOWED_ATTACHMENT_MIMES.has(mime)) {
      throw new BadRequestException(
        `Unsupported file type: ${mime || 'unknown'}. Allowed: PNG, JPG, SVG`,
      );
    }
  }
}

@Controller('support-messages')
export class SupportMessagesController {
  constructor(private readonly supportMessagesService: SupportMessagesService) {}

  /** Same payload as `send`, but `application/json` (no file uploads). */
  @Post('send-json')
  async sendSupportMessageJson(@Body() dto: SendSupportMessageDto) {
    return this.supportMessagesService.sendToTelegram(dto, undefined);
  }

  /** `multipart/form-data` with optional `attachments` files (field repeated for multiple). */
  @Post('send')
  @UseInterceptors(
    FilesInterceptor('attachments', MAX_FILES, {
      limits: { fileSize: MAX_FILE_BYTES },
    }),
  )
  async sendSupportMessage(
    @Body() dto: SendSupportMessageDto,
    @UploadedFiles() attachments?: UploadedAttachment[],
  ) {
    assertAllowedAttachments(attachments);
    return this.supportMessagesService.sendToTelegram(dto, attachments);
  }
}
