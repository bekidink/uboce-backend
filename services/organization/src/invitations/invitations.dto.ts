import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsEnum, IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';

import { MembershipRole } from '../generated/prisma/enums.js';

/** Send exactly one of `email` or `phone`. */
export class CreateInvitationDto {
  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  email?: string;

  /** E.164, e.g. +251911234567 */
  @IsOptional()
  @Matches(/^\+[1-9]\d{7,14}$/, { message: 'phone must be in E.164 format, e.g. +251911234567' })
  phone?: string;

  @ApiProperty({ enum: MembershipRole })
  @IsEnum(MembershipRole)
  role: MembershipRole;
}

export class AcceptInvitationDto {
  @IsString()
  @Length(20, 200)
  token: string;
}
