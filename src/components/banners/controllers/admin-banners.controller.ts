import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminGuard } from '../../admin/guards/admin.guard';
import { AdminBannersQueryDto } from '../dto/admin-banners-query.dto';
import { CreateBannerDto } from '../dto/create-banner.dto';
import { ReorderBannersDto } from '../dto/reorder-banners.dto';
import { UpdateBannerDto } from '../dto/update-banner.dto';
import { BannersService } from '../services/banners.service';

@Controller('admin/banners')
@UseGuards(AdminGuard)
export class AdminBannersController {
  constructor(private readonly bannersService: BannersService) {}

  @Get()
  list(@Query() query: AdminBannersQueryDto) {
    return this.bannersService.listForAdmin(query);
  }

  @Patch('reorder')
  reorder(@Body() body: ReorderBannersDto) {
    return this.bannersService.reorder(body);
  }

  @Get(':id')
  findById(@Param('id', ParseIntPipe) id: number) {
    return this.bannersService.findByIdForAdmin(id);
  }

  @Post()
  create(@Body() body: CreateBannerDto) {
    return this.bannersService.create(body);
  }

  @Patch(':id')
  update(
    @Param('id', ParseIntPipe) id: number,
    @Body() body: UpdateBannerDto,
  ) {
    return this.bannersService.update(id, body);
  }

  @Delete(':id')
  remove(@Param('id', ParseIntPipe) id: number) {
    return this.bannersService.remove(id);
  }
}
