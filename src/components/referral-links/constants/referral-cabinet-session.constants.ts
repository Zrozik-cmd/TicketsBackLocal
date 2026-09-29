export const referralCabinetSessionRedisKey = (token: string) =>
  `referral:cabinet:session:${token}`;

/** httpOnly cookie name; set on POST .../cabinet/session, read by ReferralPinCodeGuard. */
export const REFERRAL_CABINET_SESSION_COOKIE = 'referralCabinetSession';

/** Default cabinet session lifetime (5 min days). */
export const REFERRAL_CABINET_SESSION_TTL_SEC = 5 * 60;

export const REFERRAL_CABINET_SESSION_COOKIE_MAX_AGE_MS =
  REFERRAL_CABINET_SESSION_TTL_SEC * 1000;
