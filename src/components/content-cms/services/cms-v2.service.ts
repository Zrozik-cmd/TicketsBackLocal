import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import mongoose from 'mongoose';
import { MediaService } from '../../media/media.service';
import {
  buildDefaultLocationCardFields,
  isLocationImageFieldId,
  isLocationRepeaterId,
  LOCATION_CARD_SHOW_CARD_KEY,
  LOCATION_CARD_SIGNATURE_FIELD_IDS,
  LOCATION_CARD_UNIQUE_ID_KEY,
} from '../constants/location-card.constants';
import {
  CmsPageSchema,
  ICmsPage,
  toCmsContentPage,
} from '../schemas/cms-page.schema';
import {
  CMS_ATOMIC_FIELD_TYPES,
  CMS_FIELD_TYPES,
  CMS_LOCALES,
  type CmsAtomicField,
  type CmsAtomicFieldType,
  type CmsButtonTarget,
  type CmsContentField,
  type CmsContentPage,
  type CmsContentSection,
  type CmsFieldType,
  type CmsLinkTarget,
  type CmsLocale,
  type CmsLocalizedString,
  type CmsPageListItem,
  type CmsPublicAtomicField,
  type CmsPublicField,
  type CmsPublicPage,
  type CmsPublicRepeaterField,
  type CmsPublicRepeaterItem,
  type CmsPublicSection,
  type CmsPublicationStatus,
  type CmsRepeaterField,
  type CmsRepeaterItem,
  type CmsSelectField,
  type CmsSelectOption,
} from '../types/cms.types';

const CMS_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;
const PLATFORM_MEDIA_USER_ID = 0;

type RepeaterFieldTarget = 'template' | 'item';

@Injectable()
export class CmsV2Service {
  constructor(private readonly mediaService: MediaService) {}

  private get pageModel(): mongoose.Model<ICmsPage> {
    return (
      (mongoose.models.ContentCmsPage as mongoose.Model<ICmsPage>) ??
      mongoose.model<ICmsPage>('ContentCmsPage', CmsPageSchema)
    );
  }

  private localized(value?: Partial<CmsLocalizedString> | unknown): CmsLocalizedString {
    const raw = value && typeof value === 'object'
      ? (value as Partial<Record<CmsLocale, unknown>>)
      : {};
    return {
      en: typeof raw.en === 'string' ? raw.en : '',
      ru: typeof raw.ru === 'string' ? raw.ru : '',
      th: typeof raw.th === 'string' ? raw.th : '',
    };
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  }

  private stringValue(value: unknown, fallback = ''): string {
    return typeof value === 'string' ? value : fallback;
  }

  private booleanValue(value: unknown, fallback = false): boolean {
    return typeof value === 'boolean' ? value : fallback;
  }

  private arrayValue(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
  }

  private assertId(value: string, scope: string): void {
    if (!value.trim()) {
      throw new BadRequestException(`${scope} id is required`);
    }
    if (!CMS_ID_RE.test(value)) {
      throw new BadRequestException(
        `${scope} id must match ${CMS_ID_RE.toString()}`,
      );
    }
  }

  private assertUniqueIds(items: { id: string }[], scope: string): void {
    const seen = new Set<string>();
    for (const item of items) {
      this.assertId(item.id, scope);
      if (seen.has(item.id)) {
        throw new BadRequestException(`${scope} id "${item.id}" is duplicated`);
      }
      seen.add(item.id);
    }
  }

  private async assertPageIdAvailable(id: string, currentMongoId?: string): Promise<void> {
    const existing = await this.pageModel.findOne({ id }).select({ _id: 1 }).lean().exec();
    if (existing && String(existing._id) !== currentMongoId) {
      throw new BadRequestException(`Page id "${id}" already exists`);
    }
  }

  private async assertPublishedSlugAvailable(
    slug: string | undefined,
    currentMongoId?: string,
  ): Promise<void> {
    if (!slug?.trim()) {
      return;
    }
    const existing = await this.pageModel
      .findOne({ slug, publication: 'published' })
      .select({ _id: 1 })
      .lean()
      .exec();
    if (existing && String(existing._id) !== currentMongoId) {
      throw new BadRequestException(`Published slug "${slug}" already exists`);
    }
  }

  private makeUniqueId(base: string, siblings: { id: string }[]): string {
    const used = new Set(siblings.map((item) => item.id));
    if (!used.has(base)) {
      return base;
    }

    let index = 2;
    while (used.has(`${base}-${index}`)) {
      index += 1;
    }
    return `${base}-${index}`;
  }

  private copyId(baseId: string, siblings: { id: string }[]): string {
    return this.makeUniqueId(`${baseId}-copy`, siblings);
  }

