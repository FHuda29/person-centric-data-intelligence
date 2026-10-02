import {
  CanActivate,
  createParamDecorator,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NestMiddleware,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { AuthUser, Role } from './types';

export const IS_PUBLIC = 'isPublic';
export const ROLES = 'roles';
export const Public = () => SetMetadata(IS_PUBLIC, true);
export const Roles = (...roles: Role[]) => SetMetadata(ROLES, roles);

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): AuthUser => {
  return ctx.switchToHttp().getRequest().user;
});
export const RequestId = createParamDecorator((_: unknown, ctx: ExecutionContext): string => {
  return ctx.switchToHttp().getRequest().requestId;
});

/** Global guard: JWT bearer authentication + role-based authorization. */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;
    const req = ctx.switchToHttp().getRequest();
    const header: string | undefined = req.headers.authorization;
    const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
    if (!token) throw new UnauthorizedException('Missing bearer token');
    try {
      const p = this.jwt.verify(token);
      if (p.mfaPending) throw new Error('MFA pending');
      req.user = { id: p.sub, username: p.username, displayName: p.name, role: p.role, canRevealPii: !!p.pii } as AuthUser;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
    const roles = this.reflector.getAllAndOverride<Role[]>(ROLES, targets);
    if (roles?.length && !roles.includes(req.user.role)) {
      throw new ForbiddenException(`Requires role: ${roles.join(' / ')}`);
    }
    return true;
  }
}

/** Correlates every request with an id (paper §10: request ID) — echoed back as x-request-id. */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request & { requestId?: string }, res: Response, next: NextFunction) {
    const incoming = req.headers['x-request-id'];
    req.requestId = typeof incoming === 'string' && incoming.length <= 100 ? incoming : randomUUID();
    res.setHeader('x-request-id', req.requestId);
    next();
  }
}
