import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { AdminGuard } from '../../admin/guards/admin.guard';
import {
  AutoTranslateCmsDto,
  CreateCmsAtomicFieldDto,
  CreateCmsFieldDto,
  CreateCmsLocationCardDto,
  CreateCmsPageDto,
  CreateCmsRepeaterItemDto,
  CreateCmsSectionDto,
  ReorderCmsItemsDto,
  UpdateCmsPageDto,
  UpdateCmsSectionDto,
  UploadCmsImageDto,
} from '../dto/cms-v2.dto';
import { CmsV2Service } from '../services/cms-v2.service';

@Controller('admin/content')
@UseGuards(AdminGuard)
export class AdminCmsV2Controller {
  constructor(private readonly cmsService: CmsV2Service) {}

  @Get('pages')
  listPages() {
    return this.cmsService.listPages();
  }

  @Post('pages')
  createPage(@Body() body: CreateCmsPageDto) {
    return this.cmsService.createPage(body);
  }

  @Get('pages/:pageId')
  getPage(@Param('pageId') pageId: string) {
    return this.cmsService.getPage(pageId);
  }

  @Patch('pages/:pageId')
  updatePage(
    @Param('pageId') pageId: string,
    @Body() body: UpdateCmsPageDto,
  ) {
    return this.cmsService.updatePage(pageId, body);
  }

  @Put('pages/:pageId/save')
  savePage(@Param('pageId') pageId: string, @Body() body: Record<string, unknown>) {
    return this.cmsService.savePage(pageId, body);
  }

  @Delete('pages/:pageId')
  deletePage(@Param('pageId') pageId: string) {
    return this.cmsService.deletePage(pageId);
  }

  @Post('pages/:pageId/sections')
  addSection(
    @Param('pageId') pageId: string,
    @Body() body: CreateCmsSectionDto,
  ) {
    return this.cmsService.addSection(pageId, body);
  }

  @Patch('pages/:pageId/sections/reorder')
  reorderSections(
    @Param('pageId') pageId: string,
    @Body() body: ReorderCmsItemsDto,
  ) {
    return this.cmsService.reorderSections(pageId, body.ids);
  }

  @Patch('pages/:pageId/sections/:sectionId')
  updateSection(
    @Param('pageId') pageId: string,
    @Param('sectionId') sectionId: string,
    @Body() body: UpdateCmsSectionDto,
  ) {
    return this.cmsService.updateSection(pageId, sectionId, body);
  }

  @Delete('pages/:pageId/sections/:sectionId')
  deleteSection(
    @Param('pageId') pageId: string,
    @Param('sectionId') sectionId: string,
  ) {
    return this.cmsService.deleteSection(pageId, sectionId);
  }

  @Post('pages/:pageId/sections/:sectionId/duplicate')
  duplicateSection(
    @Param('pageId') pageId: string,
    @Param('sectionId') sectionId: string,
  ) {
    return this.cmsService.duplicateSection(pageId, sectionId);
  }

  @Post('pages/:pageId/sections/:sectionId/fields')
  addSectionField(
    @Param('pageId') pageId: string,
    @Param('sectionId') sectionId: string,
    @Body() body: CreateCmsFieldDto,
  ) {
    return this.cmsService.addSectionField(pageId, sectionId, body.type, {
      ...(body.payload as Record<string, unknown> | undefined),
      id: body.id,
      label: body.label,
    });
  }

  @Patch('pages/:pageId/sections/:sectionId/fields/reorder')
  reorderSectionFields(
    @Param('pageId') pageId: string,
    @Param('sectionId') sectionId: string,
    @Body() body: ReorderCmsItemsDto,
  ) {
    return this.cmsService.reorderSectionFields(pageId, sectionId, body.ids);
  }

  @Patch('pages/:pageId/sections/:sectionId/fields/:fieldId')
  updateSectionField(
    @Param('pageId') pageId: string,
    @Param('sectionId') sectionId: string,
    @Param('fieldId') fieldId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.cmsService.updateSectionField(pageId, sectionId, fieldId, body);
  }

