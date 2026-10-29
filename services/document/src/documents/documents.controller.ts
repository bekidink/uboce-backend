import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiHeader, ApiProperty, ApiTags } from '@nestjs/swagger';
import { type AuthUser, CallingService, CurrentUser, Internal, PaginationQueryDto, Public, type ServiceCaller } from '@uboce/common';
import { IsEnum, IsIn, IsInt, IsString, IsUUID, Length, Max, Min } from 'class-validator';
import type { Request, Response } from 'express';

import { DocumentClassification, GranteeType } from '../generated/prisma/enums.js';
import { ALLOWED_CONTENT_TYPES } from './content-rules.js';
import { type Caller, DocumentsService } from './documents.service.js';

class CreateUploadDto {
  @ApiProperty({ enum: DocumentClassification })
  @IsEnum(DocumentClassification)
  classification: DocumentClassification;

  @IsString()
  @Length(1, 200)
  fileName: string;

  @ApiProperty({ enum: ALLOWED_CONTENT_TYPES })
  @IsIn(ALLOWED_CONTENT_TYPES)
  contentType: string;

  /** Exact size in bytes; checked again after upload. */
  @IsInt()
  @Min(1)
  @Max(100 * 1024 * 1024)
  sizeBytes: number;
}

class ShareDto {
  @IsUUID()
  organizationId: string;

  @IsString()
  @Length(3, 300)
  reason: string;
}

class InternalGrantDto {
  @IsEnum(GranteeType)
  type: GranteeType;

  @IsString()
  @Length(1, 100)
  id: string;

  @IsString()
  @Length(3, 300)
  reason: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const callerOf = (user: AuthUser, organizationId: string | undefined, req: Request): Caller => ({
  userId: user.userId,
  organizationId: organizationId && UUID.test(organizationId) ? organizationId : undefined,
  ipAddress: req.ip,
});

const DocumentId = () => Param('documentId', new ParseUUIDPipe());

/**
 * Send x-organization-id to file a document under an organization (and to read
 * documents shared with it); without it, documents are personal.
 */
/** Product images, viewable by anyone (e.g. in an <img> tag). Redirects to a short-lived signed link. */
@ApiTags('documents')
@Controller('documents/public')
export class PublicImagesController {
  constructor(private readonly documents: DocumentsService) {}

  @Public()
  @Get(':documentId')
  async image(@Param('documentId', new ParseUUIDPipe()) id: string, @Res() res: Response) {
    const url = await this.documents.publicUrl(id);
    // Shorter than the link's lifetime, so a cached redirect never points at an expired link.
    res.setHeader('cache-control', 'public, max-age=300');
    res.redirect(302, url);
  }
}

@ApiTags('documents')
@ApiBearerAuth()
@ApiHeader({ name: 'x-organization-id', required: false })
@Controller('documents')
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  /** Returns a signed PUT URL. Upload the bytes there, then call /complete. */
  @Post()
  create(@CurrentUser() user: AuthUser, @Headers('x-organization-id') org: string | undefined, @Req() req: Request, @Body() dto: CreateUploadDto) {
    return this.documents.createUpload(callerOf(user, org, req), dto);
  }

  @Post(':documentId/complete')
  @HttpCode(200)
  complete(@CurrentUser() user: AuthUser, @Headers('x-organization-id') org: string | undefined, @Req() req: Request, @DocumentId() id: string) {
    return this.documents.completeUpload(callerOf(user, org, req), id);
  }

  @Get()
  list(@CurrentUser() user: AuthUser, @Headers('x-organization-id') org: string | undefined, @Req() req: Request, @Query() query: PaginationQueryDto) {
    return this.documents.list(callerOf(user, org, req), query);
  }

  @Get(':documentId')
  get(@CurrentUser() user: AuthUser, @Headers('x-organization-id') org: string | undefined, @Req() req: Request, @DocumentId() id: string) {
    return this.documents.get(callerOf(user, org, req), id);
  }

  @Get(':documentId/download-url')
  download(@CurrentUser() user: AuthUser, @Headers('x-organization-id') org: string | undefined, @Req() req: Request, @DocumentId() id: string) {
    return this.documents.downloadUrl(callerOf(user, org, req), id);
  }

  @Post(':documentId/share')
  share(@CurrentUser() user: AuthUser, @Headers('x-organization-id') org: string | undefined, @Req() req: Request, @DocumentId() id: string, @Body() dto: ShareDto) {
    return this.documents.share(callerOf(user, org, req), id, dto.organizationId, dto.reason);
  }

  @Delete(':documentId')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Headers('x-organization-id') org: string | undefined, @Req() req: Request, @DocumentId() id: string) {
    await this.documents.remove(callerOf(user, org, req), id);
  }
}

@Controller('internal/documents')
export class InternalDocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @ApiExcludeEndpoint()
  @Internal()
  @Get(':documentId')
  get(@DocumentId() id: string) {
    return this.documents.internalGet(id);
  }

  @ApiExcludeEndpoint()
  @Internal('catalog')
  @Post(':documentId/publish')
  @HttpCode(200)
  publish(@CallingService() service: ServiceCaller, @DocumentId() id: string) {
    return this.documents.internalPublish(service.service, id);
  }

  /** Review cases and disputes attach evidence this way. */
  @ApiExcludeEndpoint()
  @Internal('kyc', 'kyb', 'dispute', 'logistics', 'quality', 'notification', 'commerce')
  @Post(':documentId/grants')
  grant(@CallingService() service: ServiceCaller, @DocumentId() id: string, @Body() dto: InternalGrantDto) {
    return this.documents.internalGrant(service.service, id, dto.type, dto.id, dto.reason);
  }
}
