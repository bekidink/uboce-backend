import { IsEmail, IsString, Length, Matches, MaxLength, MinLength } from 'class-validator';

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