  @Delete('pages/:pageId/sections/:sectionId/fields/:fieldId')
  deleteSectionField(
    @Param('pageId') pageId: string,
    @Param('sectionId') sectionId: string,
    @Param('fieldId') fieldId: string,
  ) {
    return this.cmsService.deleteSectionField(pageId, sectionId, fieldId);
  }

  @Post('pages/:pageId/sections/:sectionId/fields/:fieldId/duplicate')
  duplicateSectionField(
    @Param('pageId') pageId: string,
    @Param('sectionId') sectionId: string,
    @Param('fieldId') fieldId: string,
  ) {
    return this.cmsService.duplicateSectionField(pageId, sectionId, fieldId);
  }

  @Post('pages/:pageId/sections/:sectionId/repeaters/:repeaterId/items')
  addRepeaterItem(
    @Param('pageId') pageId: string,
    @Param('sectionId') sectionId: string,
    @Param('repeaterId') repeaterId: string,
    @Body() body: CreateCmsRepeaterItemDto,
  ) {
    return this.cmsService.addRepeaterItem(pageId, sectionId, repeaterId, body);
  }

  @Post('pages/:pageId/sections/:sectionId/repeaters/:repeaterId/location-cards')
  addLocationCard(
    @Param('pageId') pageId: string,
    @Param('sectionId') sectionId: string,
    @Param('repeaterId') repeaterId: string,
    @Body() body: CreateCmsLocationCardDto,
  ) {
    return this.cmsService.addLocationCard(pageId, sectionId, repeaterId, body);
  }

  @Patch('pages/:pageId/sections/:sectionId/repeaters/:repeaterId/items/reorder')
  reorderRepeaterItems(
    @Param('pageId') pageId: string,
    @Param('sectionId') sectionId: string,
    @Param('repeaterId') repeaterId: string,
    @Body() body: ReorderCmsItemsDto,
  ) {
    return this.cmsService.reorderRepeaterItems(pageId, sectionId, repeaterId, body.ids);
  }

  @Patch('pages/:pageId/sections/:sectionId/repeaters/:repeaterId/items/:itemId')
  updateRepeaterItem(
    @Param('pageId') pageId: string,
    @Param('sectionId') sectionId: string,
    @Param('repeaterId') repeaterId: string,
    @Param('itemId') itemId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.cmsService.updateRepeaterItem(pageId, sectionId, repeaterId, itemId, body);
  }

  @Delete('pages/:pageId/sections/:sectionId/repeaters/:repeaterId/items/:itemId')
  deleteRepeaterItem(
    @Param('pageId') pageId: string,
    @Param('sectionId') sectionId: string,
    @Param('repeaterId') repeaterId: string,
    @Param('itemId') itemId: string,
  ) {
    return this.cmsService.deleteRepeaterItem(pageId, sectionId, repeaterId, itemId);
  }

  @Post('pages/:pageId/sections/:sectionId/repeaters/:repeaterId/items/:itemId/duplicate')
  duplicateRepeaterItem(
    @Param('pageId') pageId: string,
    @Param('sectionId') sectionId: string,
    @Param('repeaterId') repeaterId: string,
    @Param('itemId') itemId: string,
  ) {
    return this.cmsService.duplicateRepeaterItem(pageId, sectionId, repeaterId, itemId);
  }

  @Post('pages/:pageId/sections/:sectionId/repeaters/:repeaterId/template-fields')
  addRepeaterTemplateField(
    @Param('pageId') pageId: string,
    @Param('sectionId') sectionId: string,
    @Param('repeaterId') repeaterId: string,
    @Body() body: CreateCmsAtomicFieldDto,
  ) {
    return this.cmsService.addRepeaterField(pageId, sectionId, repeaterId, 'template', body.type, {
      ...(body.payload as Record<string, unknown> | undefined),
      id: body.id,
      label: body.label,
    });
  }

