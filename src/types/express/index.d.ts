import 'express-serve-static-core';

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
        [key: string]: any;
      };
    }
  }
}

export {};