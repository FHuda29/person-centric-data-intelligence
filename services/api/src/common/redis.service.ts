import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { config } from '../config';

export const COLLECT_QUEUE = 'pcdi-collect';
export const DEAD_LETTER_QUEUE = 'pcdi-dead-letter';
export const MAINTENANCE_QUEUE = 'pcdi-maintenance';

export const bullConnection = () => {
  const u = new URL(config.redisUrl);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    password: u.password || undefined,
    maxRetriesPerRequest: null,
  };
};

/** Redis: rate-limit counters, idempotency keys and BullMQ job queues. */
@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 3 });
  readonly collectQueue = new Queue(COLLECT_QUEUE, { connection: bullConnection() });
  readonly deadLetterQueue = new Queue(DEAD_LETTER_QUEUE, { connection: bullConnection() });
  readonly maintenanceQueue = new Queue(MAINTENANCE_QUEUE, { connection: bullConnection() });

  /** Fixed-window per-source rate limiter. Returns ms to wait (0 = allowed). */
  async acquireRate(sourceKey: string, perMinute: number): Promise<number> {
    const window = Math.floor(Date.now() / 60000);
    const key = `rl:${sourceKey}:${window}`;
    const n = await this.redis.incr(key);
    if (n === 1) await this.redis.expire(key, 70);
    if (n <= perMinute) return 0;
    return (window + 1) * 60000 - Date.now() + 50;
  }

  async onModuleDestroy() {
    await Promise.allSettled([
      this.collectQueue.close(),
      this.deadLetterQueue.close(),
      this.maintenanceQueue.close(),
    ]);
    this.redis.disconnect();
  }
}
