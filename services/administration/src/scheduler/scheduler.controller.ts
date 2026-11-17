import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

import { PlatformAdminGuard } from '../admin/admin.controller.js';
import { SchedulerService } from './scheduler.service.js';

class UpdateJobDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  /** Between one minute and one week. */
  @IsOptional()
  @IsInt()
  @Min(60)
  @Max(604_800)
  intervalSeconds?: number;
}

class RunsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

/** Scheduled jobs: status, history, pause and run now (PRD v2 PLT-02). Platform administrators only. */
@ApiTags('administration')
@ApiBearerAuth()
@UseGuards(PlatformAdminGuard)
@Controller('admin/jobs')
export class SchedulerController {
  constructor(private readonly scheduler: SchedulerService) {}

  @Get()
  list() {
    return this.scheduler.list();
  }

  @Get(':name/runs')
  runs(@Param('name') name: string, @Query() query: RunsQueryDto) {
    return this.scheduler.runs(name, query.limit ?? 50);
  }

  @Patch(':name')
  update(@Param('name') name: string, @Body() dto: UpdateJobDto) {
    return this.scheduler.update(name, dto);
  }

  @Post(':name/run')
  @HttpCode(202)
  run(@Param('name') name: string) {
    return this.scheduler.runNow(name);
  }
}
