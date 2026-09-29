/** User schema defaults and fallback when legacy documents omit fee fields. */
export const DEFAULT_VAT_PERCENT = 7;
export const DEFAULT_PROCESSING_FEE_PERCENT = 2;
export const DEFAULT_PLATFORM_FEE_PERCENT = 8;
/** Additional ticket cost fee (% of subtotal after promo), same basis as VAT; default 0. */
export const DEFAULT_ADDITIONAL_TICKET_COST_FEE_PERCENT = 0;
/**
 * Service commission on cash payments (% of the VAT-inclusive total), charged
 * on top like the card surcharge. Overridable per event from the admin panel.
 */
export const DEFAULT_CASH_FEE_PERCENT = 2;
