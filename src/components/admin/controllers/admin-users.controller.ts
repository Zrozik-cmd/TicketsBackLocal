import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { Response } from "express";
import type { Request } from "express";
import { ADMIN_ID_KEY } from "../guards/admin.guard";
import { ReviewOrganizerDto } from "../dto/review-organizer.dto";
import { AdminGuard } from "../guards/admin.guard";
import { AdminUsersService } from "../services/admin-users.service";
import { AdminUsersQueryDto } from "../dto/admin-users-query.dto";
import { AdminUserEventsQueryDto } from "../dto/admin-user-events-query.dto";

@Controller("admin/users")
@UseGuards(AdminGuard)
export class AdminUsersController {
  constructor(private readonly adminUsersService: AdminUsersService) {}

  @Get()
  getUsers(@Query() query: AdminUsersQueryDto) {
    return this.adminUsersService.getUsers(query);
  }

  /** Счётчик заявок на проверке — красный кружок в сайдбаре. */
  @Get("verification/pending-count")
  getPendingVerificationCount() {
    return this.adminUsersService.getPendingVerificationCount();
  }

  @Get(":id/events/stats")
  getEventsStats(@Param("id", ParseIntPipe) userId: number) {
    return this.adminUsersService.getEventsStats(userId);
  }

  @Get(":id/events")
  getUserEvents(
    @Param("id", ParseIntPipe) userId: number,
    @Query() query: AdminUserEventsQueryDto,
  ) {
    return this.adminUsersService.getUserEvents(userId, query);
  }

  /** Выписка DBD организатора — только админу, стримом, без кеша. */
  @Get(":id/dbd-document")
  async getDbdDocument(
    @Param("id", ParseIntPipe) id: number,
    @Res() res: Response,
  ) {
    const doc = await this.adminUsersService.getOrganizerDbdDocument(id);
    res.setHeader("Content-Type", doc.mimeType);
    res.setHeader(
      "Content-Disposition",
      `inline; filename="dbd-${id}.pdf"`,
    );
    // Документ компании не должен оседать в промежуточных кешах.
    res.setHeader("Cache-Control", "no-store");
    return res.send(doc.file);
  }

  /** Решение по заявке: подтвердить или отклонить с причиной. */
  @Post(":id/verification")
  reviewOrganizer(
    @Req() req: Request,
    @Param("id", ParseIntPipe) id: number,
    @Body() dto: ReviewOrganizerDto,
  ) {
    const reviewer = (req as unknown as Record<string, string>)[ADMIN_ID_KEY];
    return this.adminUsersService.reviewOrganizer(
      id,
      dto.action,
      reviewer ?? "admin",
      dto.reason,
    );
  }

  @Get(":id")
  getUserById(@Param("id", ParseIntPipe) id: number) {
    return this.adminUsersService.getUserById(id);
  }
}
