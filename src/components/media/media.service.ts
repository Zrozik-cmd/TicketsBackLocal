import { Injectable, NotFoundException } from '@nestjs/common';
import mongoose from 'mongoose';
import { IMedia, MediaSchema } from './schemas/media.schema';

@Injectable()
export class MediaService {
  private get mediaModel(): mongoose.Model<IMedia> {
    return (mongoose.models.Media as mongoose.Model<IMedia>) ??
      mongoose.model<IMedia>('Media', MediaSchema);
  }

  private parseDataUrl(dataUrl: string): { mimeType: string; file: Buffer } {
    const trimmed = (dataUrl ?? '').trim();
    const match = /^data:([^;]+);base64,(.+)$/i.exec(trimmed);
    if (!match) {
      throw new Error('Invalid image data URL');
    }
    const mimeType = match[1].trim().toLowerCase();
    const file = Buffer.from(match[2], 'base64');
    if (!file.length) {
      throw new Error('Empty image payload');
    }
    return { mimeType, file };
  }

  private async waitForMongoConnection(): Promise<void> {
    if (mongoose.connection.readyState === 1) return;
    await new Promise<void>((resolve) => {
      const onConnected = () => {
        mongoose.connection.off('connected', onConnected);
        resolve();
      };
      mongoose.connection.on('connected', onConnected);
    });
  }

  private isLegacyImage(value: unknown): value is { url: string; mimeType?: string } {
    if (!value || typeof value !== 'object') return false;
    const row = value as Record<string, unknown>;
    return typeof row.url === 'string' && /^data:[^;]+;base64,/i.test(row.url.trim());
  }

  async createFromDataUrl(
    dataUrl: string,
    userId: number,
    mimeTypeOverride?: string,
    options?: { isPrivate?: boolean },
  ): Promise<number> {
    const parsed = this.parseDataUrl(dataUrl);
    const media = await this.mediaModel.create({
      file: parsed.file,
      mimeType: (mimeTypeOverride?.trim() || parsed.mimeType).toLowerCase(),
      user: userId,
      isPrivate: options?.isPrivate === true,
    });
    return media.id;
  }

  /**
   * Публичная выдача: приватные файлы недоступны и неотличимы от несуществующих
   * — 404 вместо 403, чтобы перебором нельзя было узнать, что документ есть.
   */
  async getPublicById(id: number): Promise<IMedia> {
    const media = await this.getById(id);
    if (media.isPrivate) {
      throw new NotFoundException('Media not found');
    }
    return media;
  }

  async getById(id: number): Promise<IMedia> {
    const media = await this.mediaModel.findOne({ id }).exec();
    if (!media) {
      throw new NotFoundException('Media not found');
    }
    return media;
  }

  async removeById(id: number): Promise<void> {
    await this.mediaModel.deleteOne({ id }).exec();
  }

  async migrateLegacyEventImagesInEvents(): Promise<{ processed: number; updated: number; failed: number }> {
    await this.waitForMongoConnection();

    const eventsCollection = mongoose.connection.collection('events');
    const cursor = eventsCollection.find({
      $or: [
        { 'coverImage.url': { $type: 'string' } },
        { 'seatingPlanImage.url': { $type: 'string' } },
        { 'parkingPlanImage.url': { $type: 'string' } },
      ],
    });

    let processed = 0;
    let updated = 0;
    let failed = 0;

    for await (const doc of cursor) {
      processed += 1;
      try {
        const creator = Number((doc as any).creator);
        const userId = Number.isFinite(creator) && creator > 0 ? creator : 0;
        const coverLegacy = this.isLegacyImage((doc as any).coverImage) ? (doc as any).coverImage : undefined;
        const seatingLegacy = this.isLegacyImage((doc as any).seatingPlanImage)
          ? (doc as any).seatingPlanImage
          : undefined;
        const parkingLegacy = this.isLegacyImage((doc as any).parkingPlanImage)
          ? (doc as any).parkingPlanImage
          : undefined;

        if (!coverLegacy && !seatingLegacy && !parkingLegacy) {
          continue;
        }

        const setPayload: Record<string, unknown> = {};
        const unsetPayload: Record<string, 1> = {};

        if (coverLegacy) {
          const coverMediaId = await this.createFromDataUrl(coverLegacy.url, userId, coverLegacy.mimeType);
          setPayload.coverImage = coverMediaId;
        }

        if (seatingLegacy) {
          const seatingMediaId = await this.createFromDataUrl(seatingLegacy.url, userId, seatingLegacy.mimeType);
          setPayload.seatingPlanImage = seatingMediaId;
        } else if ((doc as any).seatingPlanImage && typeof (doc as any).seatingPlanImage === 'object') {
          unsetPayload.seatingPlanImage = 1;
        }

        if (parkingLegacy) {
          const parkingMediaId = await this.createFromDataUrl(parkingLegacy.url, userId, parkingLegacy.mimeType);
          setPayload.parkingPlanImage = parkingMediaId;
        } else if ((doc as any).parkingPlanImage && typeof (doc as any).parkingPlanImage === 'object') {
          unsetPayload.parkingPlanImage = 1;
        }

        await eventsCollection.updateOne(
          { _id: (doc as any)._id },
          {
            ...(Object.keys(setPayload).length ? { $set: setPayload } : {}),
            ...(Object.keys(unsetPayload).length ? { $unset: unsetPayload } : {}),
          },
        );
        updated += 1;
      } catch {
        failed += 1;
      }
    }

    return { processed, updated, failed };
  }
}
