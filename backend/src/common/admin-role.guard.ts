import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../modules/prisma/prisma.service';

@Injectable()
export class AdminRoleGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest();
    const user = request.user as { sub?: string; role?: string } | undefined;
    if (!user?.sub) throw new ForbiddenException('not_authenticated');
    if (user.role === 'admin') return true;

    const photographer = await this.prisma.photographer.findUnique({
      where: { id: user.sub },
      select: { role: true },
    });
    if (photographer?.role !== 'admin') throw new ForbiddenException('admin_role_required');
    request.user = { ...user, role: 'admin' };
    return true;
  }
}