  @Patch('pages/:pageId/sections/:sectionId/repeaters/:repeaterId/template-fields/reorder')
  reorderRepeaterTemplateFields(
    @Param('pageId') pageId: string,
    @Param('sectionId') sectionId: string,
    @Param('repeaterId') repeaterId: string,
    @Body() body: ReorderCmsItemsDto,
  ) {
    return this.cmsService.reorderRepeaterFields(pageId, sectionId, repeaterId, 'template', body.ids);
  }

  @Patch('pages/:pageId/sections/:sectionId/repeaters/:repeaterId/template-fields/:fieldId')
  updateRepeaterTemplateField(
    @Param('pageId') pageId: string,
    @Param('sectionId') sectionId: string,
    @Param('repeaterId') repeaterId: string,
    @Param('fieldId') fieldId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.cmsService.updateRepeaterField(pageId, sectionId, repeaterId, 'template', fieldId, body);
  }

  @Delete('pages/:pageId/sections/:sectionId/repeaters/:repeaterId/template-fields/:fieldId')
  deleteRepeaterTemplateField(
    @Param('pageId') pageId: string,
    @Param('sectionId') sectionId: string,
    @Param('repeaterId') repeaterId: string,
    @Param('fieldId') fieldId: string,
  ) {
    return this.cmsService.deleteRepeaterField(pageId, sectionId, repeaterId, 'template', fieldId);
  }

  @Post('pages/:pageId/sections/:sectionId/repeaters/:repeaterId/items/:itemId/fields')
  addRepeaterItemField(
    @Param('pageId') pageId: string,
    @Param('sectionId') sectionId: string,
    @Param('repeaterId') repeaterId: string,
    @Param('itemId') itemId: string,
    @Body() body: CreateCmsAtomicFieldDto,
  ) {
    return this.cmsService.addRepeaterField(pageId, sectionId, repeaterId, 'item', body.type, {
      ...(body.payload as Record<string, unknown> | undefined),
      id: body.id,
      label: body.label,
    }, itemId);
  }

  @Patch('pages/:pageId/sections/:sectionId/repeaters/:repeaterId/items/:itemId/fields/reorder')
  reorderRepeaterItemFields(
    @Param('pageId') pageId: string,
    @Param('sectionId') sectionId: string,
    @Param('repeaterId') repeaterId: string,
    @Param('itemId') itemId: string,
    @Body() body: ReorderCmsItemsDto,
  ) {
    return this.cmsService.reorderRepeaterFields(pageId, sectionId, repeaterId, 'item', body.ids, itemId);
  }

  @Patch('pages/:pageId/sections/:sectionId/repeaters/:repeaterId/items/:itemId/fields/:fieldId')
  updateRepeaterItemField(
    @Param('pageId') pageId: string,
    @Param('sectionId') sectionId: string,
    @Param('repeaterId') repeaterId: string,
    @Param('itemId') itemId: string,
    @Param('fieldId') fieldId: string,
    @Body() body: Record<string, unknown>,
  ) {
    return this.cmsService.updateRepeaterField(pageId, sectionId, repeaterId, 'item', fieldId, body, itemId);
  }

  @Delete('pages/:pageId/sections/:sectionId/repeaters/:repeaterId/items/:itemId/fields/:fieldId')
  deleteRepeaterItemField(
    @Param('pageId') pageId: string,
    @Param('sectionId') sectionId: string,
    @Param('repeaterId') repeaterId: string,
    @Param('itemId') itemId: string,
    @Param('fieldId') fieldId: string,
  ) {
    return this.cmsService.deleteRepeaterField(pageId, sectionId, repeaterId, 'item', fieldId, itemId);
  }

  @Post('media/image')
  uploadImage(@Body() body: UploadCmsImageDto) {
    return this.cmsService.uploadImage(body);
  }

  @Post('auto-translate')
  autoTranslate(@Body() body: AutoTranslateCmsDto) {
    return this.cmsService.autoTranslateStub(body);
  }
}
