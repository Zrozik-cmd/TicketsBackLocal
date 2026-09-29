import { Body, Controller, Get, HttpCode, Param, ParseIntPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Request } from 'express';

import { USER_ID_KEY } from '../../users/guards/user.guard';
import { UserOrManagerGuard } from '../../users/guards/user-or-manager.guard';
import { MANAGER_ID_KEY } from '../../managers/guards/manager.guard';
import { SeatingPlanService, type Field } from '../services/seating-plan.service';
import { SeatingPlanPublishService } from '../services/seating-plan-publish.service';
import { SeatingPlanNodesService } from '../services/seating-plan-nodes.service';
import { SeatingPlanRowsService } from '../services/seating-plan-rows.service';
import { SeatingPlanTotalsService } from '../services/seating-plan-totals.service';
import {
  BulkUpdateNodesDto,
  BulkUpdateRowsDto,
  BulkUpdateSeatsDto,
  ClearCanvasDto,
  CreateNodeDto,
  CreatePlanDto,
  CreateRoomDto,
  DeletePlanDto,
  DeleteRoomDto,
  DuplicatePlanDto,
  ExpandSectorDto,
  GetPlanDto,
  ListPlansDto,
  NodeIdDto,
  NodePhotoDto,
  PatchPublishedDto,
  PublishPlanDto,
  ReparentNodeDto,
  ResetSeatDto,
  SavePlanDto,
  SummaryDto,
  UnpublishPlanDto,
  UpdateNodeDto,
  UpdatePlanDto,
  UpdateRoomDto,
  UpdateRowDto,
  UpdateSeatDto,
} from '../dto/seating-plan.dto';
import { SeatingPlanMapService } from '../services/seating-plan-map.service';

/** Владелец плана — организатор; менеджер Admin работает от имени создавшего его организатора. */
function fieldOf(req: Request): Field {
  return { creator: Number((req as any)[USER_ID_KEY]) };
}

function actorOf(req: Request): string {
  const managerId = (req as any)[MANAGER_ID_KEY] as string | undefined;
  return managerId ? `manager:${managerId}` : `user:${(req as any)[USER_ID_KEY]}`;
}

/**
 * Конструктор схемы зала в кабинете организатора. Контракт ручек — как в Tentai
 * (`/seating-plan/create`, `/get`, `/node/create`…), чтобы конструктор перенёсся 1 в 1.
 * Доступ — как к созданию события: организатор или его менеджер Admin.
 */
@Controller('seating-plan')
@UseGuards(UserOrManagerGuard(['Admin']))
export class SeatingPlanController {
  constructor(
    private readonly service: SeatingPlanService,
    private readonly nodes: SeatingPlanNodesService,
    private readonly rows: SeatingPlanRowsService,
    private readonly totals: SeatingPlanTotalsService,
    private readonly publish: SeatingPlanPublishService,
  ) {}

  /* ---------------------------------------------------------------- проект */

  @Post('create')
  @HttpCode(200)
  Create(@Req() req: Request, @Body() body: CreatePlanDto) {
    return this.service.Create({ ...body, field: fieldOf(req), createdBy: actorOf(req) });
  }

  @Get('get')
  Get(@Req() req: Request, @Query() query: GetPlanDto) {
    return this.service.Get({ ...query, field: fieldOf(req) });
  }

  @Post('update')
  @HttpCode(200)
  Update(@Req() req: Request, @Body() body: UpdatePlanDto) {
    return this.service.Update({ ...body, field: fieldOf(req) });
  }

  @Post('save')
  @HttpCode(200)
  Save(@Req() req: Request, @Body() body: SavePlanDto) {
    return this.service.Save({ ...body, field: fieldOf(req) });
  }

  @Post('duplicate')
  @HttpCode(200)
  Duplicate(@Req() req: Request, @Body() body: DuplicatePlanDto) {
    return this.service.Duplicate({ ...body, field: fieldOf(req) });
  }

  @Post('delete')
  @HttpCode(200)
  Delete(@Req() req: Request, @Body() body: DeletePlanDto) {
    return this.service.Delete({ ...body, field: fieldOf(req) });
  }

  @Post('publish')
  @HttpCode(200)
  Publish(@Req() req: Request, @Body() body: PublishPlanDto) {
    return this.publish.Publish({ ...body, field: fieldOf(req) });
  }

  @Post('publish/patch')
  @HttpCode(200)
  PatchPublished(@Req() req: Request, @Body() body: PatchPublishedDto) {
    return this.publish.PatchPublished({ ...body, field: fieldOf(req) });
  }

  @Post('unpublish')
  @HttpCode(200)
  Unpublish(@Req() req: Request, @Body() body: UnpublishPlanDto) {
    return this.publish.Unpublish({ ...body, field: fieldOf(req) });
  }

  @Get('list')
  List(@Req() req: Request, @Query() query: ListPlansDto) {
    return this.service.List({ ...query, field: fieldOf(req) });
  }

