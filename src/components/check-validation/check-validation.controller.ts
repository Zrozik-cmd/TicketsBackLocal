import {
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { CustomerGuard, CUSTOMER_ID_KEY } from '../customers/guards/customer.guard';
import { UploadCheckDto } from './dto/upload-check.dto';
import { CheckValidationService } from './check-validation.service';

type UploadedReceipt = {
  buffer: Buffer;
  mimetype: string;
};

@Controller('check-validation')
export class CheckValidationController {
  constructor(private readonly checkValidationService: CheckValidationService) {}

  @Get()
  findAllWithoutFile() {
    return this.checkValidationService.findAllWithoutFile();
  }

  @Get(':id/file')
  async getFileById(@Param('id') idParam: string, @Res() res: Response) {
    const id = Number.parseInt(idParam, 10);
    if (!Number.isFinite(id) || id <= 0) {
      throw new NotFoundException('Check validation not found');
    }
    const { file, mimeType } = await this.checkValidationService.getFileByCheckId(id);
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    return res.send(file);
  }

  @Post('upload')
  @UseGuards(CustomerGuard)
  @UseInterceptors(FileInterceptor('receipt'))
  uploadAndValidate(
    @Req() req: Request,
    @Body() dto: UploadCheckDto,
    @UploadedFile() receipt?: UploadedReceipt,
  ) {
    const customerId = Number((req as any)[CUSTOMER_ID_KEY]);
    return this.checkValidationService.validateAndConfirm({
      orderId: dto.orderId,
      customerId,
      file: receipt,
    });
  }
}
