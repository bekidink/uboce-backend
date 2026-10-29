import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiProperty, ApiTags } from '@nestjs/swagger';
import { type ActingOrganization, ActingOrg, ActsForOrganization, type AuthUser, CurrentUser, PaginationQueryDto, RequiresModule } from '@uboce/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsDateString, IsIn, IsInt, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';

import { ChatService, type ContextType } from './chat.service.js';

const CONTEXTS = ['rfq', 'quotation', 'order', 'shipment', 'dispute', 'general'] as const;

class StartDto {
  @IsString()
  @Length(2, 200)
  subject: string;

  @ApiProperty({ enum: CONTEXTS })
  @IsIn(CONTEXTS)
  contextType: ContextType;

  @IsOptional()
  @IsUUID()
  contextId?: string;

  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @IsUUID('all', { each: true })
  participantOrganizationIds: string[];

  @IsString()
  @Length(1, 4000)
  message: string;

  @IsOptional()
  @ArrayMaxSize(10)
  @IsUUID('all', { each: true })
  attachmentDocumentIds?: string[];
}

class MessageDto {
  @IsString()
  @Length(0, 4000)
  body: string;

  @IsOptional()
  @ArrayMaxSize(10)
  @IsUUID('all', { each: true })
  attachmentDocumentIds?: string[];
}

class ListDto extends PaginationQueryDto {
  @IsOptional()
  @IsIn(CONTEXTS)
  contextType?: string;

  @IsOptional()
  @IsUUID()
  contextId?: string;
}

class MessagesQueryDto {
  /** Only messages after this time (poll for new ones). */
  @IsOptional()
  @IsDateString()
  after?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

const Id = () => Param('conversationId', new ParseUUIDPipe());

@ApiTags('chat')
@ApiBearerAuth()
@ActsForOrganization()
@RequiresModule('chat')
@Controller('conversations')
export class ChatController {
  constructor(private readonly chat: ChatService) {}

  /** Start a conversation (an existing one about the same record is reused). */
  @Post()
  start(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Body() dto: StartDto) {
    return this.chat.start(org, user.userId, dto);
  }

  @Get()
  list(@ActingOrg() org: ActingOrganization, @Query() query: ListDto) {
    return this.chat.list(org, query);
  }

  @Get('unread')
  unread(@ActingOrg() org: ActingOrganization) {
    return this.chat.unreadCount(org);
  }

  @Get(':conversationId')
  get(@ActingOrg() org: ActingOrganization, @Id() id: string) {
    return this.chat.get(org, id);
  }

  @Get(':conversationId/messages')
  messages(@ActingOrg() org: ActingOrganization, @Id() id: string, @Query() query: MessagesQueryDto) {
    return this.chat.messages(org, id, query);
  }

  @Post(':conversationId/messages')
  send(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Id() id: string, @Body() dto: MessageDto) {
    return this.chat.send(org, user.userId, id, dto);
  }

  @Post(':conversationId/read')
  @HttpCode(200)
  read(@ActingOrg() org: ActingOrganization, @Id() id: string) {
    return this.chat.markRead(org, id);
  }

  @Post(':conversationId/close')
  @HttpCode(200)
  close(@ActingOrg() org: ActingOrganization, @Id() id: string) {
    return this.chat.close(org, id);
  }

  @Delete(':conversationId/messages/:messageId')
  remove(@ActingOrg() org: ActingOrganization, @CurrentUser() user: AuthUser, @Id() id: string, @Param('messageId', new ParseUUIDPipe()) messageId: string) {
    return this.chat.deleteMessage(org, user.userId, id, messageId);
  }
}
