import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { type AuthUser, CurrentUser, PaginationQueryDto } from '@uboce/common';

import { AcceptInvitationDto, CreateInvitationDto } from './invitations.dto.js';
import { InvitationsService } from './invitations.service.js';

const OrgId = () => Param('organizationId', new ParseUUIDPipe());

@ApiTags('invitations')
@ApiBearerAuth()
@Controller()
export class InvitationsController {
  constructor(private readonly invitations: InvitationsService) {}

  @Post('organizations/:organizationId/invitations')
  create(@CurrentUser() user: AuthUser, @OrgId() organizationId: string, @Body() dto: CreateInvitationDto) {
    return this.invitations.create(user.userId, organizationId, dto);
  }

  @Get('organizations/:organizationId/invitations')
  list(@CurrentUser() user: AuthUser, @OrgId() organizationId: string, @Query() query: PaginationQueryDto) {
    return this.invitations.list(user.userId, organizationId, query);
  }

  @Delete('organizations/:organizationId/invitations/:invitationId')
  @HttpCode(204)
  async revoke(
    @CurrentUser() user: AuthUser,
    @OrgId() organizationId: string,
    @Param('invitationId', new ParseUUIDPipe()) invitationId: string,
  ) {
    await this.invitations.revoke(user.userId, organizationId, invitationId);
  }

  @Post('invitations/accept')
  accept(@CurrentUser() user: AuthUser, @Body() dto: AcceptInvitationDto) {
    return this.invitations.accept(user.userId, dto.token);
  }
}
