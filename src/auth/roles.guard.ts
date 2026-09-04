import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { AdminRole } from '../../generated/prisma/client';
import { AuthenticatedRequest } from './supabase-auth.guard';
import { ROLES_KEY } from './roles.decorator';

/**
 * Must run AFTER SupabaseAuthGuard (which populates request.adminUser) -
 * always pair as @UseGuards(SupabaseAuthGuard, RolesGuard), in that order.
 * A route with no @Roles() metadata is allowed through for any
 * authenticated admin, regardless of role - this guard only narrows,
 * it's never the thing that grants base access.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<AdminRole[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!requiredRoles || requiredRoles.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const role = request.adminUser?.role;

    if (!role || !requiredRoles.includes(role)) {
      throw new ForbiddenException('You do not have permission to perform this action');
    }

    return true;
  }
}
