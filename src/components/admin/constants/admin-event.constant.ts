/** Stable `snake_case` codes of the admin event actions; the admin panel translates them. */
export const ADMIN_EVENT_ERROR = {
  NOT_IN_MODERATION: 'event_not_in_moderation',
  /** 409: the event kept changing while an admin action was saved (3 attempts). */
  CHANGED_CONCURRENTLY: 'event_changed_concurrently',
  DELETE_CONFIRMATION_MISMATCH: 'event_delete_confirmation_mismatch',
  DELETE_BLOCKED: 'event_delete_blocked',
  DELETE_ARCHIVE_FAILED: 'event_delete_archive_failed',
  DELETE_RECHECK_FAILED: 'event_delete_recheck_failed',
  DELETE_ROLLBACK_FAILED: 'event_delete_rollback_failed',
} as const;
