import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { CurrentUser, CurrentUserPayload } from '../../common/current-user';
import { JwtAuthGuard } from '../../common/jwt-auth.guard';
import { SubscriptionGuard } from '../../common/subscription.guard';
import { CreateEventDto } from './dto';
import { EventsService } from './events.service';

@UseGuards(JwtAuthGuard)
@Controller('events')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  @Get()
  list(@CurrentUser() user: CurrentUserPayload) {
    return this.events.list(user.sub);
  }

  @Post()
  @UseGuards(SubscriptionGuard)
  create(@CurrentUser() user: CurrentUserPayload, @Body() dto: CreateEventDto) {
    return this.events.create(user.sub, dto);
  }

  @Get(':id')
  get(@CurrentUser() user: CurrentUserPayload, @Param('id') id: string) {
    return this.events.getOwned(user.sub, id);
  }
}
