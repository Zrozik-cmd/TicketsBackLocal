import {
  eventMessengerDeliveryModel,
  eventMessengerIntegrationModel,
} from './schemas/event-messenger.models';

/**
 * Removes every messenger integration of an event and its delivery log. Called after an
 * event is hard-deleted (admin delete, organizer delete without sales), so credentials
 * never outlive the event. Dependency-free on purpose: the delete paths call it without
 * importing the module.
 */
export async function removeEventMessengerData(
  eventId: number,
): Promise<{ integrations: number; deliveries: number }> {
  const [integrations, deliveries] = await Promise.all([
    eventMessengerIntegrationModel().deleteMany({ eventId }).exec(),
    eventMessengerDeliveryModel().deleteMany({ eventId }).exec(),
  ]);
  return { integrations: integrations.deletedCount, deliveries: deliveries.deletedCount };
}
