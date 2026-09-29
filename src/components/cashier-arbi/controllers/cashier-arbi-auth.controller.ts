import { Body, Controller, Post } from '@nestjs/common';
import { CashierArbiService } from '../cashier-arbi.service';
import { CashierArbiSignInDto } from '../dto/cashier-arbi-sign-in.dto';

@Controller('cashiers/auth')
export class CashierArbiAuthController {
  constructor(private readonly cashierArbiService: CashierArbiService) {}

  @Post('sign-in')
  signIn(@Body() dto: CashierArbiSignInDto) {
    return this.cashierArbiService.signIn(dto.email, dto.password);
  }

  @Post('refresh')
  refresh(@Body('refreshToken') refreshToken: string) {
    return this.cashierArbiService.refreshAccessToken(refreshToken);
  }
}
