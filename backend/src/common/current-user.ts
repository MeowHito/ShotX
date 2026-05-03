import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export type CurrentUserPayload = { sub: string; role?: string };

export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): CurrentUserPayload | undefined => {
  const request = ctx.switchToHttp().getRequest();
  return request.user;
});
