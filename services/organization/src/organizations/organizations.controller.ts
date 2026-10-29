import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { type AuthUser, CurrentUser, PaginationQueryDto } from '@uboce/common';

import {
  AddMemberDto,
  CreateBranchDto,
  CreateOrganizationDto,
  DirectoryQueryDto,
  MemberLocationsDto,
  MemberTemplateDto,
  RoleTemplateDto,
  UpdateBranchDto,
  UpdateMemberDto,
  UpdateOrganizationDto,
} from './organizations.dto.js';
import { OrganizationsService } from './organizations.service.js';

const OrgId = () => Param('organizationId', new ParseUUIDPipe());
const MemberId = () => Param('membershipId', new ParseUUIDPipe());
const BranchId = () => Param('branchId', new ParseUUIDPipe());

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

  /** Logistics providers (or other types) to work with: name, verification, delivery areas. */
  @Get('providers')
  providers(@Query('type') type?: string, @Query('q') q?: string, @Query('area') area?: string) {
    return this.organizations.providers(type ?? 'logistics_provider', q, area);
  }

  /** Public profiles (name, type, verification) of any organizations, so clients can show counterparties by name. */
  @Get('directory')
  directory(@Query() query: DirectoryQueryDto) {
    return this.organizations.directory(query.ids);
  }

  /** Another organization's active locations as customers see them: pickup points, hours, delivery areas. */
  @Get(':organizationId/public-locations')
  publicLocations(@OrgId() organizationId: string) {
    return this.organizations.publicLocations(organizationId);
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

  @Post(':organizationId/members/:membershipId/suspend')
  @HttpCode(200)
  suspendMember(@CurrentUser() user: AuthUser, @OrgId() organizationId: string, @MemberId() membershipId: string) {
    return this.organizations.setSuspended(user.userId, organizationId, membershipId, true);
  }

  @Post(':organizationId/members/:membershipId/reactivate')
  @HttpCode(200)
  reactivateMember(@CurrentUser() user: AuthUser, @OrgId() organizationId: string, @MemberId() membershipId: string) {
    return this.organizations.setSuspended(user.userId, organizationId, membershipId, false);
  }

  @Get(':organizationId/role-templates')
  templates(@CurrentUser() user: AuthUser, @OrgId() organizationId: string) {
    return this.organizations.listTemplates(user.userId, organizationId);
  }

  @Post(':organizationId/role-templates')
  createTemplate(@CurrentUser() user: AuthUser, @OrgId() organizationId: string, @Body() dto: RoleTemplateDto) {
    return this.organizations.saveTemplate(user.userId, organizationId, dto);
  }

  @Put(':organizationId/role-templates/:templateId')
  updateTemplate(
    @CurrentUser() user: AuthUser,
    @OrgId() organizationId: string,
    @Param('templateId', new ParseUUIDPipe()) templateId: string,
    @Body() dto: RoleTemplateDto,
  ) {
    return this.organizations.saveTemplate(user.userId, organizationId, dto, templateId);
  }

  @Delete(':organizationId/role-templates/:templateId')
  @HttpCode(204)
  async deleteTemplate(@CurrentUser() user: AuthUser, @OrgId() organizationId: string, @Param('templateId', new ParseUUIDPipe()) templateId: string) {
    await this.organizations.deleteTemplate(user.userId, organizationId, templateId);
  }

  /** Assign (or remove) a role template: narrower permissions and an approval limit. */
  @Put(':organizationId/members/:membershipId/template')
  setTemplate(@CurrentUser() user: AuthUser, @OrgId() organizationId: string, @MemberId() membershipId: string, @Body() dto: MemberTemplateDto) {
    return this.organizations.setMemberTemplate(user.userId, organizationId, membershipId, dto);
  }

  /** Location scope: the branches this member may act at (empty: all). */
  @Put(':organizationId/members/:membershipId/locations')
  setMemberLocations(
    @CurrentUser() user: AuthUser,
    @OrgId() organizationId: string,
    @MemberId() membershipId: string,
    @Body() dto: MemberLocationsDto,
  ) {
    return this.organizations.setMemberLocations(user.userId, organizationId, membershipId, dto);
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

  @Get(':organizationId/branches/:branchId')
  getBranch(@CurrentUser() user: AuthUser, @OrgId() organizationId: string, @BranchId() branchId: string) {
    return this.organizations.getBranch(user.userId, organizationId, branchId);
  }

  @Patch(':organizationId/branches/:branchId')
  updateBranch(
    @CurrentUser() user: AuthUser,
    @OrgId() organizationId: string,
    @BranchId() branchId: string,
    @Body() dto: UpdateBranchDto,
  ) {
    return this.organizations.updateBranch(user.userId, organizationId, branchId, dto);
  }
}
