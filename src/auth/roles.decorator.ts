import { SetMetadata } from '@nestjs/common';
import type { AdminRole } from '../../generated/prisma/client';

export const ROLES_KEY = 'roles';

/**
 * Marks a route as restricted to specific AdminRole(s). A route with no
 * @Roles() at all is reachable by any authenticated, active admin
 * (ADMIN or SUPERVISOR) - this is the default, matching the discovery
 * doc's "Supervisors can do everything except delete/user-mgmt/client
 * (and site) management". Only apply @Roles('ADMIN') to the specific
 * routes that are actually restricted.
 */
export const Roles = (...roles: AdminRole[]) => SetMetadata(ROLES_KEY, roles);
