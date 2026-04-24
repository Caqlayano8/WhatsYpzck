import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { UserModel, UserRole } from '../models/user.model';
import EnvConfig from '../../configs/env.config';
import logger from '../../configs/logger.config';
import { sendMailWithAttachment } from '../../utils/email/mailer.util';

const ROLE_ALIASES: Record<string, UserRole> = {
  admin: 'admin',
  yonetici: 'admin',
  manager: 'admin',
  field_tech: 'field_tech',
  technician: 'field_tech',
  teknisyen: 'field_tech',
  user: 'viewer',
  viewer: 'viewer',
  kullanici: 'viewer',
};

export function normalizeUserRole(role?: string): UserRole {
  const normalized = String(role || 'viewer').trim().toLocaleLowerCase('tr-TR');
  const resolved = ROLE_ALIASES[normalized];
  if (!resolved) {
    throw new Error('Gecersiz rol. Desteklenen roller: admin, field_tech, viewer');
  }
  return resolved;
}

/** Default permissions per role */
function defaultPermissions(role: UserRole) {
    if (role === 'admin') return {
        canViewIncidents: true, canUpdateIncidents: true,
        canViewConversations: true, canSendMessages: true,
        canManageContacts: true, canManageCampaigns: true,
        canManageGroups: true, canViewReports: true,
        canManageSettings: true, canManageUsers: true,
        canToggleMaintenance: true,
    };
    if (role === 'field_tech') return {
        canViewIncidents: true, canUpdateIncidents: true,
        canViewConversations: false, canSendMessages: false,
        canManageContacts: false, canManageCampaigns: false,
        canManageGroups: false, canViewReports: true,
        canManageSettings: false, canManageUsers: false,
        canToggleMaintenance: false,
    };
    // viewer
    return {
        canViewIncidents: true, canUpdateIncidents: false,
        canViewConversations: false, canSendMessages: false,
        canManageContacts: false, canManageCampaigns: false,
        canManageGroups: false, canViewReports: true,
        canManageSettings: false, canManageUsers: false,
        canToggleMaintenance: false,
    };
}

export class AuthService {
  static async register(
    username: string,
    password: string,
    role: UserRole = 'viewer',
    displayName?: string,
    phone?: string,
    routing?: {
      city?: string;
      district?: string;
      neighborhoods?: string[];
      streets?: string[];
      areaKeywords?: string[];
    }
  ) {
    const existingUser = await UserModel.findOne({ username });
    if (existingUser) throw new Error('Kullanıcı adı zaten mevcut');

    const resolvedRole = normalizeUserRole(role);
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = new UserModel({ username, password: hashedPassword, role: resolvedRole, displayName, phone, routing });
    await user.save();
    return user;
  }

  static async login(username: string, password: string) {
    const user = await UserModel.findOne({ username });
    if (!user || !user.isActive) throw new Error('Geçersiz kullanıcı adı veya şifre');

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) throw new Error('Geçersiz kullanıcı adı veya şifre');

    const defaults = defaultPermissions(user.role as UserRole);
    const overrides = user.permissions || {};
    const effectivePerms: Record<string, boolean> = {};
    for (const key of Object.keys(defaults)) {
        const k = key as keyof typeof defaults;
        effectivePerms[k] = (overrides as any)[k] !== undefined ? (overrides as any)[k] : defaults[k];
    }

    // 2FA aktif mi?
    if ((user as any).twoFactorEnabled) {
      const tempToken = jwt.sign(
        { userId: String(user._id), twoFactorPending: true },
        EnvConfig.JWT_SECRET,
        { expiresIn: '5m' }
      );
      const method: string = (user as any).twoFactorMethod || 'email';
      if (method === 'totp') {
        // TOTP: QR kod kurulumu yok, sadece uygulama kodu beklenir
        return {
          twoFactorRequired: true,
          tempToken,
          method: 'totp',
          user: {
            _id: String(user._id),
            username: user.username,
            displayName: user.displayName || user.username,
          },
        };
      } else {
        // E-posta OTP
        await AuthService.sendTwoFactorOtp(String(user._id));
        return {
          twoFactorRequired: true,
          tempToken,
          method: 'email',
          user: {
            _id: String(user._id),
            username: user.username,
            displayName: user.displayName || user.username,
            email: (user as any).email || '',
          },
        };
      }
    }

