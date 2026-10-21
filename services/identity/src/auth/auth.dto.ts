import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsIn, IsOptional, IsString, Length, Matches, MaxLength, MinLength } from 'class-validator';

export class RegisterDto {
  @IsEmail()
  @MaxLength(254)
  email: string;

  /** 10–128 characters. Length beats complexity rules (NIST 800-63B). */
  @IsString()
  @MinLength(10)
  @MaxLength(128)
  password: string;

  @IsString()
  @Length(1, 100)
  displayName: string;

  /** E.164, e.g. +251911234567 */
  @IsOptional()
  @Matches(/^\+[1-9]\d{7,14}$/, { message: 'phone must be in E.164 format, e.g. +251911234567' })
  phone?: string;

  @ApiPropertyOptional({ enum: ['en', 'am'], default: 'en' })
  @IsOptional()
  @IsIn(['en', 'am'])
  locale?: 'en' | 'am';
}

export class LoginDto {
  @IsEmail()
  @MaxLength(254)
  email: string;

  @IsString()
  @MaxLength(128)
  password: string;
}

export class RefreshDto {
  @IsString()
  @MaxLength(256)
  refreshToken: string;
}

export class TokenResponseDto {
  accessToken: string;
  /** Single use: every refresh returns a new one. Reusing an old one signs out the device. */
  refreshToken: string;
  @ApiProperty({ example: 'Bearer' })
  tokenType: 'Bearer';
  /** Access token lifetime in seconds. */
  expiresIn: number;
}

export class MfaChallengeDto {
  @ApiProperty({ example: true })
  mfaRequired: true;
  /** Send with the authenticator code to POST /auth/mfa/verify within expiresIn seconds. */
  mfaToken: string;
  expiresIn: number;
}

export class VerifyMfaDto {
  @IsString()
  @MaxLength(2048)
  mfaToken: string;

  /** 6-digit code from the authenticator app. */
  @IsOptional()
  @Matches(/^\d{6}$/, { message: 'code must be 6 digits' })
  code?: string;

  /** One of the recovery codes shown when MFA was enabled. Each works once. */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  recoveryCode?: string;
}

export class UserProfileDto {
  id: string;
  email: string;
  emailVerified: boolean;
  phone: string | null;
  displayName: string;
  locale: string;
  status: string;
  mfaEnabled: boolean;
  createdAt: Date;
}
