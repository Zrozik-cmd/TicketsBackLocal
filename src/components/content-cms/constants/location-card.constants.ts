import type { CmsAtomicField, CmsLocalizedString } from '../types/cms.types';

export const LOCATION_REPEATER_ID_PREFIX = 'locations';
export const LOCATION_CARD_UNIQUE_ID_KEY = 'unique_id';
export const LOCATION_CARD_SHOW_CARD_KEY = 'showCard';

export const LOCATION_CARD_DAYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;

export type LocationCardDay = (typeof LOCATION_CARD_DAYS)[number];

const emptyLocalized = (): CmsLocalizedString => ({ en: '', ru: '', th: '' });

const textField = (id: string, label: string): CmsAtomicField => ({
  id,
  label,
  type: 'text',
  value: emptyLocalized(),
});

const textareaField = (id: string, label: string): CmsAtomicField => ({
  id,
  label,
  type: 'textarea',
  value: emptyLocalized(),
});

const booleanField = (id: string, label: string, value = false): CmsAtomicField => ({
  id,
  label,
  type: 'boolean',
  value,
});

const numberField = (id: string, label: string): CmsAtomicField => ({
  id,
  label,
  type: 'number',
  value: '',
});

export const LOCATION_CARD_SIGNATURE_FIELD_IDS = [
  'latitude',
  'longitude',
  'routeButtonUrl',
] as const;

/** Default atomic fields for one location card (fixed template + base image trio). */
export function buildDefaultLocationCardFields(): CmsAtomicField[] {
  const dayFields = LOCATION_CARD_DAYS.flatMap((day) => {
    const label = day.charAt(0).toUpperCase() + day.slice(1);
    return [
      booleanField(`${day}Enabled`, label, false),
      textField(`${day}Open`, `${label} open`),
      textField(`${day}Close`, `${label} close`),
    ];
  });

  return [
    textField('title', 'Title'),
    textareaField('address', 'Address'),
    textField('phone', 'Phone'),
    textField('openLabel', 'Open label'),
    textField('closedLabel', 'Closed label'),
    textField('timezone', 'Timezone'),
    ...dayFields,
    textField('routeButtonLabel', 'Route button label'),
    textField('routeButtonUrl', 'Route button URL'),
    numberField('latitude', 'Latitude'),
    numberField('longitude', 'Longitude'),
    textField('imageUrl', 'Image URL'),
    textField('imageStorage', 'Storage'),
    textField('imageAlt', 'Alt'),
  ];
}

export function isLocationRepeaterId(id: string): boolean {
  return id === LOCATION_REPEATER_ID_PREFIX || id.startsWith(`${LOCATION_REPEATER_ID_PREFIX}-`);
}

/** Extra dynamic image fields: imageUrl-2, imageStorage-2, imageAlt-2, … */
export function isLocationImageFieldId(id: string): boolean {
  return /^image(Url|Storage|Alt)(-\d+)?$/.test(id);
}