  @Get('summary')
  Summary(@Req() req: Request, @Query() query: SummaryDto) {
    return this.totals.Summary({ ...query, field: fieldOf(req) });
  }

  /* --------------------------------------------------------------- холсты */

  @Post('clear')
  @HttpCode(200)
  ClearCanvas(@Req() req: Request, @Body() body: ClearCanvasDto) {
    return this.service.ClearCanvas({ ...body, field: fieldOf(req) });
  }

  @Post('room/create')
  @HttpCode(200)
  CreateRoom(@Req() req: Request, @Body() body: CreateRoomDto) {
    return this.service.CreateRoom({ ...body, field: fieldOf(req) });
  }

  @Post('room/update')
  @HttpCode(200)
  UpdateRoom(@Req() req: Request, @Body() body: UpdateRoomDto) {
    return this.service.UpdateRoom({ ...body, field: fieldOf(req) });
  }

  @Post('room/delete')
  @HttpCode(200)
  DeleteRoom(@Req() req: Request, @Body() body: DeleteRoomDto) {
    return this.service.DeleteRoom({ ...body, field: fieldOf(req) });
  }

  /* ----------------------------------------------------------------- узлы */

  @Post('node/create')
  @HttpCode(200)
  CreateNode(@Req() req: Request, @Body() body: CreateNodeDto) {
    return this.nodes.CreateNode({ ...body, field: fieldOf(req) });
  }

  @Post('node/update')
  @HttpCode(200)
  UpdateNode(@Req() req: Request, @Body() body: UpdateNodeDto) {
    return this.nodes.UpdateNode({ ...body, field: fieldOf(req) });
  }

  @Post('node/bulk-update')
  @HttpCode(200)
  BulkUpdateNodes(@Req() req: Request, @Body() body: BulkUpdateNodesDto) {
    return this.nodes.BulkUpdateNodes({ ...body, field: fieldOf(req) });
  }

  @Post('node/duplicate')
  @HttpCode(200)
  DuplicateNode(@Req() req: Request, @Body() body: NodeIdDto) {
    return this.nodes.DuplicateNode({ ...body, field: fieldOf(req) });
  }

  @Post('node/reparent')
  @HttpCode(200)
  ReparentNode(@Req() req: Request, @Body() body: ReparentNodeDto) {
    return this.nodes.ReparentNode({ ...body, field: fieldOf(req) });
  }

  @Post('node/photo')
  @HttpCode(200)
  NodePhoto(@Req() req: Request, @Body() body: NodePhotoDto) {
    return this.nodes.SetNodePhoto({ ...body, field: fieldOf(req) });
  }

  @Post('node/delete')
  @HttpCode(200)
  DeleteNode(@Req() req: Request, @Body() body: NodeIdDto) {
    return this.nodes.DeleteNode({ ...body, field: fieldOf(req) });
  }

  /* ------------------------------------------------------- ряды и места */

  @Post('row/update')
  @HttpCode(200)
  UpdateRow(@Req() req: Request, @Body() body: UpdateRowDto) {
    return this.rows.UpdateRow({ ...body, field: fieldOf(req) });
  }

  @Post('row/bulk-update')
  @HttpCode(200)
  BulkUpdateRows(@Req() req: Request, @Body() body: BulkUpdateRowsDto) {
    return this.rows.BulkUpdateRows({ ...body, field: fieldOf(req) });
  }

  @Post('seat/update')
  @HttpCode(200)
  UpdateSeat(@Req() req: Request, @Body() body: UpdateSeatDto) {
    return this.rows.UpdateSeat({ ...body, field: fieldOf(req) });
  }

  @Post('seat/bulk-update')
  @HttpCode(200)
  BulkUpdateSeats(@Req() req: Request, @Body() body: BulkUpdateSeatsDto) {
    return this.rows.BulkUpdateSeats({ ...body, field: fieldOf(req) });
  }

  @Post('seat/reset')
  @HttpCode(200)
  ResetSeat(@Req() req: Request, @Body() body: ResetSeatDto) {
    return this.rows.ResetSeat({ ...body, field: fieldOf(req) });
  }

  @Get('sector/expand')
  ExpandSector(@Req() req: Request, @Query() query: ExpandSectorDto) {
    return this.rows.ExpandSector({ ...query, field: fieldOf(req) });
  }
}

/**
 * Без гарда: справочники нужны конструктору до входа, а опубликованная схема —
 * странице события на витрине.
 */
@Controller('seating-plan')
export class SeatingPlanPublicController {
  constructor(
    private readonly service: SeatingPlanService,
    private readonly map: SeatingPlanMapService,
  ) {}

  @Get('dictionaries')
  Dictionaries() {
    return this.service.Dictionaries();
  }

  @Get('public/:eventId')
  PublicMap(@Param('eventId', ParseIntPipe) eventId: number) {
    return this.map.BookingMap(eventId);
  }
}
