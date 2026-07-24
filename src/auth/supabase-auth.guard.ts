import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Request } from 'express';
import type { AdminUser } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SupabaseService } from '../supabase/supabase.service';

export interface AuthenticatedRequest extends Request {
  adminUser: AdminUser;
}

@Injectable()
export class SupabaseAuthGuard implements CanActivate {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = this.extractToken(request);
    if (!token) {
      throw new UnauthorizedException('Missing bearer token');
    }

    const supabaseUser = await this.supabase.getUserFromToken(token);
    if (!supabaseUser) {
      throw new UnauthorizedException('Invalid or expired token');
    }

    const adminUser = await this.prisma.adminUser.findUnique({ where: { id: supabaseUser.id } });
    if (!adminUser || adminUser.status !== 'ACTIVE') {
      throw new UnauthorizedException('Not an active admin user');
    }

    request.adminUser = adminUser;
    return true;
  }

  private extractToken(request: Request): string | null {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      return null;
    }
    return header.slice('Bearer '.length).trim() || null;
  }
}
