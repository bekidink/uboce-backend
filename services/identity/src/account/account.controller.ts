import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { ThrottlerGuard } from '@nestjs/throttler';
import { type AuthUser, CurrentUser, Public } from '@uboce/common';
import type { Request } from 'express';

import type { RequestMeta } from '../tokens/tokens.module.js';
import {
  ChangePasswordDto,
  CloseAccountDto,
  ForgotPasswordDto,
  MfaCodeDto,
  type MfaSetupDto,
  type RecoveryCodesDto,
  ResetPasswordDto,
  type SessionDto,
  TokenDto,
  UpdateProfileDto,
} from './account.dto.js';
import { AccountService } from './account.service.js';

const metaOf = (req: Request): RequestMeta => ({ ipAddress: req.ip, userAgent: req.headers['user-agent'] });

@ApiTags('account')
@Controller('auth')
export class AccountController {
  constructor(private readonly account: AccountService) {}

  @Public()
  @UseGuards(ThrottlerGuard)
  @Post('email/verify')
  @HttpCode(204)
  async verifyEmail(@Body() dto: TokenDto, @Req() req: Request) {
    await this.account.verifyEmail(dto.token, metaOf(req));
  }

  @ApiBearerAuth()
  @UseGuards(ThrottlerGuard)
  @Post('email/resend')
  @HttpCode(204)
  async resendVerification(@CurrentUser() user: AuthUser) {
    await this.account.resendVerification(user.userId);
  }

  /** Always 202, whether or not the email has an account. */
  @Public()
  @UseGuards(ThrottlerGuard)
  @Post('password/forgot')
  @HttpCode(202)
  async forgotPassword(@Body() dto: ForgotPasswordDto, @Req() req: Request) {
    await this.account.forgotPassword(dto.email, metaOf(req));
  }

  @Public()
  @UseGuards(ThrottlerGuard)
  @Post('password/reset')
  @HttpCode(204)
  async resetPassword(@Body() dto: ResetPasswordDto, @Req() req: Request) {
    await this.account.resetPassword(dto.token, dto.newPassword, metaOf(req));
  }

  @ApiBearerAuth()
  @UseGuards(ThrottlerGuard)
  @Post('password/change')
  @HttpCode(204)
  async changePassword(@CurrentUser() user: AuthUser, @Body() dto: ChangePasswordDto, @Req() req: Request) {
    await this.account.changePassword(user.userId, user.sessionId, dto.currentPassword, dto.newPassword, metaOf(req));
  }

  @ApiBearerAuth()
  @Post('mfa/setup')
  startMfaSetup(@CurrentUser() user: AuthUser): Promise<MfaSetupDto> {
    return this.account.startMfaSetup(user.userId);
  }

  @ApiBearerAuth()
  @UseGuards(ThrottlerGuard)
  @Post('mfa/enable')
  enableMfa(@CurrentUser() user: AuthUser, @Body() dto: MfaCodeDto, @Req() req: Request): Promise<RecoveryCodesDto> {
    return this.account.enableMfa(user.userId, dto.code, metaOf(req));
  }

  @ApiBearerAuth()
  @UseGuards(ThrottlerGuard)
  @Post('mfa/disable')
  @HttpCode(204)
  async disableMfa(@CurrentUser() user: AuthUser, @Body() dto: MfaCodeDto, @Req() req: Request) {
    await this.account.disableMfa(user.userId, dto.code, metaOf(req));
  }

  /** Change name, phone or language. */
  @ApiBearerAuth()
  @Patch('me')
  @HttpCode(204)
  async updateProfile(@CurrentUser() user: AuthUser, @Body() dto: UpdateProfileDto, @Req() req: Request) {
    await this.account.updateProfile(user.userId, dto, metaOf(req));
  }

  /** Devices signed in to this account. */
  @ApiBearerAuth()
  @Get('sessions')
  sessions(@CurrentUser() user: AuthUser): Promise<SessionDto[]> {
    return this.account.listSessions(user.userId, user.sessionId);
  }

  /** Signs one device out. */
  @ApiBearerAuth()
  @Delete('sessions/:sessionId')
  @HttpCode(204)
  async revokeSession(@CurrentUser() user: AuthUser, @Param('sessionId', new ParseUUIDPipe()) sessionId: string, @Req() req: Request) {
    await this.account.revokeSession(user.userId, sessionId, metaOf(req));
  }

  /** Closes the account permanently (password, and the authenticator code when two-factor is on). */
  @ApiBearerAuth()
  @UseGuards(ThrottlerGuard)
  @Post('account/close')
  @HttpCode(204)
  async close(@CurrentUser() user: AuthUser, @Body() dto: CloseAccountDto, @Req() req: Request) {
    await this.account.closeAccount(user.userId, dto.password, dto.mfaCode, metaOf(req));
  }
}
