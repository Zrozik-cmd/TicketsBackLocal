import { Injectable } from '@nestjs/common';

@Injectable()
export class NotificationService {
  /**
   * Mock SMS sender: logs the message to console.
   * Verification code is stored in Redis by the caller (PhoneService).
   */
  sendSms(phone: string, message: string): void {
    console.log(`[SMS Mock] To: ${phone} | Message: ${message}`);
  }
}
