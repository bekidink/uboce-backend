import { createHash, timingSafeEqual } from 'node:crypto';

import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { ThrottlerGuard } from '@nestjs/throttler';
import { AppError, Internal, notFound, Public } from '@uboce/common';
import type { InternalUser } from '@uboce/contracts';
import { IsEmail, IsString, Length, MaxLength } from 'class-validator';

import { env, serviceClients } from '../config.js';
import type { User } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma.service.js';
import { SessionsService } from '../tokens/tokens.module.js';

class ServiceTokenRequestDto {
  @IsString()
  @Length(2, 50)
  clientId: string;

  @IsString()
  @Length(32, 200)
  clientSecret: string;
}

class FindUserQueryDto {
  @IsEmail()
  @MaxLength(254)
  email: string;
}

const toInternalUser = (user: User): InternalUser => ({
  id: user.id,
  email: user.email,
  emailVerified: !!user.emailVerifiedAt,
  mfaEnabled: !!user.mfaEnabledAt,
  phone: user.phone,
  displayName: user.displayName,
  locale: user.locale,
  status: user.status,
});

/** Service-to-service API. Never routed by the gateway. */
@ApiExcludeController()
@Controller('internal')
export class InternalController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionsService,
  ) {}

  /** Client-credentials exchange: a registered service trades its secret for a short-lived service token. */
  @Public()
  @UseGuards(ThrottlerGuard)
  @Post('token')
  @HttpCode(200)
  async token(@Body() dto: ServiceTokenRequestDto) {
    const expected = serviceClients.get(dto.clientId);
    const actual = createHash('sha256').update(dto.clientSecret).digest();
    if (!expected || !timingSafeEqual(Buffer.from(expected, 'hex'), actual)) {
      throw new AppError(401, 'invalid_client', 'Unknown service or wrong secret');
    }
    return {
      accessToken: await this.sessions.signer.signService(dto.clientId),
      tokenType: 'Bearer',
      expiresIn: env.SERVICE_TOKEN_TTL_SECONDS,
    };
  }

  @Internal()
  @Get('users/:userId')
  async getUser(@Param('userId', new ParseUUIDPipe()) userId: string): Promise<InternalUser> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw notFound('User');
    return toInternalUser(user);
  }

  @Internal('organization', 'administration')
  @Get('users')
  async findByEmail(@Query() query: FindUserQueryDto): Promise<InternalUser> {
    const user = await this.prisma.user.findUnique({ where: { email: query.email.toLowerCase() } });
    if (!user) throw notFound('User');
    return toInternalUser(user);
  }
}
