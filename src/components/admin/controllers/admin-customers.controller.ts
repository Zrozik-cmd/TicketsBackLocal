import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { AdminGuard } from "../guards/admin.guard";
import { AdminCustomersService } from "../services/admin-customers.service";
import { AdminCustomersQueryDto } from "../dto/admin-customers-query.dto";

@Controller("admin/customers")
@UseGuards(AdminGuard)
export class AdminCustomersController {
  constructor(private readonly adminCustomersService: AdminCustomersService) {}

  @Get()
  getCustomers(@Query() query: AdminCustomersQueryDto) {
    return this.adminCustomersService.getCustomers(query);
  }
}