  private fieldBaseId(type: CmsFieldType): string {
    if (type === 'richText') {
      return 'rich-text';
    }
    if (type === 'boolean') {
      return 'switch';
    }
    if (type === 'repeater') {
      return 'cards';
    }
    return type;
  }

  private fieldLabel(type: CmsFieldType): string {
    const labels: Record<CmsFieldType, string> = {
      text: 'Text',
      textarea: 'Textarea',
      richText: 'Description',
      button: 'Button',
      link: 'Link',
      image: 'Image',
      number: 'Number',
      boolean: 'Switch',
      select: 'Select',
      repeater: 'Cards array',
    };
    return labels[type];
  }

  private cloneAtomicField(field: CmsAtomicField): CmsAtomicField {
    return JSON.parse(JSON.stringify(field)) as CmsAtomicField;
  }

  private normalizeAtomicField(
    input: unknown,
    fallbackType?: CmsAtomicFieldType,
    siblings: { id: string }[] = [],
  ): CmsAtomicField {
    const raw = this.asRecord(input);
    const rawType = this.stringValue(raw.type, fallbackType);
    const type = CMS_ATOMIC_FIELD_TYPES.includes(rawType as CmsAtomicFieldType)
      ? (rawType as CmsAtomicFieldType)
      : fallbackType;
    if (!type) {
      throw new BadRequestException('Atomic field type is required');
    }

    const id = this.stringValue(raw.id, this.makeUniqueId(this.fieldBaseId(type), siblings));
    const label = this.stringValue(raw.label, this.fieldLabel(type));
    const base = { id, type, label };

    if (type === 'text' || type === 'textarea' || type === 'richText') {
      return { ...base, type, value: this.localized(raw.value) };
    }
    if (type === 'button') {
      const target = raw.target === '_self' || raw.target === '_blank' || raw.target === 'auto'
        ? (raw.target as CmsButtonTarget)
        : 'auto';
      return {
        ...base,
        type,
        text: this.localized(raw.text ?? { en: 'Button text' }),
        url: this.localized(raw.url),
        target,
      };
    }
    if (type === 'link') {
      const target = raw.target === '_self' || raw.target === '_blank'
        ? (raw.target as CmsLinkTarget)
        : '_blank';
      return {
        ...base,
        type,
        text: this.localized(raw.text ?? { en: 'Link text' }),
        url: this.localized(raw.url),
        target,
      };
    }
    if (type === 'image') {
      return {
        ...base,
        type,
        imageUrl: this.stringValue(raw.imageUrl),
        fileName: this.stringValue(raw.fileName),
        alt: this.localized(raw.alt),
      };
    }
    if (type === 'number') {
      return { ...base, type, value: this.stringValue(raw.value) };
    }
    if (type === 'boolean') {
      return { ...base, type, value: this.booleanValue(raw.value) };
    }

    const optionsRaw = this.arrayValue(raw.options);
    const options = optionsRaw.length
      ? optionsRaw.map((option, index) => this.normalizeSelectOption(option, index))
      : [
          {
            id: 'option-1',
            label: this.localized({ en: 'Option 1' }),
            value: 'option-1',
          },
        ];
    this.assertUniqueIds(options, `${id}.options`);
    const values = new Set(options.map((option) => option.value));
    const value = this.stringValue(raw.value, options[0].value);
    return {
      ...base,
      type: 'select',
      value: values.has(value) ? value : options[0].value,
      options,
    };
  }

  private normalizeSelectOption(input: unknown, index: number): CmsSelectOption {
    const raw = this.asRecord(input);
    const id = this.stringValue(raw.id, `option-${index + 1}`);
    return {
      id,
      label: this.localized(raw.label ?? { en: `Option ${index + 1}` }),
      value: this.stringValue(raw.value, id),
    };
  }

  private normalizeField(
    input: unknown,
    fallbackType?: CmsFieldType,
    siblings: { id: string }[] = [],
  ): CmsContentField {
    const raw = this.asRecord(input);
    const rawType = this.stringValue(raw.type, fallbackType);
    const type = CMS_FIELD_TYPES.includes(rawType as CmsFieldType)
      ? (rawType as CmsFieldType)
      : fallbackType;
    if (!type) {
      throw new BadRequestException('Field type is required');
    }

    if (type !== 'repeater') {
      return this.normalizeAtomicField(raw, type, siblings);
    }

    const id = this.stringValue(raw.id, this.makeUniqueId('cards', siblings));
    const itemFields = this.arrayValue(raw.itemFields).map((field, index, fields) =>
      this.normalizeAtomicField(field, undefined, fields.slice(0, index) as { id: string }[]),
    );
    const items = this.arrayValue(raw.items).map((item, index) =>
      this.normalizeRepeaterItem(item, index, itemFields),
    );
    const repeater: CmsRepeaterField = {
      id,
      type,
      label: this.stringValue(raw.label, 'Cards array'),
      itemFields,
      items,
    };
    if (isLocationRepeaterId(repeater.id)) {
      this.ensureLocationRepeaterUniqueIds(repeater);
    }
    return repeater;
  }

