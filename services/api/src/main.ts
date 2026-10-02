import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { config } from './config';
import { DbService } from './common/db.service';
import { GraphStoreService } from './common/graph-store.service';
import { SearchIndexService } from './common/search-index.service';
import { StorageService } from './common/storage.service';
import { AuthService } from './modules/auth/auth.controller';
import { SourcesService } from './modules/sources/sources.service';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: false });
  app.setGlobalPrefix('api/v1', { exclude: ['health'] });
  app.enableShutdownHooks();
  app.getHttpAdapter().getInstance().disable('x-powered-by');

  await app.get(DbService).migrate();
  await app.get(AuthService).seedUsers();
  await app.get(SourcesService).sync();
  await app.get(StorageService).ensureBucket();
  // OpenSearch and Neo4j may start slowly; the API serves requests meanwhile with PostgreSQL fallbacks.
  void app.get(SearchIndexService).init();
  void app.get(GraphStoreService).init();

  await app.listen(config.port, '0.0.0.0');
  new Logger('Bootstrap').log(`API listening on :${config.port} (prefix /api/v1)`);
}
void bootstrap();
