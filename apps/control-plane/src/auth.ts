import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import type { PublicUser, Role } from './store';
import { AppError } from './errors';

export interface AuthToken {
  sub: string;
  username: string;
  role: Role;
  sid?: string;
  purpose?: 'access' | '2fa';
}

declare global {
  namespace Express {
    interface Request {
      user?: PublicUser;
    }
  }
}

export function signAccessToken(user: PublicUser, secret: string, sid?: string): string {
  const payload: AuthToken = { sub: user.id, username: user.username, role: user.role, sid, purpose: 'access' };
  return jwt.sign(payload, secret, { expiresIn: '12h' });
}

export function signChallengeToken(user: PublicUser, secret: string): string {
  const payload: AuthToken = { sub: user.id, username: user.username, role: user.role, purpose: '2fa' };
  return jwt.sign(payload, secret, { expiresIn: '5m' });
}

export function authenticate(
  secret: string,
  lookupServiceAccount?: (token: string) => PublicUser | null,
  sessionLive?: (sid: string) => boolean,
) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const header = req.header('authorization') ?? '';
    const match = header.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      next(new AppError(401, 'Authentication required'));
      return;
    }
    if (match[1].startsWith('dw_')) {
      const account = lookupServiceAccount?.(match[1]) ?? null;
      if (!account) {
        next(new AppError(401, 'Invalid or expired token'));
        return;
      }
      req.user = account;
      next();
      return;
    }
    try {
      const decoded = jwt.verify(match[1], secret) as AuthToken;
      if (decoded.purpose === '2fa') {
        next(new AppError(401, 'Invalid or expired token'));
        return;
      }
      if (decoded.sid && sessionLive && !sessionLive(decoded.sid)) {
        next(new AppError(401, 'Session has ended'));
        return;
      }
      req.user = { id: decoded.sub, username: decoded.username, role: decoded.role, createdAt: '', environmentId: null };
      next();
    } catch (error) {
      next(error instanceof AppError ? error : new AppError(401, 'Invalid or expired token'));
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