  private normalizeRepeaterItem(
    input: unknown,
    index: number,
    templateFields: CmsAtomicField[] = [],
  ): CmsRepeaterItem {
    const raw = this.asRecord(input);
    const defaultFields = templateFields.map((field) => this.cloneAtomicField(field));
    const fieldsRaw = raw.fields === undefined ? defaultFields : this.arrayValue(raw.fields);
    const fields = fieldsRaw.map((field, fieldIndex, allFields) =>
      this.normalizeAtomicField(field, undefined, allFields.slice(0, fieldIndex) as { id: string }[]),
    );
    return {
      id: this.stringValue(raw.id, `item-${index + 1}`),
      unique_id: this.stringValue(raw[LOCATION_CARD_UNIQUE_ID_KEY]),
      showCard: this.booleanValue(raw[LOCATION_CARD_SHOW_CARD_KEY], true),
      title: this.stringValue(raw.title, `Card ${index + 1}`),
      fields,
    };
  }

  private makeLocationCardUniqueId(): string {
    return randomUUID();
  }

  private withLocationCardUniqueId(item: CmsRepeaterItem, value?: string): CmsRepeaterItem {
    return {
      ...item,
      unique_id: value?.trim() || this.makeLocationCardUniqueId(),
    };
  }

  private ensureLocationRepeaterUniqueIds(repeater: CmsRepeaterField): void {
    const used = new Set<string>();
    repeater.items = repeater.items.map((item) => {
      let uniqueId = item.unique_id?.trim();
      if (!uniqueId || used.has(uniqueId)) {
        uniqueId = this.makeLocationCardUniqueId();
      }
      used.add(uniqueId);
      return {
        ...item,
        unique_id: uniqueId,
        showCard: typeof item.showCard === 'boolean' ? item.showCard : true,
      };
    });
  }

  private ensurePageLocationCardUniqueIds(page: CmsContentPage): void {
    for (const section of page.sections) {
      for (const field of section.fields) {
        if (field.type === 'repeater' && isLocationRepeaterId(field.id)) {
          this.ensureLocationRepeaterUniqueIds(field);
        }
      }
    }
  }

  private normalizeSection(
    input: unknown,
    index: number,
    siblings: { id: string }[] = [],
  ): CmsContentSection {
    const raw = this.asRecord(input);
    const id = this.stringValue(
      raw.id,
      this.makeUniqueId(index === 0 ? 'new-section' : `new-section-${index + 1}`, siblings),
    );
    const fields = this.arrayValue(raw.fields).map((field, fieldIndex, allFields) =>
      this.normalizeField(field, undefined, allFields.slice(0, fieldIndex) as { id: string }[]),
    );
    return {
      id,
      name: this.stringValue(raw.name, 'New section'),
      visible: this.booleanValue(raw.visible, true),
      fields,
    };
  }

  private normalizePage(input: unknown, existing?: ICmsPage): CmsContentPage {
    const raw = this.asRecord(input);
    const oldId = existing?.id;
    const id = this.stringValue(raw.id, existing?.id ?? 'new-page');
    const slugInput = raw.slug;
    const slug =
      typeof slugInput === 'string'
        ? slugInput
        : existing && oldId && existing.slug === oldId && id !== oldId
          ? id
          : existing?.slug ?? id;
    const publication =
      raw.publication === 'published' || raw.publication === 'draft'
        ? (raw.publication as CmsPublicationStatus)
        : existing?.publication ?? 'draft';
    const sectionsSource = raw.sections === undefined ? existing?.sections : raw.sections;
    const sections = this.arrayValue(sectionsSource).map((section, index, sectionsRaw) =>
      this.normalizeSection(section, index, sectionsRaw.slice(0, index) as { id: string }[]),
    );
    return {
      id,
      name: this.stringValue(raw.name, existing?.name ?? 'New page'),
      slug,
      publication,
      sections,
    };
  }

  private validateAtomicFields(fields: CmsAtomicField[], scope: string): void {
    this.assertUniqueIds(fields, scope);
    for (const field of fields) {
      if (field.type === 'select') {
        if (!field.options.length) {
          throw new BadRequestException(`${scope}.${field.id} requires at least one option`);
        }
        this.assertUniqueIds(field.options, `${scope}.${field.id}.options`);
        for (const option of field.options) {
          if (!option.value.trim()) {
            throw new BadRequestException(`${scope}.${field.id}.${option.id} value is required`);
          }
        }
      }
    }
  }

