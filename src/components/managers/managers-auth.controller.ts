import { BadRequestException, Body, Controller, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import { ManagerRefreshTokenDto } from './dto/refresh-token.dto';
import { SendManagerEmailCodeDto } from './dto/send-email-code.dto';
import { ManagerSignInWithPinDto } from './dto/sign-in-with-pin.dto';
import { ManagersAuthService } from './managers-auth.service';

@Controller('managers/auth')
export class ManagersAuthController {
  constructor(private readonly managersAuthService: ManagersAuthService) {}

  @Post('send-email-code')
  async sendEmailCode(@Body() _dto: SendManagerEmailCodeDto) {
    throw new BadRequestException('deprecated');
  }

  @Post('sign-in-with-code')
  signInWithCode(@Req() req: Request, @Body() dto: ManagerSignInWithPinDto) {
    const forwarded = (req.headers['x-forwarded-for'] ?? '') as string;
    const ip = forwarded.split(',')[0]?.trim() || req.ip || '';
    return this.managersAuthService.signInWithPin({
      pin: dto.pin,
      ip,
    });
  }

  @Post('sign-in-with-pin')
  signInWithPin(@Req() req: Request, @Body() dto: ManagerSignInWithPinDto) {
    const forwarded = (req.headers['x-forwarded-for'] ?? '') as string;
    const ip = forwarded.split(',')[0]?.trim() || req.ip || '';
    return this.managersAuthService.signInWithPin({
      pin: dto.pin,
      ip,
    });
  }

  @Post('refresh')
  refresh(@Body() dto: ManagerRefreshTokenDto) {
    return this.managersAuthService.refreshAccessToken(dto.refreshToken);
  }
}
