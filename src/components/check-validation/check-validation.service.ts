import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import mongoose from 'mongoose';
import { MockOrdersService } from '../mock-orders/mock-orders.service';
import { EventSchema, IEvent } from '../events/schemas/event.schema';
import { ICheckValidation, CheckValidationSchema } from './schemas/check.schema';

type UploadedReceipt = {
  buffer: Buffer; 
  mimetype: string;
};

type ExtractedCheckFields = {
  bank: string;
  date: string;
  amount: number;
  transaction_id: string;
  ref_no: string;
  to: string;
};

type EasySlipData = {
  amountInSlip?: number;
  rawSlip?: {
    transRef?: string;
    date?: string;
    ref1?: string;
    ref2?: string;
    sender?: {
      bank?: {
        short?: string;
        name?: string;
      };
    };
    receiver?: {
      account?: {
        name?: {
          th?: string;
          en?: string;
        };
      };
    };
  };
};

type EasySlipResponse = {
  success?: boolean;
  data?: EasySlipData;
  message?: string;
  error?: {
    code?: string;
    message?: string;
  };
};

const CHECK_VALIDATOR_MODEL = 'easyslip-v2';

const CHECK_VALIDATION_ERROR = {
  FILE_REQUIRED: 'check_file_required',
  INVALID_FILE_TYPE: 'invalid_check_file_type',
  EASYSLIP_NOT_CONFIGURED: 'easyslip_not_configured',
  EASYSLIP_REQUEST_FAILED: 'easyslip_request_failed',
  ORDER_NOT_PENDING: 'order_not_pending',
  ORDER_NOT_OWNED: 'order_not_owned',
  CHECK_DATA_MISSING: 'check_data_missing',
  CHECK_AMOUNT_TOO_LOW: 'check_amount_too_low',
  CHECK_RECEIVER_INVALID: 'check_receiver_invalid',
  DUPLICATE_TRANSACTION_ID: 'duplicate_transaction_id',
} as const;

@Injectable()
export class CheckValidationService {
  private readonly logger = new Logger(CheckValidationService.name);
  private readonly easySlipApiKey: string;
  private readonly easySlipVerifyUrl: string;
  private readonly easySlipConfigured: boolean;

  constructor(
    private readonly config: ConfigService,
    private readonly mockOrdersService: MockOrdersService,
  ) {
    this.easySlipApiKey = this.config.get<string>('EASYSLIP_API_KEY', '').trim();
    this.easySlipVerifyUrl = this.config
      .get<string>('EASYSLIP_VERIFY_URL', 'https://api.easyslip.com/v2/verify/bank')
      .trim();
    this.easySlipConfigured = Boolean(this.easySlipApiKey && this.easySlipVerifyUrl);
  }

  private get checkModel(): mongoose.Model<ICheckValidation> {
    return (mongoose.models.CheckValidation as mongoose.Model<ICheckValidation>) ??
      mongoose.model<ICheckValidation>('CheckValidation', CheckValidationSchema);
  }

  private get eventModel(): mongoose.Model<IEvent> {
    return (mongoose.models.Event as mongoose.Model<IEvent>) ??
      mongoose.model<IEvent>('Event', EventSchema);
  }

  private extractFailReason(error: unknown, fallback: string): string {
    if (
      error &&
      typeof error === 'object' &&
      'getResponse' in error &&
      typeof (error as { getResponse?: unknown }).getResponse === 'function'
    ) {
      const response = (error as { getResponse: () => unknown }).getResponse();
      if (typeof response === 'string' && response.trim()) return response.trim();
      if (response && typeof response === 'object' && 'message' in response) {
        const message = (response as { message?: string | string[] }).message;
        if (typeof message === 'string' && message.trim()) return message.trim();
        if (Array.isArray(message) && message[0]) return String(message[0]);
      }
    }
    if (error instanceof Error && error.message.trim()) return error.message.trim();
    return fallback;
  }