  private validateFields(fields: CmsContentField[], scope: string): void {
    this.assertUniqueIds(fields, scope);
    for (const field of fields) {
      if (field.type === 'repeater') {
        this.validateAtomicFields(field.itemFields, `${scope}.${field.id}.itemFields`);
        this.assertUniqueIds(field.items, `${scope}.${field.id}.items`);
        for (const item of field.items) {
          this.validateAtomicFields(item.fields, `${scope}.${field.id}.${item.id}.fields`);
        }
      } else {
        this.validateAtomicFields([field], scope);
      }
    }
  }

  private validatePage(page: CmsContentPage): void {
    this.assertId(page.id, 'page');
    if (page.publication !== 'draft' && page.publication !== 'published') {
      throw new BadRequestException('publication must be draft or published');
    }
    this.assertUniqueIds(page.sections, 'sections');
    for (const section of page.sections) {
      this.validateFields(section.fields, `${section.id}.fields`);
    }
  }

  private async persistPage(page: CmsContentPage, existing?: ICmsPage): Promise<CmsContentPage> {
    this.ensurePageLocationCardUniqueIds(page);
    this.validatePage(page);
    const currentMongoId = existing ? String(existing._id) : undefined;
    await this.assertPageIdAvailable(page.id, currentMongoId);
    if (page.publication === 'published') {
      await this.assertPublishedSlugAvailable(page.slug, currentMongoId);
    }

    if (existing) {
      existing.id = page.id;
      existing.name = page.name;
      existing.slug = page.slug;
      existing.publication = page.publication;
      existing.sections = page.sections;
      await existing.save();
      return toCmsContentPage(existing);
    }

    const created = await this.pageModel.create(page);
    return toCmsContentPage(created);
  }

  async listPages(): Promise<CmsPageListItem[]> {
    const pages = await this.pageModel
      .find()
      .select({ id: 1, name: 1, publication: 1, slug: 1 })
      .sort({ createdAt: 1 })
      .lean()
      .exec();
    return pages.map((page) => ({
      id: page.id,
      name: page.name ?? '',
      slug: page.slug ?? '',
      publication: page.publication,
    }));
  }

  async createPage(dto: unknown): Promise<CmsContentPage> {
    const raw = this.asRecord(dto);
    const existingPages = await this.pageModel.find().select({ id: 1 }).lean().exec();
    const defaultId = this.makeUniqueId('new-page', existingPages);
    const page = this.normalizePage({
      id: raw.id ?? defaultId,
      name: raw.name ?? 'New page',
      slug: raw.slug ?? raw.id ?? defaultId,
      publication: raw.publication ?? 'draft',
      sections: raw.sections ?? [],
    });
    return this.persistPage(page);
  }

  async getPage(pageId: string): Promise<CmsContentPage> {
    const page = await this.pageModel.findOne({ id: pageId }).exec();
    if (!page) {
      throw new NotFoundException('Content page not found');
    }
    return toCmsContentPage(page);
  }

  private async getPageDocument(pageId: string): Promise<ICmsPage> {
    const page = await this.pageModel.findOne({ id: pageId }).exec();
    if (!page) {
      throw new NotFoundException('Content page not found');
    }
    return page;
  }

  async updatePage(pageId: string, dto: unknown): Promise<CmsContentPage> {
    const existing = await this.getPageDocument(pageId);
    const page = this.normalizePage(dto, existing);
    return this.persistPage(page, existing);
  }

  async savePage(pageId: string, dto: unknown): Promise<CmsContentPage> {
    const existing = await this.getPageDocument(pageId);
    const page = this.normalizePage({ ...this.asRecord(dto), id: this.asRecord(dto).id ?? pageId }, existing);
    return this.persistPage(page, existing);
  }

  async deletePage(pageId: string): Promise<void> {
    const result = await this.pageModel.deleteOne({ id: pageId }).exec();
    if (!result.deletedCount) {
      throw new NotFoundException('Content page not found');
    }
  }

  async addSection(pageId: string, dto: unknown): Promise<CmsContentPage> {
    const page = await this.getPageDocument(pageId);
    const current = toCmsContentPage(page);
    const section = this.normalizeSection(
      { name: 'New section', visible: true, fields: [], ...this.asRecord(dto) },
      current.sections.length,
      current.sections,
    );
    current.sections.push(section);
    return this.persistPage(current, page);
  }

  async updateSection(pageId: string, sectionId: string, dto: unknown): Promise<CmsContentPage> {
    const page = await this.getPageDocument(pageId);
    const current = toCmsContentPage(page);
    const index = current.sections.findIndex((section) => section.id === sectionId);
    if (index < 0) {
      throw new NotFoundException('Content section not found');
    }
    current.sections[index] = this.normalizeSection(
      { ...current.sections[index], ...this.asRecord(dto) },
      index,
      current.sections.filter((_, itemIndex) => itemIndex !== index),
    );
    return this.persistPage(current, page);
  }

