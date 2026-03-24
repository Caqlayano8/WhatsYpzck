import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { UserModel, UserRole } from '../models/user.model';
import EnvConfig from '../../configs/env.config';
import logger from '../../configs/logger.config';

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
  static async register(username: string, password: string, role: UserRole = 'viewer', displayName?: string, phone?: string) {
    const existingUser = await UserModel.findOne({ username });
    if (existingUser) throw new Error('Kullanıcı adı zaten mevcut');

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = new UserModel({ username, password: hashedPassword, role, displayName, phone });
    await user.save();
    return user;
  }

  static async login(username: string, password: string) {
    const user = await UserModel.findOne({ username });
    if (!user || !user.isActive) throw new Error('Geçersiz kullanıcı adı veya şifre');

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) throw new Error('Geçersiz kullanıcı adı veya şifre');

    // Resolve effective permissions: user overrides > role defaults
    const defaults = defaultPermissions(user.role as UserRole);
    const overrides = user.permissions || {};
    const effectivePerms: Record<string, boolean> = {};
    for (const key of Object.keys(defaults)) {
        const k = key as keyof typeof defaults;
        effectivePerms[k] = (overrides as any)[k] !== undefined ? (overrides as any)[k] : defaults[k];
    }

    const token = jwt.sign(
      { userId: String(user._id), role: user.role, username: user.username, _id: String(user._id), permissions: effectivePerms },
      EnvConfig.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '2h' }
    );

    // Update last login
    await UserModel.updateOne({ _id: user._id }, { lastLogin: new Date() });

    return {
      token,
      user: {
        _id: String(user._id),
        username: user.username,
        displayName: user.displayName || user.username,
        role: user.role,
        permissions: effectivePerms,
      }
    };
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