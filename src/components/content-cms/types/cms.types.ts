export const CMS_LOCALES = ['en', 'ru', 'th'] as const;
export type CmsLocale = (typeof CMS_LOCALES)[number];

export const CMS_FIELD_TYPES = [
  'text',
  'textarea',
  'richText',
  'button',
  'link',
  'image',
  'number',
  'boolean',
  'select',
  'repeater',
] as const;

export const CMS_ATOMIC_FIELD_TYPES = CMS_FIELD_TYPES.filter(
  (type) => type !== 'repeater',
) as CmsAtomicFieldType[];

export type CmsFieldType = (typeof CMS_FIELD_TYPES)[number];
export type CmsAtomicFieldType = Exclude<CmsFieldType, 'repeater'>;
export type CmsPublicationStatus = 'draft' | 'published';
export type CmsButtonTarget = 'auto' | '_self' | '_blank';
export type CmsLinkTarget = '_self' | '_blank';

export type CmsLocalizedString = Record<CmsLocale, string>;

export interface CmsBaseField {
  id: string;
  type: CmsFieldType;
  label?: string;
}

export interface CmsTextField extends CmsBaseField {
  type: 'text' | 'textarea' | 'richText';
  value: CmsLocalizedString;
}

export interface CmsButtonField extends CmsBaseField {
  type: 'button';
  text: CmsLocalizedString;
  url: CmsLocalizedString;
  target: CmsButtonTarget;
}

export interface CmsLinkField extends CmsBaseField {
  type: 'link';
  text: CmsLocalizedString;
  url: CmsLocalizedString;
  target: CmsLinkTarget;
}

export interface CmsImageField extends CmsBaseField {
  type: 'image';
  imageUrl: string;
  fileName: string;
  alt: CmsLocalizedString;
}

export interface CmsNumberField extends CmsBaseField {
  type: 'number';
  value: string;
}

export interface CmsBooleanField extends CmsBaseField {
  type: 'boolean';
  value: boolean;
}

export interface CmsSelectOption {
  id: string;
  label: CmsLocalizedString;
  value: string;
}

export interface CmsSelectField extends CmsBaseField {
  type: 'select';
  value: string;
  options: CmsSelectOption[];
}

export type CmsAtomicField =
  | CmsTextField
  | CmsButtonField
  | CmsLinkField
  | CmsImageField
  | CmsNumberField
  | CmsBooleanField
  | CmsSelectField;

export interface CmsRepeaterItem {
  id: string;
  unique_id?: string;
  /** Location cards only: when false, card is hidden from public content API. Default true. */
  showCard?: boolean;
  title?: string;
  fields: CmsAtomicField[];
}

export interface CmsRepeaterField extends CmsBaseField {
  type: 'repeater';
  itemFields: CmsAtomicField[];
  items: CmsRepeaterItem[];
}

export type CmsContentField = CmsAtomicField | CmsRepeaterField;

export interface CmsContentSection {
  id: string;
  name?: string;
  visible: boolean;
  fields: CmsContentField[];
}

export interface CmsContentPage {
  id: string;
  name?: string;
  slug?: string;
  publication: CmsPublicationStatus;
  sections: CmsContentSection[];
  createdAt?: string;
  updatedAt?: string;
}

export interface CmsPageListItem {
  id: string;
  name?: string;
  slug?: string;
  publication: CmsPublicationStatus;
}

export type CmsPublicAtomicField =
  | (Omit<CmsTextField, 'value'> & { value: CmsLocalizedString })
  | (Omit<CmsButtonField, 'text' | 'url'> & {
      text: CmsLocalizedString;
      url: CmsLocalizedString;
    })
  | (Omit<CmsLinkField, 'text' | 'url'> & {
      text: CmsLocalizedString;
      url: CmsLocalizedString;
    })
  | (Omit<CmsImageField, 'alt'> & { alt: CmsLocalizedString })
  | CmsNumberField
  | CmsBooleanField
  | (Omit<CmsSelectField, 'options'> & {
      selectedOption?: {
        id: string;
        value: string;
        label: CmsLocalizedString;
      };
    });

export interface CmsPublicRepeaterItem {
  id: string;
  unique_id?: string;
  showCard?: boolean;
  title?: string;
  fields: CmsPublicAtomicField[];
}

export interface CmsPublicRepeaterField extends Omit<CmsRepeaterField, 'itemFields' | 'items'> {
  items: CmsPublicRepeaterItem[];
}

export type CmsPublicField = CmsPublicAtomicField | CmsPublicRepeaterField;

export interface CmsPublicSection {
  id: string;
  name?: string;
  fields: CmsPublicField[];
}

export interface CmsPublicPage {
  id: string;
  slug?: string;
  sections: CmsPublicSection[];
}