  async deleteSection(pageId: string, sectionId: string): Promise<CmsContentPage> {
    const page = await this.getPageDocument(pageId);
    const current = toCmsContentPage(page);
    const nextSections = current.sections.filter((section) => section.id !== sectionId);
    if (nextSections.length === current.sections.length) {
      throw new NotFoundException('Content section not found');
    }
    current.sections = nextSections;
    return this.persistPage(current, page);
  }

  async duplicateSection(pageId: string, sectionId: string): Promise<CmsContentPage> {
    const page = await this.getPageDocument(pageId);
    const current = toCmsContentPage(page);
    const index = current.sections.findIndex((section) => section.id === sectionId);
    if (index < 0) {
      throw new NotFoundException('Content section not found');
    }
    const copy = JSON.parse(JSON.stringify(current.sections[index])) as CmsContentSection;
    copy.id = this.copyId(copy.id, current.sections);
    copy.name = `${copy.name ?? copy.id} copy`;
    current.sections.splice(index + 1, 0, copy);
    return this.persistPage(current, page);
  }

  async reorderSections(pageId: string, ids: string[]): Promise<CmsContentPage> {
    const page = await this.getPageDocument(pageId);
    const current = toCmsContentPage(page);
    current.sections = this.reorderByIds(current.sections, ids, 'sections');
    return this.persistPage(current, page);
  }

  private reorderByIds<T extends { id: string }>(items: T[], ids: string[], scope: string): T[] {
    if (items.length !== ids.length) {
      throw new BadRequestException(`${scope} reorder ids must include every item`);
    }
    const byId = new Map(items.map((item) => [item.id, item]));
    const reordered = ids.map((id) => {
      const item = byId.get(id);
      if (!item) {
        throw new BadRequestException(`${scope} reorder contains unknown id "${id}"`);
      }
      return item;
    });
    this.assertUniqueIds(reordered, scope);
    return reordered;
  }

  private findSection(page: CmsContentPage, sectionId: string): CmsContentSection {
    const section = page.sections.find((item) => item.id === sectionId);
    if (!section) {
      throw new NotFoundException('Content section not found');
    }
    return section;
  }

  private findRepeater(section: CmsContentSection, repeaterId: string): CmsRepeaterField {
    const field = section.fields.find((item) => item.id === repeaterId);
    if (!field || field.type !== 'repeater') {
      throw new NotFoundException('Repeater field not found');
    }
    return field;
  }

  private findRepeaterItem(repeater: CmsRepeaterField, itemId: string): CmsRepeaterItem {
    const item = repeater.items.find((entry) => entry.id === itemId);
    if (!item) {
      throw new NotFoundException('Repeater item not found');
    }
    return item;
  }

  async addSectionField(
    pageId: string,
    sectionId: string,
    type: CmsFieldType,
    dto: unknown,
  ): Promise<CmsContentPage> {
    const page = await this.getPageDocument(pageId);
    const current = toCmsContentPage(page);
    const section = this.findSection(current, sectionId);
    section.fields.push(this.normalizeField({ ...this.asRecord(dto), type }, type, section.fields));
    return this.persistPage(current, page);
  }

  async updateSectionField(
    pageId: string,
    sectionId: string,
    fieldId: string,
    dto: unknown,
  ): Promise<CmsContentPage> {
    const page = await this.getPageDocument(pageId);
    const current = toCmsContentPage(page);
    const section = this.findSection(current, sectionId);
    const index = section.fields.findIndex((field) => field.id === fieldId);
    if (index < 0) {
      throw new NotFoundException('Content field not found');
    }
    const type = section.fields[index].type;
    section.fields[index] = this.normalizeField(
      { ...section.fields[index], ...this.asRecord(dto), type: this.asRecord(dto).type ?? type },
      type,
      section.fields.filter((_, itemIndex) => itemIndex !== index),
    );
    return this.persistPage(current, page);
  }

  async deleteSectionField(pageId: string, sectionId: string, fieldId: string): Promise<CmsContentPage> {
    const page = await this.getPageDocument(pageId);
    const current = toCmsContentPage(page);
    const section = this.findSection(current, sectionId);
    const nextFields = section.fields.filter((field) => field.id !== fieldId);
    if (nextFields.length === section.fields.length) {
      throw new NotFoundException('Content field not found');
    }
    section.fields = nextFields;
    return this.persistPage(current, page);
  }

