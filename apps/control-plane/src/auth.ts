import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import type { PublicUser, Role } from './store';
import { AppError } from './errors';

export interface AuthToken {
  sub: string;
  username: string;
  role: Role;
}

declare global {
  namespace Express {
    interface Request {
      user?: PublicUser;
    }
  }
}

export function signAccessToken(user: PublicUser, secret: string): string {
  const payload: AuthToken = { sub: user.id, username: user.username, role: user.role };
  return jwt.sign(payload, secret, { expiresIn: '12h' });
}

export function authenticate(secret: string) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const header = req.header('authorization') ?? '';
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      next(new AppError(401, 'Authentication required'));
      return;
    }
    try {
      const decoded = jwt.verify(match[1], secret) as AuthToken;
      req.user = { id: decoded.sub, username: decoded.username, role: decoded.role, createdAt: '' };
      next();
    } catch {
      next(new AppError(401, 'Invalid or expired token'));
    }
  };
}

export function authorize(...roles: Role[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(new AppError(401, 'Authentication required'));
      return;
    }
    if (!roles.includes(req.user.role)) {
      next(new AppError(403, 'Insufficient permissions'));
      return;
    }
    next();
  };
}
