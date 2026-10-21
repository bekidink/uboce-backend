import { Body, Controller, Get, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiExtraModels, ApiOkResponse, ApiTags, getSchemaPath } from '@nestjs/swagger';
import { ThrottlerGuard } from '@nestjs/throttler';
import { type AuthUser, CurrentUser, Public } from '@uboce/common';
import type { Request } from 'express';

import type { RequestMeta, TokenResponse } from '../tokens/tokens.module.js';
import {
  LoginDto,
  MfaChallengeDto,
  RefreshDto,
  RegisterDto,
  TokenResponseDto,
  type UserProfileDto,
  VerifyMfaDto,
} from './auth.dto.js';
import { AuthService } from './auth.service.js';

const metaOf = (req: Request): RequestMeta => ({ ipAddress: req.ip, userAgent: req.headers['user-agent'] });

@ApiTags('auth')
@ApiExtraModels(TokenResponseDto, MfaChallengeDto)
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @UseGuards(ThrottlerGuard)
  @Post('register')
  register(@Body() dto: RegisterDto, @Req() req: Request): Promise<TokenResponse> {
    return this.auth.register(dto, metaOf(req));
  }

  /** Returns tokens, or `{ mfaRequired: true, mfaToken }` when the account has two-factor sign-in. */
  @Public()
  @UseGuards(ThrottlerGuard)
  @Post('login')
  @HttpCode(200)
  @ApiOkResponse({ schema: { oneOf: [{ $ref: getSchemaPath(TokenResponseDto) }, { $ref: getSchemaPath(MfaChallengeDto) }] } })
  login(@Body() dto: LoginDto, @Req() req: Request) {
    return this.auth.login(dto, metaOf(req));
  }

  @Public()
  @UseGuards(ThrottlerGuard)
  @Post('mfa/verify')
  @HttpCode(200)
  verifyMfa(@Body() dto: VerifyMfaDto, @Req() req: Request): Promise<TokenResponse> {
    return this.auth.verifyMfa(dto, metaOf(req));
  }

  @Public()
  @UseGuards(ThrottlerGuard)
  @Post('refresh')
  @HttpCode(200)
  refresh(@Body() dto: RefreshDto, @Req() req: Request): Promise<TokenResponse> {
    return this.auth.refresh(dto.refreshToken, metaOf(req));
  }

  @ApiBearerAuth()
  @Post('logout')
  @HttpCode(204)
  async logout(@CurrentUser() user: AuthUser, @Req() req: Request) {
    await this.auth.logout(user.userId, user.sessionId, metaOf(req));
  }

  @ApiBearerAuth()
  @Post('logout-all')
  @HttpCode(204)
  async logoutAll(@CurrentUser() user: AuthUser, @Req() req: Request) {
    await this.auth.logoutAll(user.userId, metaOf(req));
  }

  @ApiBearerAuth()
  @Get('me')
  me(@CurrentUser() user: AuthUser): Promise<UserProfileDto> {
    return this.auth.profile(user.userId);
  }
}