  async duplicateSectionField(pageId: string, sectionId: string, fieldId: string): Promise<CmsContentPage> {
    const page = await this.getPageDocument(pageId);
    const current = toCmsContentPage(page);
    const section = this.findSection(current, sectionId);
    const index = section.fields.findIndex((field) => field.id === fieldId);
    if (index < 0) {
      throw new NotFoundException('Content field not found');
    }
    const copy = JSON.parse(JSON.stringify(section.fields[index])) as CmsContentField;
    copy.id = this.copyId(copy.id, section.fields);
    if (copy.type === 'repeater') {
      copy.items = copy.items.map((item, itemIndex) => ({
        ...item,
        id: this.makeUniqueId(`${item.id}-copy`, copy.items.slice(0, itemIndex)),
      }));
    }
    section.fields.splice(index + 1, 0, copy);
    return this.persistPage(current, page);
  }

  async reorderSectionFields(pageId: string, sectionId: string, ids: string[]): Promise<CmsContentPage> {
    const page = await this.getPageDocument(pageId);
    const current = toCmsContentPage(page);
    const section = this.findSection(current, sectionId);
    section.fields = this.reorderByIds(section.fields, ids, `${sectionId}.fields`);
    return this.persistPage(current, page);
  }

  async addRepeaterItem(pageId: string, sectionId: string, repeaterId: string, dto: unknown): Promise<CmsContentPage> {
    const page = await this.getPageDocument(pageId);
    const current = toCmsContentPage(page);
    const repeater = this.findRepeater(this.findSection(current, sectionId), repeaterId);
    const raw = this.asRecord(dto);
    const id = this.stringValue(raw.id, this.makeUniqueId('item', repeater.items));
    let item = this.normalizeRepeaterItem({ ...raw, id }, repeater.items.length, repeater.itemFields);
    if (isLocationRepeaterId(repeater.id)) {
      item = this.withLocationCardUniqueId(item);
    }
    repeater.items.push(item);
    return this.persistPage(current, page);
  }

  /**
   * Creates a location card inside a locations* repeater.
   * Does not alter generic addRepeaterItem behavior.
   */
  async addLocationCard(
    pageId: string,
    sectionId: string,
    repeaterId: string,
    dto: unknown,
  ): Promise<CmsContentPage> {
    const page = await this.getPageDocument(pageId);
    const current = toCmsContentPage(page);
    const repeater = this.findRepeater(this.findSection(current, sectionId), repeaterId);
    this.assertLocationRepeater(repeater);

    if (repeater.itemFields.length === 0) {
      repeater.itemFields = buildDefaultLocationCardFields().map((field) =>
        this.cloneAtomicField(field),
      );
    }

    const raw = this.asRecord(dto);
    const id = this.stringValue(raw.id, this.makeUniqueId('card', repeater.items));
    const title = this.stringValue(raw.title, `Card ${repeater.items.length + 1}`);
    const fields = this.mergeLocationCardFields(raw.fields);

    this.assertLocationCardSignature(fields);
    this.assertUniqueIds(fields, `${repeaterId}.${id}.fields`);

    const showCard = this.booleanValue(raw[LOCATION_CARD_SHOW_CARD_KEY], true);
    repeater.items.push(
      this.withLocationCardUniqueId(this.normalizeRepeaterItem(
        { id, title, showCard, fields },
        repeater.items.length,
        repeater.itemFields,
      )),
    );
    return this.persistPage(current, page);
  }

  private assertLocationRepeater(repeater: CmsRepeaterField): void {
    if (!isLocationRepeaterId(repeater.id)) {
      throw new BadRequestException(
        `Repeater "${repeater.id}" is not a location template (id must be "locations" or "locations-*")`,
      );
    }
  }

  private assertLocationCardSignature(fields: CmsAtomicField[]): void {
    const ids = new Set(fields.map((field) => field.id));
    for (const requiredId of LOCATION_CARD_SIGNATURE_FIELD_IDS) {
      if (!ids.has(requiredId)) {
        throw new BadRequestException(
          `Location card must include field "${requiredId}"`,
        );
      }
    }
  }

  private mergeLocationCardFields(input: unknown): CmsAtomicField[] {
    const defaults = buildDefaultLocationCardFields();
    const provided = this.arrayValue(input).map((field, index, all) =>
      this.normalizeAtomicField(field, undefined, all.slice(0, index) as { id: string }[]),
    );
    const byId = new Map(provided.map((field) => [field.id, field]));

    const merged = defaults.map((field) => {
      const override = byId.get(field.id);
      byId.delete(field.id);
      return override ? override : this.cloneAtomicField(field);
    });

    for (const field of byId.values()) {
      if (!isLocationImageFieldId(field.id)) {
        throw new BadRequestException(
          `Unknown location card field "${field.id}". Only template fields and imageUrl|imageStorage|imageAlt[-N] are allowed`,
        );
      }
      merged.push(field);
    }

    return merged;
  }

