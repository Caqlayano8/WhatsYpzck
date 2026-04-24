import { Request, Response, NextFunction } from 'express';
import { AuthService } from '../utils/auth.util';
import logger from '../../configs/logger.config';

declare global {
  namespace Express {
    interface Request {
      user: {
        userId?: string;
        _id?: string;
        id?: string;
        username?: string;
        role?: string;
        permissions?: Record<string, boolean>;
        allowedSessions?: string[];
        [key: string]: any;
      };
    }
  }
}

export const authenticate = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'Kimlik doğrulama gerekli' });

    const decoded = await AuthService.verifyToken(token);
    if (!decoded) return res.status(401).json({ error: 'Geçersiz token' });

    req.user = decoded;
    next();
  } catch (error) {
    logger.error('Authentication error:', error);
    res.status(500).json({ error: 'Sunucu hatası' });
  }
};

export const authorizeAdmin = (req: Request, res: Response, next: NextFunction) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Bu işlem için admin yetkisi gerekli' });
  }
  next();
};

/** Check a specific granular permission — falls back to role check for admins */
export const authorizePermission = (perm: string) => (req: Request, res: Response, next: NextFunction) => {
  if (req.user.role === 'admin') return next(); // admins always pass
  const perms = (req.user as any).permissions || {};
  if (perms[perm] === true) return next();
  return res.status(403).json({ error: `Bu işlem için '${perm}' yetkisi gerekli` });
};

/**
 * Enforce session-level access:
 * - Admins pass through without restriction
 * - Users with empty allowedSessions can access all sessions
 * - Users with non-empty allowedSessions can only access listed sessions
 * Usage: authorizeSession(req.params.sessionKey, req.user.tenantId || 'default')
 */
export function canAccessSession(user: any, tenantId: string, sessionKey: string): boolean {
  if (!user || user.role === 'admin') return true;
  const allowed: string[] = user.allowedSessions || [];
  if (allowed.length === 0) return true; // unrestricted
  const compositeKey = `${tenantId}:${sessionKey}`;
  return allowed.includes(compositeKey);
}

export const authorizeSession = (getTenantId: (req: Request) => string, getSessionKey: (req: Request) => string) =>
  (req: Request, res: Response, next: NextFunction) => {
    if (req.user.role === 'admin') return next();
    const tenantId = getTenantId(req);
    const sessionKey = getSessionKey(req);
    if (!canAccessSession(req.user, tenantId, sessionKey)) {
      return res.status(403).json({ error: `Bu session'a erişim yetkiniz yok: ${tenantId}:${sessionKey}` });
    }
    next();
  };

/**
 * Build a MongoDB $or / $in filter fragment that restricts list queries to
 * only the sessions a user is allowed to see.
 *
 * Returns {} when the user is unrestricted (admin or empty allowedSessions).
 * Returns { $or: [ {tenantId, sessionKey}, ... ] } when restricted.
 */
export function buildSessionFilter(user: any): Record<string, any> {
  if (!user || user.role === 'admin') return {};
  const allowed: string[] = user.allowedSessions || [];
  if (allowed.length === 0) return {};
  // Parse composite keys like "tenantId:sessionKey"
  const pairs = allowed.map((k: string) => {
    const idx = k.indexOf(':');
    if (idx === -1) return { tenantId: k };
    return { tenantId: k.slice(0, idx), sessionKey: k.slice(idx + 1) };
  });
  return { $or: pairs };
}