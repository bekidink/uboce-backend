import { Controller, Get, Headers, HttpCode, Param, Post, type RawBodyRequest, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import { Public, RequiresPlatformRole } from '@uboce/common';
import type { Request } from 'express';

import { CallbacksService } from './callbacks.service.js';

@ApiTags('integrations')
@Controller('integrations')
export class CallbacksController {
  constructor(private readonly callbacks: CallbacksService) {}

  /**
   * Webhook endpoint for a configured provider. Authenticated by signature,
   * not by a user token. Answers 200 for processed or duplicate events.
   */
  @Public()
  @ApiHeader({ name: 'x-uboce-timestamp', required: true, description: 'Unix seconds' })
  @ApiHeader({ name: 'x-uboce-signature', required: true, description: 'sha256=<hex HMAC of "<timestamp>.<raw body>">' })
  @Post('callbacks/:provider')
  @HttpCode(200)
  callback(
    @Param('provider') provider: string,
    @Headers('x-uboce-timestamp') timestamp: string | undefined,
    @Headers('x-uboce-signature') signature: string | undefined,
    @Req() req: RawBodyRequest<Request>,
  ) {
    return this.callbacks.handle(provider, { timestamp, signature }, req.rawBody);
  }

  @ApiBearerAuth()
  @RequiresPlatformRole('support')
  @Get('health')
  health() {
    return this.callbacks.health();
  }
}