  async updateRepeaterItem(
    pageId: string,
    sectionId: string,
    repeaterId: string,
    itemId: string,
    dto: unknown,
  ): Promise<CmsContentPage> {
    const page = await this.getPageDocument(pageId);
    const current = toCmsContentPage(page);
    const repeater = this.findRepeater(this.findSection(current, sectionId), repeaterId);
    const index = repeater.items.findIndex((item) => item.id === itemId);
    if (index < 0) {
      throw new NotFoundException('Repeater item not found');
    }
    const existingItem = repeater.items[index];
    const raw = this.asRecord(dto);
    delete raw[LOCATION_CARD_UNIQUE_ID_KEY];
    let nextItem = this.normalizeRepeaterItem(
      { ...existingItem, ...raw },
      index,
      repeater.itemFields,
    );
    if (isLocationRepeaterId(repeater.id)) {
      nextItem = this.withLocationCardUniqueId(nextItem, existingItem.unique_id);
    }
    repeater.items[index] = nextItem;
    return this.persistPage(current, page);
  }

  async deleteRepeaterItem(pageId: string, sectionId: string, repeaterId: string, itemId: string): Promise<CmsContentPage> {
    const page = await this.getPageDocument(pageId);
    const current = toCmsContentPage(page);
    const repeater = this.findRepeater(this.findSection(current, sectionId), repeaterId);
    const nextItems = repeater.items.filter((item) => item.id !== itemId);
    if (nextItems.length === repeater.items.length) {
      throw new NotFoundException('Repeater item not found');
    }
    repeater.items = nextItems;
    return this.persistPage(current, page);
  }

  async duplicateRepeaterItem(pageId: string, sectionId: string, repeaterId: string, itemId: string): Promise<CmsContentPage> {
    const page = await this.getPageDocument(pageId);
    const current = toCmsContentPage(page);
    const repeater = this.findRepeater(this.findSection(current, sectionId), repeaterId);
    const index = repeater.items.findIndex((item) => item.id === itemId);
    if (index < 0) {
      throw new NotFoundException('Repeater item not found');
    }
    const copy = JSON.parse(JSON.stringify(repeater.items[index])) as CmsRepeaterItem;
    copy.id = this.copyId(copy.id, repeater.items);
    copy.title = `${copy.title ?? copy.id} copy`;
    if (isLocationRepeaterId(repeater.id)) {
      copy.unique_id = this.makeLocationCardUniqueId();
    }
    repeater.items.splice(index + 1, 0, copy);
    return this.persistPage(current, page);
  }

  async reorderRepeaterItems(pageId: string, sectionId: string, repeaterId: string, ids: string[]): Promise<CmsContentPage> {
    const page = await this.getPageDocument(pageId);
    const current = toCmsContentPage(page);
    const repeater = this.findRepeater(this.findSection(current, sectionId), repeaterId);
    repeater.items = this.reorderByIds(repeater.items, ids, `${repeaterId}.items`);
    return this.persistPage(current, page);
  }

  async addRepeaterField(
    pageId: string,
    sectionId: string,
    repeaterId: string,
    target: RepeaterFieldTarget,
    type: CmsAtomicFieldType,
    dto: unknown,
    itemId?: string,
  ): Promise<CmsContentPage> {
    const page = await this.getPageDocument(pageId);
    const current = toCmsContentPage(page);
    const repeater = this.findRepeater(this.findSection(current, sectionId), repeaterId);
    const fields = target === 'template'
      ? repeater.itemFields
      : this.findRepeaterItem(repeater, itemId ?? '').fields;
    fields.push(this.normalizeAtomicField({ ...this.asRecord(dto), type }, type, fields));
    return this.persistPage(current, page);
  }

  async updateRepeaterField(
    pageId: string,
    sectionId: string,
    repeaterId: string,
    target: RepeaterFieldTarget,
    fieldId: string,
    dto: unknown,
    itemId?: string,
  ): Promise<CmsContentPage> {
    const page = await this.getPageDocument(pageId);
    const current = toCmsContentPage(page);
    const repeater = this.findRepeater(this.findSection(current, sectionId), repeaterId);
    const fields = target === 'template'
      ? repeater.itemFields
      : this.findRepeaterItem(repeater, itemId ?? '').fields;
    const index = fields.findIndex((field) => field.id === fieldId);
    if (index < 0) {
      throw new NotFoundException('Content field not found');
    }
    const type = fields[index].type;
    fields[index] = this.normalizeAtomicField(
      { ...fields[index], ...this.asRecord(dto), type: this.asRecord(dto).type ?? type },
      type,
      fields.filter((_, itemIndex) => itemIndex !== index),
    );
    return this.persistPage(current, page);
  }

