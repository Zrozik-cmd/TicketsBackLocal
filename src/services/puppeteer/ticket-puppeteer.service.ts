import {
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { spawn } from 'child_process';
import Handlebars from 'handlebars';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import mongoose from 'mongoose';
import { MediaService } from '../../components/media/media.service';
import { MockOrderSchema, type IMockOrder } from '../../components/mock-orders/schemas/mock-order.schema';
import {
  TICKET_EMAIL_LOCALES,
  type TicketEmailLocale,
} from './locale/ticket.locale';
import { CustomersService } from '../../components/customers/customers.service';
import { EventsService } from '../../components/events/events.service';
import { IEvent } from '../../components/events/schemas/event.schema';
import { TicketsService } from '../../components/tickets/tickets.service';
import type { ITicket } from '../../components/tickets/schemas/ticket.schema';
import puppeteer from 'puppeteer';
import { PuppeteerBrowserService } from './puppeteer-browser.service';
import { generateQR } from './helpers/generate-gr';
import { sponsorNameFontSize } from './helpers/sponsor-name-font-size';
import { formatTicketDate, formatTicketDateTime } from './helpers/ticket-date';
import { venueOneLine } from '../../components/events/utils/venue.util';
import { EVENT_MAX_SPONSORS } from '../../components/events/constants/event-sponsors.constant';
import { isSponsorHttpUrl } from '../../components/events/utils/event-sponsors.util';
import { seatLabelText } from '../../components/seat-holds/utils/seat-holds.util';

type MockOrderRef = Pick<IMockOrder, 'id' | 'createdAt'>;

/** One sponsor of the ticket's "Sponsored by" block, as `templates/ticket.html` renders it. */
type TicketSponsor = {
  /** `data:` URL of the logo. */
  logo: string;
  /** `''` when not given (the name line is still reserved). */
  name: string;
  /** http(s) link, or `''`; a link becomes an `<a href>` box over the item (clickable in the PDF). */
  url: string;
  /**
   * Font size of the name: it is shrunk until it fits the 200px line (the line height stays
   * 24px) — see `helpers/sponsor-name-font-size.ts`.
   */
  nameFontSize: number;
};

@Injectable()
export class TicketPuppeteerService {
  private readonly logger = new Logger(TicketPuppeteerService.name);

  private static ticketTemplateCompile:
    | ((ctx: { tickets: Record<string, unknown>[]; pdf: boolean }) => string)
    | undefined;

  private static readonly pdfOneOffLaunch: Parameters<typeof puppeteer.launch>[0] = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--font-render-hinting=none',
    ],
  };

  constructor(
    private readonly config: ConfigService,
    private readonly mediaService: MediaService,
    private readonly customersService: CustomersService,
    private readonly eventsService: EventsService,
    private readonly ticketsService: TicketsService,
    private readonly puppeteerBrowser: PuppeteerBrowserService,
  ) {}

  private get mockOrderModel(): mongoose.Model<IMockOrder> {
    return (mongoose.models.MockOrder as mongoose.Model<IMockOrder>) ??
      mongoose.model<IMockOrder>('MockOrder', MockOrderSchema);
  }

  private pickLocalizedText(
    value: { th?: string; en?: string; ru?: string } | undefined,
    locale: TicketEmailLocale,
    fallback = '',
  ): string {
    if (!value) return fallback;
    const order: TicketEmailLocale[] =
      locale === 'th' ? ['th', 'en', 'ru'] : locale === 'ru' ? ['ru', 'en', 'th'] : ['en', 'th', 'ru'];
    for (const key of order) {
      const text = value[key]?.trim();
      if (text) return text;
    }
    return fallback;
  }

  private sanitizePathSegment(value: string): string {
    const cleaned = value
      .toLowerCase()
      .replace(/[^a-z0-9а-яёก-๙]+/gi, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 80);
    return cleaned || 'event';
  }

  private getTicketPdfRootDir(): string {
    const configured = this.config.get<string>('TICKETS_PDF_STORAGE_DIR', '').trim();
    if (configured) return configured;
    return path.resolve(process.cwd(), '..', 'TicketsFront', 'public', 'pdf');
  }

  private async findMockOrderPdfRef(orderId: number): Promise<MockOrderRef | undefined> {
    const row = await this.mockOrderModel.findOne({ id: orderId }).lean().exec();
    if (!row?.createdAt) return undefined;
    return { id: row.id, createdAt: row.createdAt };
  }

  /** Plain grey cover (inline SVG, vector in the PDF): an external placeholder could stall the render. */
  private readonly ticketImageCoverPlaceholder = `data:image/svg+xml;base64,${Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1166" height="654">' +
      '<rect width="1166" height="654" fill="#e5e7eb"/></svg>',
  ).toString('base64')}`;

  private async resolveEventCoverImageDataUrl(event: IEvent): Promise<string> {
    const id = Number(event.coverImage);
    if (!Number.isFinite(id) || id <= 0) {
      return this.ticketImageCoverPlaceholder;
    }
    try {
      const media = await this.mediaService.getById(id);
      if (!media.file?.length) {
        return this.ticketImageCoverPlaceholder;
      }
      const mime = (media.mimeType || 'image/jpeg').trim().toLowerCase();
      return `data:${mime};base64,${media.file.toString('base64')}`;
    } catch (err) {
      this.logger.warn(
        `ticket_image_cover_load_failed mediaId=${id}: ${String(err)}`,
      );
      return this.ticketImageCoverPlaceholder;
    }
  }

  /**
   * The "Sponsored by" block: the APPROVED `event.sponsors` only, in order — a list pending
   * admin approval never reaches a ticket. Logos are embedded as data URLs like the cover (the
   * page never waits on the network; the PDF re-encodes them smaller). A sponsor whose logo
   * media is missing, empty or not an image is left out; a link is kept only when it is http(s).
   */
  private async resolveTicketSponsors(event: IEvent): Promise<TicketSponsor[]> {
    const approved = Array.isArray(event.sponsors) ? event.sponsors.slice(0, EVENT_MAX_SPONSORS) : [];
    const resolved = await Promise.all(
      approved.map(async (sponsor): Promise<TicketSponsor | null> => {
        const id = Number(sponsor?.logo);
        if (!Number.isInteger(id) || id <= 0) return null;
        try {
          const media = await this.mediaService.getById(id);
          const mime = (media.mimeType || '').trim().toLowerCase();
          if (!media.file?.length || !/^image\/[a-z0-9.+-]+$/.test(mime)) {
            this.logger.warn(`ticket_sponsor_logo_unusable eventId=${event.id} mediaId=${id}`);
            return null;
          }
          const url = typeof sponsor.url === 'string' ? sponsor.url.trim() : '';
          const name = typeof sponsor.name === 'string' ? sponsor.name.trim() : '';
          return {
            logo: `data:${mime};base64,${media.file.toString('base64')}`,
            name,
            url: isSponsorHttpUrl(url) ? url : '',
            nameFontSize: sponsorNameFontSize(name),
          };
        } catch (err) {
          this.logger.warn(
            `ticket_sponsor_logo_load_failed eventId=${event.id} mediaId=${id}: ${String(err)}`,
          );
          return null;
        }
      }),
    );
    return resolved.filter((sponsor): sponsor is TicketSponsor => sponsor !== null);
  }

  /** Empty 1x1 SVG: a missing bundled icon leaves a blank spot instead of a network request. */
  private readonly ticketImageIconFallback =
    'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxIiBoZWlnaHQ9IjEiLz4=';

  private async resolveBundledImageDataUrl(
    filename: string,
    fallback: string = this.ticketImageIconFallback,
  ): Promise<string> {
    try {
      const abs = path.join(__dirname, 'images', filename);
      const buf = await fs.readFile(abs);
      if (!buf.length) return fallback;
      const ext = path.extname(filename).toLowerCase();
      const mime =
        ext === '.png'
          ? 'image/png'
          : ext === '.jpg' || ext === '.jpeg'
            ? 'image/jpeg'
            : 'image/png';
      return `data:${mime};base64,${buf.toString('base64')}`;
    } catch (err) {
      this.logger.warn(
        `ticket_image_bundled_failed file=${filename}: ${String(err)}`,
      );
      return fallback;
    }
  }

  /**
   * Schedule printed on the ticket.
   *
   * A ticket for a regular event belongs to one specific show, so its own session
   * date/time wins over the event-level schedule — the latter only describes the span
   * the run covers and would otherwise print the wrong day.
   */
  private splitEventSchedule(
    event: IEvent,
    ticket?: Pick<ITicket, 'session' | 'sessionDate' | 'sessionStart' | 'sessionEnd'>,
  ): { date: string; time: string; start: string } {
    const hasSession = typeof ticket?.session === 'number' && !!ticket?.sessionDate;
    const startDate = hasSession
      ? (ticket?.sessionDate ?? '').trim()
      : (event.eventDate?.startDate?.trim() ?? '');
    const allDay = hasSession ? false : (event.time?.allDay ?? false);
    const tStart = hasSession
      ? (ticket?.sessionStart ?? '').trim()
      : (event.time?.start?.trim() ?? '');
    const tEnd = hasSession
      ? (ticket?.sessionEnd ?? '').trim()
      : (event.time?.end?.trim() ?? '');
    const pad = (n: number) => String(n).padStart(2, '0');
    let date = '—';
    if (startDate) {
      const normalized = /^\d{4}-\d{2}-\d{2}/.test(startDate)
        ? `${startDate}T12:00:00`
        : startDate;
      const d = new Date(normalized);
      if (!Number.isNaN(d.getTime())) {
        date = `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
      } else {
        date = startDate;
      }
    }
    const time = allDay ? '—' : tEnd ? `${tStart} – ${tEnd}` : tStart || '—';
    const start = allDay ? '—' : tStart || '—';
    return { date, time, start };
  }

  private async resolveContext(id: number): Promise<{
    ticket: ITicket;
    event: IEvent;
    mockOrder?: MockOrderRef;
  }> {
    const ticket = await this.ticketsService.findById(id);
    if (!ticket) {
      throw new NotFoundException('Ticket not found');
    }
    const event = await this.eventsService.findOneByNumericId(ticket.eventId);
    const mockOrder = await this.findMockOrderPdfRef(ticket.orderId);
    return { ticket, event, mockOrder };
  }

  private async buildTemplatePayload(params: {
    locale: TicketEmailLocale;
    event: IEvent;
    ticket: ITicket;
    mockOrder?: MockOrderRef;
  }): Promise<{
    tickets: Record<string, unknown>[];
    doc: ITicket;
    eventTitle: string;
  }> {
    const customer = await this.customersService.findById(
      String(params.ticket.customer),
    );
    if (!customer?.email) {
      throw new Error(
        `Customer email not found for customer=${params.ticket.customer}`,
      );
    }

    const buyerName =
      customer.fullname?.trim() || `Customer #${params.ticket.customer}`;
    const dict = TICKET_EMAIL_LOCALES[params.locale];
    const eventTitle = this.pickLocalizedText(
      params.event.title,
      params.locale,
      `Event #${params.event.id}`,
    );

    const sectorNameById = new Map<string, string>();
    const zoneNameById = new Map<string, string>();
    for (const sector of params.event.sectors ?? []) {
      sectorNameById.set(
        sector.id,
        this.pickLocalizedText(sector.name, params.locale, sector.id),
      );
      for (const zone of sector.zones ?? []) {
        zoneNameById.set(
          zone.id,
          this.pickLocalizedText(zone.name, params.locale, zone.id),
        );
      }
    }

    const lineDecor = 'https://example.com/line.svg';
    const coverImage = await this.resolveEventCoverImageDataUrl(params.event);
    // На билете одна строка: название плюс адрес, если они различаются.
    const venueAddress = venueOneLine(params.event.venue) || '—';
    const { date, time, start } = this.splitEventSchedule(params.event, params.ticket);
    const arrivalNote = dict.ticketPdf.arrivalNote;
    const descEvent = this.pickLocalizedText(
      params.event.description,
      params.locale,
      '',
    ).trim();

    const [sellerIcon, serviceIcon, footerLogo, sponsors] = await Promise.all([
      this.resolveBundledImageDataUrl('lotus.png'),
      this.resolveBundledImageDataUrl('arbi.png'),
      this.resolveBundledImageDataUrl('arbi2.png'),
      this.resolveTicketSponsors(params.event),
    ]);

    const doc = params.ticket;
    const sector = sectorNameById.get(doc.sector) ?? doc.sector;
    const zone = zoneNameById.get(doc.zone) ?? doc.zone;
    // Куплено по схеме зала: место — своей строкой под зоной
    const seat = doc.seatLabel ? seatLabelText(doc.seatLabel, params.locale) : '';
    const orderIdForImage = params.mockOrder?.id ?? doc.orderId;
    const orderDateSource = params.mockOrder?.createdAt ?? doc.created;
    const orderDateOnly = formatTicketDate(orderDateSource);
    const orderDisplay =
      orderDateOnly !== ''
        ? `${orderIdForImage} | ${orderDateOnly}`
        : String(orderIdForImage);
    const purchaseDate = formatTicketDateTime(orderDateSource);
    const price = `${doc.currency} ${doc.price}`;
    const pdf = dict.ticketPdf;
    const qrImage = await generateQR(doc.code);
    const ticketRulesList = pdf.ticketRulesDescription
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const details = [
      `${dict.fields.purchaseDate}: ${purchaseDate}`,
      `${dict.fields.ticketId}: #${doc.id}`,
      `${dict.fields.ticketCode}: ${doc.code}`,
      `${dict.fields.sector}: ${sector}`,
      `${dict.fields.zone}: ${zone}`,
      ...(seat ? [`${dict.fields.seat}: ${seat}`] : []),
      `${dict.fields.price}: ${price}`,
      `${dict.fields.buyer}: ${buyerName}`,
      `${dict.fields.email}: ${customer.email}`,
    ].join('\n');
    const description = [descEvent, details].filter(Boolean).join('\n\n');

    const templateTickets: Record<string, unknown>[] = [
      {
        coverImage,
        title: eventTitle,
        address: venueAddress,
        dateTitle: pdf.dateTitle,
        date,
        timeTitle: pdf.timeTitle,
        time,
        startTitle: pdf.startTitle,
        start,
        arrivalNote,
        sectorTitle: dict.fields.sector,
        sectorName: sector,
        zoneTitle: dict.fields.zone,
        zoneName: zone,
        seatTitle: dict.fields.seat,
        seatName: seat,
        description,
        line1: lineDecor,
        sellerTitle: pdf.sellerTitle,
        sellerIcon,
        seller: 'Lotus Arena Phuket',
        serviceTitle: pdf.serviceTitle,
        serviceIcon,
        service: 'ARBI',
        orderTitle: pdf.orderTitle,
        order: orderDisplay,
        infoAndDetailsTitle: pdf.infoAndDetailsTitle,
        phone: ' +66626620000',
        line2: lineDecor,
        qr: qrImage,
        qrText: doc.code,
        ticketRulesTitle: pdf.ticketRulesTitle,
        ticketRulesList,
        dontShareOnSocialMediaTitle: pdf.dontShareOnSocialMediaTitle,
        logo: footerLogo,
        // Empty list = no "Sponsored by" row: the template renders exactly as before sponsors.
        sponsorsTitle: sponsors.length === 1 ? pdf.sponsorsTitle.one : pdf.sponsorsTitle.many,
        sponsors,
      },
    ];

    return { tickets: templateTickets, doc, eventTitle };
  }

  /**
   * Handlebars `templates/ticket.html` (see `nest-cli.json` assets). `pdf: true` for a PDF: the
   * ticket without the drop shadow, whose `filter` makes Chrome print it as one ~2.4 MB bitmap.
   */
  private async renderTicketHtml(
    tickets: Record<string, unknown>[],
    options: { pdf?: boolean } = {},
  ): Promise<string> {
    const filePath = path.join(__dirname, 'templates', 'ticket.html');
    if (!TicketPuppeteerService.ticketTemplateCompile) {
      const source = await fs.readFile(filePath, 'utf8');
      TicketPuppeteerService.ticketTemplateCompile = Handlebars.compile(source);
    }
    return TicketPuppeteerService.ticketTemplateCompile({ tickets, pdf: options.pdf === true });
  }

  /** One-off browser per PDF. WebP uses `PuppeteerBrowserService` + queue. */
  private async renderHtmlToTicketPdf(html: string): Promise<Buffer> {
    const browser = await puppeteer.launch(TicketPuppeteerService.pdfOneOffLaunch);
    try {
      const page = await browser.newPage();
      await page.setViewport({
        width: 1400,
        height: 900,
        deviceScaleFactor: 1,
      });
      await page.setContent(html, { waitUntil: 'networkidle0' });
      const w = await page.evaluate(
        () => document.documentElement.scrollWidth,
      );
      const h = await page.evaluate(
        () => document.documentElement.scrollHeight,
      );
      const pdf = await page.pdf({
        printBackground: true,
        width: `${w}px`,
        height: `${h}px`,
      });
      return Buffer.isBuffer(pdf) ? pdf : Buffer.from(pdf);
    } finally {
      await browser.close();
    }
  }

  /**
   * One pass: template + HTML + WebP. Used for email (buffer only) and for saving to disk.
   */
  private async buildTicketWebPResult(
    ctx: { event: IEvent; ticket: ITicket; mockOrder?: MockOrderRef },
    locale: TicketEmailLocale,
  ): Promise<{
    buffer: Buffer;
    eventTitle: string;
    doc: ITicket;
  }> {
    const { tickets: templateTickets, doc, eventTitle } = await this.buildTemplatePayload({
      ...ctx,
      locale,
    });
    const html = await this.renderTicketHtml(templateTickets);
    const webpBuffer = await this.puppeteerBrowser.captureWebpFromHtml(html);
    if (!webpBuffer?.length) {
      throw new Error(`ticket_webp_empty orderId=${doc.orderId} ticketId=${doc.id}`);
    }
    this.logger.debug(
      `Ticket WebP orderId=${doc.orderId} ticketId=${doc.id} bytes=${webpBuffer.length}`,
    );
    return { buffer: webpBuffer, eventTitle, doc };
  }

  /**
   * WebP bytes for a ticket (e.g. email attachment). No filesystem writes.
   */
  async getTicketWebPBuffer(
    id: number,
    locale: TicketEmailLocale,
  ): Promise<Buffer> {
    const context = await this.resolveContext(id);
    const { buffer } = await this.buildTicketWebPResult(context, locale);
    return buffer;
  }

  /**
   * The ticket as a one-page PDF sized to the ticket itself: the same template and
   * payload as the WebP (without its drop shadow, so the PDF stays vector and small, with
   * clickable sponsor links), rendered through the shared browser queue. No filesystem
   * writes. The organizer's ticket registry serves it for entrance checks.
   */
  async getTicketPdfBuffer(
    id: number,
    locale: TicketEmailLocale,
  ): Promise<Buffer> {
    const context = await this.resolveContext(id);
    const { tickets: templateTickets, doc } = await this.buildTemplatePayload({
      ...context,
      locale,
    });
    const html = await this.renderTicketHtml(templateTickets, { pdf: true });
    const pdfBuffer = await this.puppeteerBrowser.capturePdfFromHtml(html);
    if (!pdfBuffer?.length) {
      throw new Error(`ticket_pdf_empty orderId=${doc.orderId} ticketId=${doc.id}`);
    }
    this.logger.debug(
      `Ticket PDF orderId=${doc.orderId} ticketId=${doc.id} bytes=${pdfBuffer.length}`,
    );
    return pdfBuffer;
  }

  private async saveWebP(
    ctx: { event: IEvent; ticket: ITicket; mockOrder?: MockOrderRef },
    locale: TicketEmailLocale,
  ): Promise<{ buffer: Buffer; absolutePath: string; filename: string }> {
    const { buffer: webpBuffer, eventTitle, doc } = await this.buildTicketWebPResult(
      ctx,
      locale,
    );
    const eventDir = this.sanitizePathSegment(eventTitle);
    const targetDir = path.join(this.getTicketPdfRootDir(), eventDir);
    await fs.mkdir(targetDir, { recursive: true });
    const filename = `${doc.orderId}-ticket-${doc.id}.webp`;
    const absolutePath = path.join(targetDir, filename);
    await fs.writeFile(absolutePath, webpBuffer);
    return { buffer: webpBuffer, absolutePath, filename };
  }

  private async savePdf(
    ctx: { event: IEvent; ticket: ITicket; mockOrder?: MockOrderRef },
    locale: TicketEmailLocale,
  ): Promise<{ buffer: Buffer; absolutePath: string; filename: string }> {
    const { tickets: templateTickets, doc, eventTitle } =
      await this.buildTemplatePayload({ ...ctx, locale });

    const htmlForPdf = await this.renderTicketHtml(templateTickets, { pdf: true });
    const raw = await this.renderHtmlToTicketPdf(htmlForPdf);
    const pdfBuffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
    if (pdfBuffer.length === 0) {
      throw new Error(`ticket_pdf_empty orderId=${doc.orderId} ticketId=${doc.id}`);
    }
    this.logger.debug(
      `Ticket PDF orderId=${doc.orderId} ticketId=${doc.id} bytes=${pdfBuffer.length}`,
    );

    const eventDir = this.sanitizePathSegment(eventTitle);
    const targetDir = path.join(this.getTicketPdfRootDir(), eventDir);
    await fs.mkdir(targetDir, { recursive: true });
    const filename = `${doc.orderId}-ticket-${doc.id}.pdf`;
    const absolutePath = path.join(targetDir, filename);
    await fs.writeFile(absolutePath, pdfBuffer);

    return { buffer: pdfBuffer, absolutePath, filename };
  }

  private openFileInDefaultBrowser(absolutePath: string): void {
    const fileUrl = pathToFileURL(absolutePath).href;
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', fileUrl], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [fileUrl], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [fileUrl], { detached: true, stdio: 'ignore' }).unref();
    }
  }

  async buildTicketWebPWithPuppeteer(
    id: number,
    locale: TicketEmailLocale,
  ): Promise<{ buffer: Buffer; absolutePath: string; filename: string }> {
    const ctx = await this.resolveContext(id);
    return this.saveWebP(ctx, locale);
  }

  // async buildTicketPdfWithPuppeteer2(
  //   id: number,
  //   locale: TicketEmailLocale,
  // ): Promise<{ buffer: Buffer; absolutePath: string; filename: string }> {
  //   const ctx = await this.resolveContext(id);
  //   return this.savePdf(ctx, locale);
  // }

  /**
   * Writes rendered ticket HTML to a temp file and opens it in the default browser (layout debugging).
   */
  async getTicketByIdAndOpenPreview(
    id: number,
    locale: TicketEmailLocale,
  ): Promise<{ absolutePath: string }> {
    const { ticket, event, mockOrder } = await this.resolveContext(id);
    const { tickets: templateTickets } = await this.buildTemplatePayload({
      locale,
      event,
      ticket,
      mockOrder,
    });
    const html = await this.renderTicketHtml(templateTickets);
    const absolutePath = path.join(
      os.tmpdir(),
      `ticket-preview-${ticket.id}-${Date.now()}.html`,
    );
    await fs.writeFile(absolutePath, html, 'utf8');
    this.openFileInDefaultBrowser(absolutePath);
    return { absolutePath };
  }
}


// Re-export locale type for consumers that only import the puppeteer module
export type { TicketEmailLocale } from './locale/ticket.locale';