    const allowedSessions = (user as any).allowedSessions || [];
    const token = jwt.sign(
      { userId: String(user._id), role: user.role, username: user.username, _id: String(user._id), permissions: effectivePerms, allowedSessions },
      EnvConfig.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '2h' }
    );
    await UserModel.updateOne({ _id: user._id }, { lastLogin: new Date() });
    return {
      token,
      user: {
        _id: String(user._id),
        username: user.username,
        displayName: user.displayName || user.username,
        role: user.role,
        permissions: effectivePerms,
        allowedSessions,
      }
    };
  }

  static async sendTwoFactorOtp(userId: string): Promise<void> {
    const user = await UserModel.findById(userId) as any;
    if (!user || !user.email) throw new Error('Kullanıcı e-postası tanımlı değil.');
    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const hashedOtp = await bcrypt.hash(otp, 10);
    const expiry = new Date(Date.now() + 5 * 60 * 1000);
    await UserModel.updateOne({ _id: userId }, { twoFactorOtp: hashedOtp, twoFactorExpiry: expiry });
    const sent = await sendMailWithAttachment({
      subject: 'WhatsYpzck - Giriş Doğrulama Kodu',
      textBody: `Merhaba ${user.displayName || user.username},\n\nGiriş doğrulama kodunuz:\n\n  ${otp}\n\nBu kod 5 dakika geçerlidir.\n\nWhatsYpzck Güvenlik Sistemi`,
      recipients: user.email,
    });
    if (!sent) throw new Error('Doğrulama kodu gönderilemedi. SMTP ayarlarını kontrol edin.');
    logger.info(`2FA OTP gönderildi: ${user.username} → ${user.email}`);
  }

  static async verifyTwoFactorOtp(tempToken: string, otp: string) {
    let payload: any;
    try { payload = jwt.verify(tempToken, EnvConfig.JWT_SECRET) as any; }
    catch { throw new Error('Geçersiz veya süresi dolmuş oturum. Lütfen tekrar giriş yapın.'); }
    if (!payload.twoFactorPending) throw new Error('Bu token 2FA doğrulaması için geçersiz.');
    const user = await UserModel.findById(payload.userId) as any;
    if (!user || !user.isActive) throw new Error('Kullanıcı bulunamadı.');
    if (!user.twoFactorOtp || !user.twoFactorExpiry || new Date() > user.twoFactorExpiry)
      throw new Error('Doğrulama kodunun süresi dolmuş. Lütfen yeniden giriş yapın.');
    const isOtpMatch = await bcrypt.compare(otp.trim(), user.twoFactorOtp);
    if (!isOtpMatch) throw new Error('Doğrulama kodu hatalı.');
    await UserModel.updateOne({ _id: user._id }, { twoFactorOtp: null, twoFactorExpiry: null, lastLogin: new Date() });
    const defaults = defaultPermissions(user.role as UserRole);
    const overrides = user.permissions || {};
    const effectivePerms: Record<string, boolean> = {};
    for (const key of Object.keys(defaults)) {
      const k = key as keyof typeof defaults;
      effectivePerms[k] = (overrides as any)[k] !== undefined ? (overrides as any)[k] : defaults[k];
    }
    const allowedSessions2fa = (user as any).allowedSessions || [];
    const token = jwt.sign(
      { userId: String(user._id), role: user.role, username: user.username, _id: String(user._id), permissions: effectivePerms, allowedSessions: allowedSessions2fa },
      EnvConfig.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '2h' }
    );
    return {
      token,
      user: {
        _id: String(user._id),
        username: user.username,
        displayName: user.displayName || user.username,
        role: user.role,
        permissions: effectivePerms,
        allowedSessions: allowedSessions2fa,
      }
    };
  }

  static async setTwoFactor(userId: string, enabled: boolean, email?: string, method?: string) {
    const update: any = { twoFactorEnabled: enabled };
    if (email) update.email = email.trim().toLowerCase();
    if (method) update.twoFactorMethod = method;
    await UserModel.updateOne({ _id: userId }, update);
  }

  /** TOTP - Google Authenticator için gizli anahtar oluştur ve QR kod URL'i döndür */
  static async setupTotp(userId: string): Promise<{ secret: string; otpauth_url: string; qrCodeDataUrl: string }> {
    const speakeasy = require('speakeasy');
    const QRCode = require('qrcode');
    const user = await UserModel.findById(userId);
    if (!user) throw new Error('Kullanıcı bulunamadı.');
    const secret = speakeasy.generateSecret({ name: `WhatsYpzck (${user.username})`, length: 20 });
    // Gizli anahtarı DB'ye kaydet (henüz aktifleştirme yapılmadı)
    await UserModel.updateOne({ _id: userId }, { totpSecret: secret.base32 });
    const qrCodeDataUrl = await QRCode.toDataURL(secret.otpauth_url);
    return { secret: secret.base32, otpauth_url: secret.otpauth_url, qrCodeDataUrl };
  }

  /** TOTP - 6 haneli kodu doğrula ve 2FA'yı aktifleştir */
  static async verifyAndActivateTotp(userId: string, token: string): Promise<boolean> {
    const speakeasy = require('speakeasy');
    const user = await UserModel.findById(userId);
    if (!user || !(user as any).totpSecret) throw new Error('TOTP kurulumu bulunamadı.');
    const verified = speakeasy.totp.verify({
      secret: (user as any).totpSecret,
      encoding: 'base32',
      token,
      window: 1,
    });
    if (verified) {
      await UserModel.updateOne({ _id: userId }, { twoFactorEnabled: true, twoFactorMethod: 'totp' });
    }
    return verified;
  }

  /** TOTP - Login sırasında 6 haneli kodu doğrula */
  static async verifyTotpLogin(userId: string, token: string): Promise<boolean> {
    const speakeasy = require('speakeasy');
    const user = await UserModel.findById(userId);
    if (!user || !(user as any).totpSecret) return false;
    return speakeasy.totp.verify({
      secret: (user as any).totpSecret,
      encoding: 'base32',
      token,
      window: 1,
    });
  }

    static async verifyToken(token: string) {
    try {
      return jwt.verify(token, EnvConfig.JWT_SECRET);
    } catch (error) {
      logger.error('Token verification failed:', error);
      return null;
    }
  }
}
