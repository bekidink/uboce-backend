import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { type AuthUser, CurrentUser, PaginationQueryDto } from '@uboce/common';

import {
  AddMemberDto,
  CreateBranchDto,
  CreateOrganizationDto,
  DirectoryQueryDto,
  UpdateMemberDto,
  UpdateOrganizationDto,
} from './organizations.dto.js';
import { OrganizationsService } from './organizations.service.js';

const OrgId = () => Param('organizationId', new ParseUUIDPipe());

@ApiTags('organizations')
@ApiBearerAuth()
@Controller('organizations')
export class OrganizationsController {
  constructor(private readonly organizations: OrganizationsService) {}

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateOrganizationDto) {
    return this.organizations.create(user.userId, dto);
  }

  @Get()
  listMine(@CurrentUser() user: AuthUser, @Query() query: PaginationQueryDto) {
    return this.organizations.listMine(user.userId, query);
  }

  /** Public profiles (name, type, verification) of any organizations, so clients can show counterparties by name. */
  @Get('directory')
  directory(@Query() query: DirectoryQueryDto) {
    return this.organizations.directory(query.ids);
  }

  @Get(':organizationId')
  get(@CurrentUser() user: AuthUser, @OrgId() organizationId: string) {
    return this.organizations.get(user.userId, organizationId);
  }

  @Patch(':organizationId')
  update(@CurrentUser() user: AuthUser, @OrgId() organizationId: string, @Body() dto: UpdateOrganizationDto) {
    return this.organizations.update(user.userId, organizationId, dto);
  }

  @Get(':organizationId/access')
  myAccess(@CurrentUser() user: AuthUser, @OrgId() organizationId: string) {
    return this.organizations.myAccess(user.userId, organizationId);
  }

  @Get(':organizationId/members')
  listMembers(@CurrentUser() user: AuthUser, @OrgId() organizationId: string, @Query() query: PaginationQueryDto) {
    return this.organizations.listMembers(user.userId, organizationId, query);
  }

  @Post(':organizationId/members')
  addMember(@CurrentUser() user: AuthUser, @OrgId() organizationId: string, @Body() dto: AddMemberDto) {
    return this.organizations.addMember(user.userId, organizationId, dto);
  }

  @Patch(':organizationId/members/:membershipId')
  updateMember(
    @CurrentUser() user: AuthUser,
    @OrgId() organizationId: string,
    @Param('membershipId', new ParseUUIDPipe()) membershipId: string,
    @Body() dto: UpdateMemberDto,
  ) {
    return this.organizations.updateMember(user.userId, organizationId, membershipId, dto);
  }

  @Delete(':organizationId/members/:membershipId')
  @HttpCode(204)
  async revokeMember(
    @CurrentUser() user: AuthUser,
    @OrgId() organizationId: string,
    @Param('membershipId', new ParseUUIDPipe()) membershipId: string,
  ) {
    await this.organizations.revokeMember(user.userId, organizationId, membershipId);
  }

  @Get(':organizationId/branches')
  listBranches(@CurrentUser() user: AuthUser, @OrgId() organizationId: string, @Query() query: PaginationQueryDto) {
    return this.organizations.listBranches(user.userId, organizationId, query);
  }

  @Post(':organizationId/branches')
  createBranch(@CurrentUser() user: AuthUser, @OrgId() organizationId: string, @Body() dto: CreateBranchDto) {
    return this.organizations.createBranch(user.userId, organizationId, dto);
  }
}
