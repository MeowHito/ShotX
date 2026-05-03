import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';

export type PhotoAiJob = {
  photoId: string;
  eventId: string;
  storageKey: string;
  queueType: 'fast' | 'standard';
};

@Injectable()
export class AiQueueService {
  constructor(@InjectQueue('ai-photos') private readonly queue: Queue<PhotoAiJob>) {}

  enqueuePhoto(job: PhotoAiJob) {
    return this.queue.add('process-photo', job, { attempts: 3, backoff: { type: 'exponential', delay: 5000 } });
  }
}
