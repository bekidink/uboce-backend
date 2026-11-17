import { Body, Controller, Headers, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ThrottlerGuard } from '@nestjs/throttler';
import { type AuthUser, CurrentUser, Public } from '@uboce/common';
import { IsString, Length, Matches } from 'class-validator';
import type { Request } from 'express';

import type { RequestMeta } from '../tokens/tokens.module.js';
import { PhoneService } from './phone.service.js';

const metaOf = (req: Request): RequestMeta => ({ ipAddress: req.ip, userAgent: req.headers['user-agent'] });

class PhoneDto {
  /** e.g. 0911234567 or +251911234567 */
  @IsString()
  @Length(7, 20)
  phone: string;
}

class PhoneCodeDto extends PhoneDto {
  @Matches(/^\d{6}$/)
  code: string;
}

/** Phone verification and phone sign-in by SMS code (PRD v2 ORG-01, NTF-03). */
@ApiTags('auth')
@Controller('auth')
export class PhoneController {
  constructor(private readonly phones: PhoneService) {}

  @ApiBearerAuth()
  @UseGuards(ThrottlerGuard)
  @Post('phone/start')
  @HttpCode(202)
  start(@CurrentUser() user: AuthUser, @Body() dto: PhoneDto, @Req() req: Request) {
    return this.phones.startVerification(user.userId, dto.phone, metaOf(req));
  }

  @ApiBearerAuth()
  @UseGuards(ThrottlerGuard)
  @Post('phone/verify')
  @HttpCode(200)
  verify(@CurrentUser() user: AuthUser, @Body() dto: PhoneCodeDto, @Req() req: Request) {
    return this.phones.confirmVerification(user.userId, dto.phone, dto.code, metaOf(req));
  }

  /** Sends a sign-in code. Send the Turnstile token in X-Captcha-Token when bot protection is on. */
  @Public()
  @UseGuards(ThrottlerGuard)
  @Post('login/phone')
  @HttpCode(202)
  startLogin(@Body() dto: PhoneDto, @Req() req: Request, @Headers('x-captcha-token') captcha?: string) {
    return this.phones.startLogin(dto.phone, captcha, metaOf(req));
  }

  /** Returns tokens, or `{ mfaRequired: true, mfaToken }` to finish with /auth/mfa/verify. */
  @Public()
  @UseGuards(ThrottlerGuard)
  @Post('login/phone/verify')
  @HttpCode(200)
  verifyLogin(@Body() dto: PhoneCodeDto, @Req() req: Request) {
    return this.phones.verifyLogin(dto.phone, dto.code, metaOf(req));
  }
}