  async deleteRepeaterField(
    pageId: string,
    sectionId: string,
    repeaterId: string,
    target: RepeaterFieldTarget,
    fieldId: string,
    itemId?: string,
  ): Promise<CmsContentPage> {
    const page = await this.getPageDocument(pageId);
    const current = toCmsContentPage(page);
    const repeater = this.findRepeater(this.findSection(current, sectionId), repeaterId);
    const item = target === 'item'
      ? this.findRepeaterItem(repeater, itemId ?? '')
      : undefined;
    const fields = target === 'template' ? repeater.itemFields : item?.fields ?? [];
    const nextFields = fields.filter((field) => field.id !== fieldId);
    if (nextFields.length === fields.length) {
      throw new NotFoundException('Content field not found');
    }
    if (target === 'template') {
      repeater.itemFields = nextFields;
    } else {
      item!.fields = nextFields;
    }
    return this.persistPage(current, page);
  }

  async reorderRepeaterFields(
    pageId: string,
    sectionId: string,
    repeaterId: string,
    target: RepeaterFieldTarget,
    ids: string[],
    itemId?: string,
  ): Promise<CmsContentPage> {
    const page = await this.getPageDocument(pageId);
    const current = toCmsContentPage(page);
    const repeater = this.findRepeater(this.findSection(current, sectionId), repeaterId);
    if (target === 'template') {
      repeater.itemFields = this.reorderByIds(repeater.itemFields, ids, `${repeaterId}.itemFields`);
    } else {
      const item = this.findRepeaterItem(repeater, itemId ?? '');
      item.fields = this.reorderByIds(item.fields, ids, `${repeaterId}.${item.id}.fields`);
    }
    return this.persistPage(current, page);
  }

  async uploadImage(dto: { dataUrl?: string; imageUrl?: string; fileName?: string; mimeType?: string }) {
    if (dto.dataUrl?.trim()) {
      const mediaId = await this.mediaService.createFromDataUrl(
        dto.dataUrl,
        PLATFORM_MEDIA_USER_ID,
        dto.mimeType,
      );
      return {
        imageUrl: `/media/${mediaId}`,
        fileName: dto.fileName ?? '',
      };
    }
    if (dto.imageUrl?.trim()) {
      return {
        imageUrl: dto.imageUrl.trim(),
        fileName: dto.fileName ?? '',
      };
    }
    throw new BadRequestException('dataUrl or imageUrl is required');
  }

  autoTranslateStub(dto: unknown): unknown {
    return {
      translated: false,
      value: this.asRecord(dto).value ?? null,
      message: 'Auto translate endpoint is reserved for future integration',
    };
  }

  private toPublicAtomicField(field: CmsAtomicField): CmsPublicAtomicField {
    if (field.type === 'text' || field.type === 'textarea' || field.type === 'richText') {
      return { ...field, value: field.value };
    }
    if (field.type === 'button') {
      return {
        ...field,
        text: field.text,
        url: field.url,
      };
    }
    if (field.type === 'link') {
      return {
        ...field,
        text: field.text,
        url: field.url,
      };
    }
    if (field.type === 'image') {
      return { ...field, alt: field.alt };
    }
    if (field.type === 'select') {
      const selectedOption = field.options.find((option) => option.value === field.value);
      const result: CmsPublicAtomicField = {
        id: field.id,
        type: field.type,
        label: field.label,
        value: field.value,
      };
      if (selectedOption) {
        result.selectedOption = {
          id: selectedOption.id,
          value: selectedOption.value,
          label: selectedOption.label,
        };
      }
      return result;
    }
    return { ...field } as CmsPublicAtomicField;
  }

  private toPublicField(field: CmsContentField): CmsPublicField {
    if (field.type !== 'repeater') {
      return this.toPublicAtomicField(field);
    }
    const visibleItems = isLocationRepeaterId(field.id)
      ? field.items.filter((item) => item.showCard !== false)
      : field.items;
    const items: CmsPublicRepeaterItem[] = visibleItems.map((item) => ({
      id: item.id,
      unique_id: item.unique_id,
      ...(isLocationRepeaterId(field.id) ? { showCard: item.showCard !== false } : {}),
      title: item.title,
      fields: item.fields.map((entry) => this.toPublicAtomicField(entry)),
    }));
    const result: CmsPublicRepeaterField = {
      id: field.id,
      type: field.type,
      label: field.label,
      items,
    };
    return result;
  }

  async getPublishedPageBySlug(slug: string): Promise<CmsPublicPage> {
    const page = await this.pageModel
      .findOne({ slug, publication: 'published' })
      .lean()
      .exec();
    if (!page) {
      throw new NotFoundException('Published content page not found');
    }
    const normalized = this.normalizePage(page);
    const sections: CmsPublicSection[] = normalized.sections
      .filter((section) => section.visible)
      .map((section) => ({
        id: section.id,
        name: section.name,
        fields: section.fields.map((field) => this.toPublicField(field)),
      }));
    return {
      id: normalized.id,
      slug: normalized.slug,
      sections,
    };
  }
}
