import { Schema, Document } from 'mongoose';
import type {
  CmsContentPage,
  CmsContentSection,
  CmsPublicationStatus,
} from '../types/cms.types';

export interface ICmsPage extends Document {
  id: string;
  name?: string;
  slug?: string;
  publication: CmsPublicationStatus;
  sections: CmsContentSection[];
  createdAt: Date;
  updatedAt: Date;
}

export const CmsPageSchema = new Schema<ICmsPage>(
  {
    id: { type: String, required: true, unique: true, trim: true },
    name: { type: String, required: false, default: '' },
    slug: { type: String, required: false, default: '', trim: true },
    publication: {
      type: String,
      required: true,
      enum: ['draft', 'published'],
      default: 'draft',
    },
    sections: ({
      type: [Schema.Types.Mixed],
      required: true,
      default: [],
    } as unknown) as CmsContentSection[],
  },
  { timestamps: true },
);

CmsPageSchema.index({ publication: 1, slug: 1 });

export function toCmsContentPage(page: ICmsPage | CmsContentPage): CmsContentPage {
  const maybeDoc = page as ICmsPage;
  return {
    id: page.id,
    name: page.name ?? '',
    slug: page.slug ?? '',
    publication: page.publication,
    sections: page.sections ?? [],
    createdAt:
      maybeDoc.createdAt instanceof Date ? maybeDoc.createdAt.toISOString() : undefined,
    updatedAt:
      maybeDoc.updatedAt instanceof Date ? maybeDoc.updatedAt.toISOString() : undefined,
  };
}
