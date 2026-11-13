import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsIn, IsOptional, IsString, Length, Matches, MaxLength, MinLength } from 'class-validator';

export class TokenDto {
  @IsString()
  @Length(20, 200)
  token: string;
}

export class ForgotPasswordDto {
  @IsEmail()
  @MaxLength(254)
  email: string;
}

export class ResetPasswordDto {
  @IsString()
  @Length(20, 200)
  token: string;

  @IsString()
  @MinLength(10)
  @MaxLength(128)
  newPassword: string;
}

export class ChangePasswordDto {
  @IsString()
  @MaxLength(128)
  currentPassword: string;

  @IsString()
  @MinLength(10)
  @MaxLength(128)
  newPassword: string;
}

export class MfaCodeDto {
  @Matches(/^\d{6}$/, { message: 'code must be 6 digits' })
  code: string;
}

export class MfaSetupDto {
  /** Base32 secret, for manual entry. */
  secret: string;
  /** Render as a QR code for authenticator apps. */
  otpauthUrl: string;
}

export class RecoveryCodesDto {
  /** Shown once. Each code signs in once if the authenticator is lost. */
  recoveryCodes: string[];
}

/** Profile fields the user can change themselves. Email changes go through verification (not here). */
export class UpdateProfileDto {
  @IsOptional()
  @IsString()
  @Length(1, 100)
  displayName?: string;

  /** E.164, e.g. +251911234567; null removes it. */
  @IsOptional()
  @Matches(/^\+[1-9]\d{7,14}$/, { message: 'phone must be in E.164 format, e.g. +251911234567' })
  phone?: string | null;

  @ApiPropertyOptional({ enum: ['en', 'am'] })
  @IsOptional()
  @IsIn(['en', 'am'])
  locale?: 'en' | 'am';
}

export class CloseAccountDto {
  @IsString()
  @MaxLength(128)
  password: string;

  /** Required when two-factor sign-in is on. */
  @IsOptional()
  @Matches(/^\d{6}$/, { message: 'mfaCode must be 6 digits' })
  mfaCode?: string;
}

export interface SessionDto {
  /** Pass to DELETE /auth/sessions/:id to sign that device out. */
  id: string;
  userAgent: string | null;
  ipAddress: string | null;
  signedInAt: Date;
  lastActiveAt: Date;
  current: boolean;
}
