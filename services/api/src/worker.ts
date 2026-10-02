import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './app.module';
import { DbService } from './common/db.service';
import { GraphStoreService } from './common/graph-store.service';
import { SearchIndexService } from './common/search-index.service';
import { StorageService } from './common/storage.service';
import { CollectProcessor } from './modules/collection/collect.processor';
import { SourcesService } from './modules/sources/sources.service';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  await app.get(DbService).migrate();
  await app.get(SourcesService).sync();
  await app.get(StorageService).ensureBucket();
  await Promise.all([app.get(SearchIndexService).init(), app.get(GraphStoreService).init()]);
  await app.get(CollectProcessor).start();
  new Logger('Bootstrap').log('Worker ready');
}
void bootstrap();
