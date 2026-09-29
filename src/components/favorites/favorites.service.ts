import { Injectable, NotFoundException } from '@nestjs/common';
import mongoose from 'mongoose';
import { FavoriteSchema, IFavorite } from './schemas/favorite.schema';
import { EventsService, type PublicEventListItem } from '../events/events.service';

@Injectable()
export class FavoritesService {
  constructor(private readonly eventsService: EventsService) {}

  private get favoriteModel(): mongoose.Model<IFavorite> {
    return (
      (mongoose.models.Favorite as mongoose.Model<IFavorite>) ??
      mongoose.model<IFavorite>('Favorite', FavoriteSchema)
    );
  }

  /** Idempotent: saving an already-saved event just returns the existing row. */
  async add(customerId: number, eventId: number): Promise<{ ok: true }> {
    // Fails fast with 404 rather than storing a favourite for a nonexistent event.
    await this.eventsService.findOneByNumericId(eventId);
    /*
      `create()` (not an upsert): the auto-increment `id` is assigned by a
      save() hook, which findOneAndUpdate bypasses — every upserted row then got
      `id: null` and the second favourite in the collection hit the unique index.
      A concurrent double-save races into the (customer, eventId) index; that
      duplicate is the idempotent no-op we want, so it is swallowed.
    */
    try {
      await this.favoriteModel.create({ customer: customerId, eventId, created: new Date() });
    } catch (error) {
      const isDuplicate = (error as { code?: number })?.code === 11000;
      if (!isDuplicate) throw error;
    }
    return { ok: true };
  }

  async remove(customerId: number, eventId: number): Promise<{ ok: true }> {
    const result = await this.favoriteModel
      .deleteOne({ customer: customerId, eventId })
      .exec();
    if (!result.deletedCount) {
      throw new NotFoundException('Favorite not found');
    }
    return { ok: true };
  }

  async listEventIds(customerId: number): Promise<number[]> {
    const rows = await this.favoriteModel
      .find({ customer: customerId })
      .sort({ created: -1 })
      .select({ eventId: 1 })
      .lean()
      .exec();
    return rows.map((row) => row.eventId);
  }

  /** Saved events with the same shape the public list uses, newest first. */
  async list(customerId: number): Promise<PublicEventListItem[]> {
    const eventIds = await this.listEventIds(customerId);
    if (!eventIds.length) return [];
    const events = await this.eventsService.findPublicByIds(eventIds);
    const order = new Map(eventIds.map((id, index) => [id, index]));
    // `id` is stripped from PublicEventListItem by the Omit<…, keyof Document> alias,
    // but it is very much present at runtime.
    const idOf = (event: PublicEventListItem) => (event as unknown as { id: number }).id;
    return events.sort((a, b) => (order.get(idOf(a)) ?? 0) - (order.get(idOf(b)) ?? 0));
  }
}
