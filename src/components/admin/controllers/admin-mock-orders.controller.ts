import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import { AdminGuard, ADMIN_ID_KEY, type AdminAuthenticatedRequest } from "../guards/admin.guard";
import { AdminMockOrdersService } from "@/components/admin/services/admin-mock-orders.service";
import { RefundMockOrdersDto } from "@/components/admin/dto/cancel-mock-orders.dto";
import { AdminResendOrderTicketsDto } from "@/components/admin/dto/resend-order-tickets.dto";

@Controller("admin/mock-orders")
@UseGuards(AdminGuard)
export class AdminMockOrdersController {
  constructor(private readonly adminMockOrdersService: AdminMockOrdersService) {}

  @Get(':orderId/refund-details')
  getRefundDetails(@Param('orderId', ParseIntPipe) orderId: number) {
    return this.adminMockOrdersService.getRefundDetails(orderId);
  }

  @Post('/start-refund-mock-orders')
  startRefundMockOrders(
    @Req() req: AdminAuthenticatedRequest,
    @Body() body: RefundMockOrdersDto,
  ) {
    return this.adminMockOrdersService.startRefundMockOrders(body, req[ADMIN_ID_KEY]);
  }

  @Post('/complete-refund-mock-orders')
  completeRefundMockOrders(
    @Req() req: AdminAuthenticatedRequest,
    @Body() body: RefundMockOrdersDto,
  ) {
    return this.adminMockOrdersService.completeRefundMockOrders(body, req[ADMIN_ID_KEY]);
  }

  @Post('/cancel-refund-mock-orders')
  cancelMockOrderRefund(
    @Req() req: AdminAuthenticatedRequest,
    @Body() body: RefundMockOrdersDto,
  ) {
    return this.adminMockOrdersService.cancelMockOrderRefund(body, req[ADMIN_ID_KEY]);
  }

  @Post('/resend-tickets')
  resendTickets(@Body() body: AdminResendOrderTicketsDto) {
    return this.adminMockOrdersService.resendTicketsToEmail(body);
  }

  // @Get(":id/events/stats")
  // getEventsStats(@Param("id", ParseIntPipe) userId: number) {
  //   return this.adminUsersService.getEventsStats(userId);
  // }
  //
  // @Get(":id/events")
  // getUserEvents(
  //   @Param("id", ParseIntPipe) userId: number,
  //   @Query() query: AdminUserEventsQueryDto,
  // ) {
  //   return this.adminUsersService.getUserEvents(userId, query);
  // }
  //
  // @Get(":id")
  // getUserById(@Param("id", ParseIntPipe) id: number) {
  //   return this.adminUsersService.getUserById(id);
  // }
}