  private async saveRejectedCheck(params: {
    orderId: number;
    customerId: number;
    file: Buffer;
    mimeType: string;
    failReason: string;
    extracted?: Partial<ExtractedCheckFields>;
    rawResponse?: string;
  }): Promise<void> {
    const extracted = params.extracted ?? {};
    try {
      await this.checkModel.create({
        orderId: params.orderId,
        customerId: params.customerId,
        bank: extracted.bank ?? '',
        date: extracted.date ?? '',
        amount: this.normalizeAmount(extracted.amount),
        transactionId: extracted.transaction_id ?? '',
        refNo: extracted.ref_no ?? '',
        to: extracted.to ?? '',
        file: params.file,
        mimeType: params.mimeType,
        status: 'rejected',
        failReason: params.failReason,
        gptModel: CHECK_VALIDATOR_MODEL,
        rawResponse: params.rawResponse,
      });
    } catch (error) {
      this.logger.warn(
        `[CheckValidation] failed to save rejected check: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private normalizeAmount(value: unknown): number {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = Number.parseFloat(value.replace(',', '.'));
      return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
  }

  private round2(value: number): number {
    return Math.round(value * 100) / 100;
  }

  private isAmountEqual(left: number, right: number): boolean {
    return this.round2(left) === this.round2(right);
  }

  private normalizeReceiverText(value: string): string {
    return value
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  }

  private hasExpectedReceiver(to: string, expectedReceiver?: string): boolean {
    const normalized = this.normalizeReceiverText(to);
    if (!normalized) return false;
    const expected = this.normalizeReceiverText(expectedReceiver ?? '');
    if (expected) {
      return normalized.includes(expected) || expected.includes(normalized);
    }
    // Legacy events had one global PromptPay receiver.
    return normalized.includes('shaman phuket') || normalized.includes('ชาแมนภูเก็ต');
  }

  private async getExpectedReceiverName(eventId: number): Promise<string | undefined> {
    const event = await this.eventModel
      .findOne({ id: eventId })
      .select({ 'paymentOptions.thb.recipientName': 1 })
      .lean()
      .exec();
    const recipientName = event?.paymentOptions?.thb?.recipientName;
    return typeof recipientName === 'string' && recipientName.trim()
      ? recipientName.trim()
      : undefined;
  }

  private mapEasySlipToFields(response: EasySlipResponse): ExtractedCheckFields {
    const data = response.data ?? {};
    const raw = data.rawSlip ?? {};
    const receiverTh = raw.receiver?.account?.name?.th?.trim() ?? '';
    const receiverEn = raw.receiver?.account?.name?.en?.trim() ?? '';
    const receiverCombined = [receiverEn, receiverTh].filter(Boolean).join(' ').trim();
    const bank = raw.sender?.bank?.short?.trim() || raw.sender?.bank?.name?.trim() || '';
    const refNo = raw.transRef?.trim() ?? '';
    const transactionId = (raw.ref2?.trim() || raw.ref1?.trim() || '').trim();
    const amount = this.normalizeAmount(data.amountInSlip);
    const date = raw.date?.trim() ?? '';

    return {
      bank,
      date,
      amount,
      transaction_id: transactionId,
      ref_no: refNo,
      to: receiverCombined,
    };
  }

  private async verifyWithEasySlip(file: Buffer, mimeType: string): Promise<EasySlipResponse> {
    if (!this.easySlipConfigured) {
      throw new ServiceUnavailableException(CHECK_VALIDATION_ERROR.EASYSLIP_NOT_CONFIGURED);
    }

    const blob = new Blob([file], { type: mimeType || 'image/jpeg' });
    const fieldCandidates = ['file', 'files', 'slip_image', 'image'] as const;
    let lastStatus: number | undefined;

    for (const [index, fieldName] of fieldCandidates.entries()) {
      const formData = new FormData();
      formData.append(fieldName, blob, 'receipt.jpg');
      try {
        const response = await axios.post(this.easySlipVerifyUrl, formData, {
          timeout: 20000,
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
          headers: { Authorization: `Bearer ${this.easySlipApiKey}` },
        });
        return response.data as EasySlipResponse;
      } catch (error) {
        if (axios.isAxiosError(error)) {
          lastStatus = error.response?.status;
          const payload = JSON.stringify(error.response?.data ?? error.message);
          const hasNextCandidate = index < fieldCandidates.length - 1;
          const shouldRetryByField = hasNextCandidate && lastStatus !== 401 && lastStatus !== 403;

          if (shouldRetryByField) {
            // Intermediate fallback attempts are expected for some EasySlip envs.
            this.logger.warn(
              `[EasySlip] field "${fieldName}" rejected (status=${lastStatus ?? 'network'}), retrying with next field`,
            );
          } else {
            this.logger.error(
              `[EasySlip] request failed (field=${fieldName}, status=${lastStatus ?? 'network'}): ${payload}`,
            );
          }
          if (lastStatus === 401 || lastStatus === 403) break;
        } else {
          this.logger.error(`[EasySlip] request failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    throw new ServiceUnavailableException(
      `${CHECK_VALIDATION_ERROR.EASYSLIP_REQUEST_FAILED}${lastStatus ? `_${lastStatus}` : ''}`,
    );
  }

  async validateAndConfirm(params: {
    orderId: number;
    customerId: number;
    file?: UploadedReceipt;
  }) {
    const file = params.file;
    if (!file?.buffer?.length) {
      throw new BadRequestException(CHECK_VALIDATION_ERROR.FILE_REQUIRED);
    }
    const mimeType = (file.mimetype ?? '').toLowerCase();
    if (!mimeType.startsWith('image/')) {
      throw new BadRequestException(CHECK_VALIDATION_ERROR.INVALID_FILE_TYPE);
    }

    const order = await this.mockOrdersService.findById(params.orderId);
    if (order.customer !== params.customerId) {
      await this.saveRejectedCheck({
        orderId: params.orderId,
        customerId: params.customerId,
        file: file.buffer,
        mimeType,
        failReason: CHECK_VALIDATION_ERROR.ORDER_NOT_OWNED,
      });
      throw new ForbiddenException(CHECK_VALIDATION_ERROR.ORDER_NOT_OWNED);
    }
    if (order.status !== 'wait') {
      await this.saveRejectedCheck({
        orderId: params.orderId,
        customerId: params.customerId,
        file: file.buffer,
        mimeType,
        failReason: CHECK_VALIDATION_ERROR.ORDER_NOT_PENDING,
      });
      throw new BadRequestException(CHECK_VALIDATION_ERROR.ORDER_NOT_PENDING);
    }
    const expectedReceiver = await this.getExpectedReceiverName(order.event);

    let easySlipResponse: EasySlipResponse;
    try {
      easySlipResponse = await this.verifyWithEasySlip(file.buffer, mimeType);
    } catch (error) {
      await this.saveRejectedCheck({
        orderId: params.orderId,
        customerId: params.customerId,
        file: file.buffer,
        mimeType,
        failReason: this.extractFailReason(error, CHECK_VALIDATION_ERROR.EASYSLIP_REQUEST_FAILED),
      });
      throw error;
    }
    console.log('[EasySlip] response:', JSON.stringify(easySlipResponse, null, 2));
    const extracted = this.mapEasySlipToFields(easySlipResponse);
    const rawResponse = JSON.stringify(easySlipResponse);

    const isComplete = Boolean(
      extracted.bank &&
      extracted.date &&
      extracted.ref_no &&
      extracted.to &&
      Number.isFinite(extracted.amount) &&
      extracted.amount > 0,
    );
    if (!isComplete) {
      await this.saveRejectedCheck({
        orderId: params.orderId,
        customerId: params.customerId,
        file: file.buffer,
        mimeType,
        failReason: CHECK_VALIDATION_ERROR.CHECK_DATA_MISSING,
        extracted,
        rawResponse,
      });
      throw new BadRequestException(CHECK_VALIDATION_ERROR.CHECK_DATA_MISSING);
    }
    if (!this.hasExpectedReceiver(extracted.to, expectedReceiver)) {
      await this.saveRejectedCheck({
        orderId: params.orderId,
        customerId: params.customerId,
        file: file.buffer,
        mimeType,
        failReason: CHECK_VALIDATION_ERROR.CHECK_RECEIVER_INVALID,
        extracted,
        rawResponse,
      });
      throw new BadRequestException(CHECK_VALIDATION_ERROR.CHECK_RECEIVER_INVALID);
    }
    if (!this.isAmountEqual(extracted.amount, Number(order.total_price ?? 0))) {
      await this.saveRejectedCheck({
        orderId: params.orderId,
        customerId: params.customerId,
        file: file.buffer,
        mimeType,
        failReason: CHECK_VALIDATION_ERROR.CHECK_AMOUNT_TOO_LOW,
        extracted,
        rawResponse,
      });
      throw new BadRequestException(CHECK_VALIDATION_ERROR.CHECK_AMOUNT_TOO_LOW);
    }

    const isDuplicateRefNo = Boolean(
      extracted.ref_no &&
      await this.checkModel.exists({ refNo: extracted.ref_no, status: 'approved' }),
    );
    if (isDuplicateRefNo) {
      await this.saveRejectedCheck({
        orderId: params.orderId,
        customerId: params.customerId,
        file: file.buffer,
        mimeType,
        failReason: CHECK_VALIDATION_ERROR.DUPLICATE_TRANSACTION_ID,
        extracted,
        rawResponse,
      });
      throw new ConflictException(CHECK_VALIDATION_ERROR.DUPLICATE_TRANSACTION_ID);
    }

    let saved: ICheckValidation;
    try {
      saved = await this.checkModel.create({
        orderId: params.orderId,
        customerId: params.customerId,
        bank: extracted.bank,
        date: extracted.date,
        amount: extracted.amount,
        transactionId: extracted.transaction_id,
        refNo: extracted.ref_no,
        to: extracted.to,
        file: file.buffer,
        mimeType,
        status: 'approved',
        gptModel: CHECK_VALIDATOR_MODEL,
        rawResponse,
      });
    } catch (error) {
      if (error && typeof error === 'object' && (error as any).code === 11000) {
        await this.saveRejectedCheck({
          orderId: params.orderId,
          customerId: params.customerId,
          file: file.buffer,
          mimeType,
          failReason: CHECK_VALIDATION_ERROR.DUPLICATE_TRANSACTION_ID,
          extracted,
          rawResponse,
        });
        throw new ConflictException(CHECK_VALIDATION_ERROR.DUPLICATE_TRANSACTION_ID);
      }
      throw error;
    }

    await this.mockOrdersService.confirmPayment(params.orderId);

    return {
      ok: true,
      checkId: saved.id,
      fields: extracted,
    };
  }

  async findAllWithoutFile() {
    return this.checkModel
      .find({})
      .select('-file')
      .sort({ createdAt: -1 })
      .lean()
      .exec();
  }

  async getFileByCheckId(id: number): Promise<{ file: Buffer; mimeType: string }> {
    const doc = await this.checkModel.findOne({ id }).select('file mimeType').exec();
    if (!doc?.file?.length) {
      throw new NotFoundException('Check validation not found');
    }
    return { file: doc.file, mimeType: doc.mimeType || 'application/octet-stream' };
  }
}
