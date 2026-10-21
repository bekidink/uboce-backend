import {
  BadRequestException,
  Body,
  type CanActivate,
  Controller,
  Delete,
  type ExecutionContext,
  Get,
  Headers,
  HttpCode,
  Injectable,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { AppError, type AuthUser, CurrentUser, Internal, PaginationQueryDto } from '@uboce/common';
import type { InternalPlatformRoles } from '@uboce/contracts';

import type { Prisma } from '../generated/prisma/client.js';
import { AuditQueryDto, GrantRoleDto, KEY_PATTERN, OrganizationStatusDto, PutFlagDto, PutSettingDto, ReasonDto } from './admin.dto.js';
import { AdminService } from './admin.service.js';

const why = (dto: ReasonDto) => ({ reasonCode: dto.reasonCode, reason: dto.reason.trim() });
const key = (value: string) => {
  if (!KEY_PATTERN.test(value)) throw new BadRequestException('Keys are lowercase, e.g. procurement.require_verified_suppliers');
  return value;
};

/** Platform administrators only (with MFA, unless REQUIRE_STAFF_MFA=false). */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  constructor(private readonly admin: AdminService) {}

  async canActivate(ctx: ExecutionContext) {
    const user = ctx.switchToHttp().getRequest().user as AuthUser;
    const { roles, blockedReason } = await this.admin.effectiveRoles(user.userId);
    if (roles.includes('platform_admin')) return true;
    if (blockedReason === 'mfa_required') {
      throw new AppError(403, 'mfa_required', 'Turn on two-factor sign-in to use staff tools');
    }
    throw new AppError(403, 'forbidden', 'Platform administrators only');
  }
}

@ApiTags('administration')
@ApiBearerAuth()
@Controller('admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  /** Your own platform roles (empty for ordinary users). */
  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return this.admin.effectiveRoles(user.userId);
  }

  /** Feature flags as your organization sees them. */
  @Get('feature-flags/evaluate')
  evaluate(@Headers('x-organization-id') organizationId?: string) {
    return this.admin.evaluateFlags(organizationId && /^[0-9a-f-]{36}$/i.test(organizationId) ? organizationId : null);
  }

  @UseGuards(PlatformAdminGuard)
  @Get('staff')
  staff(@Query() query: PaginationQueryDto) {
    return this.admin.listStaff(query);
  }

  @UseGuards(PlatformAdminGuard)
  @Post('staff')
  grant(@CurrentUser() user: AuthUser, @Body() dto: GrantRoleDto) {
    return this.admin.grant(user.userId, dto.userId, dto.role, why(dto));
  }

  @UseGuards(PlatformAdminGuard)
  @Delete('staff/:grantId')
  revoke(@CurrentUser() user: AuthUser, @Param('grantId', new ParseUUIDPipe()) grantId: string, @Body() dto: ReasonDto) {
    return this.admin.revoke(user.userId, grantId, why(dto));
  }

  @UseGuards(PlatformAdminGuard)
  @Get('settings')
  settings() {
    return this.admin.listSettings();
  }

  @UseGuards(PlatformAdminGuard)
  @Put('settings/:key')
  putSetting(@CurrentUser() user: AuthUser, @Param('key') k: string, @Body() dto: PutSettingDto) {
    return this.admin.putSetting(user.userId, key(k), dto.value as Prisma.InputJsonValue, dto.description, why(dto));
  }

  @UseGuards(PlatformAdminGuard)
  @Get('feature-flags')
  flags() {
    return this.admin.listFlags();
  }

  @UseGuards(PlatformAdminGuard)
  @Put('feature-flags/:key')
  putFlag(@CurrentUser() user: AuthUser, @Param('key') k: string, @Body() dto: PutFlagDto) {
    return this.admin.putFlag(user.userId, key(k), dto.enabled, dto.organizationIds ?? [], dto.description, why(dto));
  }

  @UseGuards(PlatformAdminGuard)
  @Post('organizations/:organizationId/status')
  @HttpCode(200)
  organizationStatus(
    @CurrentUser() user: AuthUser,
    @Param('organizationId', new ParseUUIDPipe()) organizationId: string,
    @Body() dto: OrganizationStatusDto,
  ) {
    return this.admin.setOrganizationStatus(user.userId, organizationId, dto.status, why(dto));
  }

  @UseGuards(PlatformAdminGuard)
  @Get('audit')
  audit(@Query() query: AuditQueryDto) {
    return this.admin.listAudit(query);
  }
}

/** Other services check staff roles here on every request (see PlatformRoleGuard in common). */
@Controller('internal/platform-roles')
export class InternalPlatformRolesController {
  constructor(private readonly admin: AdminService) {}

  @ApiExcludeEndpoint()
  @Internal()
  @Get(':userId')
  async roles(@Param('userId', new ParseUUIDPipe()) userId: string): Promise<InternalPlatformRoles> {
    return { userId, roles: (await this.admin.effectiveRoles(userId)).roles };
  }
}
