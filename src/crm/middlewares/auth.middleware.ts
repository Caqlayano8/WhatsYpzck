import { Request, Response, NextFunction } from 'express';
import { AuthService } from '../utils/auth.util';
import logger from '../../configs/logger.config';

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