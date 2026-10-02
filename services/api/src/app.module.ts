import { Controller, Get, Global, MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { config } from './config';
import { AuthGuard, Public, RequestIdMiddleware } from './common/auth';
import { DbService } from './common/db.service';
import { GraphStoreService } from './common/graph-store.service';
import { RedisService } from './common/redis.service';
import { SearchIndexService } from './common/search-index.service';
import { StorageService } from './common/storage.service';
import { AuditController, AuditService } from './modules/audit/audit.service';
import { AuthController, AuthService, UsersController } from './modules/auth/auth.controller';
import { CasesController, RetentionService } from './modules/cases/cases.controller';
import { CollectProcessor } from './modules/collection/collect.processor';
import { CollectionController, CollectionService } from './modules/collection/collection.service';
import { EntitiesController } from './modules/entities/entities.controller';
import { EntitiesService } from './modules/entities/entities.service';
import { EvidenceController, FindingsController } from './modules/evidence/evidence.controller';
import { ExtractionService } from './modules/extraction/extraction.service';
import { IdentityController, IdentityService } from './modules/identity/identity.service';
import { IngestService } from './modules/ingest/ingest.service';
import { NarrativeController, NarrativeService } from './modules/narrative/narrative.service';
import { PolicyService } from './modules/policy/policy.service';
import { ReportsController } from './modules/reports/reports.controller';
import { ResolutionController, ResolutionService } from './modules/resolution/resolution.service';
import { SearchController } from './modules/search/search.controller';
import { SourcesController, SourcesService } from './modules/sources/sources.service';

const DOMAIN_PROVIDERS = [
  DbService,
  StorageService,
  SearchIndexService,
  GraphStoreService,
  RedisService,
  AuditService,
  PolicyService,
  AuthService,
  IdentityService,
  SourcesService,
  EntitiesService,
  ExtractionService,
  IngestService,
  CollectionService,
  ResolutionService,
  NarrativeService,
  RetentionService,
];

/** Shared domain layer (modular monolith: one module per domain folder, deployable as API or worker). */
@Global()
@Module({
  imports: [JwtModule.register({ secret: config.jwtSecret })],
  providers: DOMAIN_PROVIDERS,
  exports: [...DOMAIN_PROVIDERS, JwtModule],
})
export class DomainModule {}

@Controller('health')
class HealthController {
  constructor(
    private readonly db: DbService,
    private readonly index: SearchIndexService,
    private readonly graph: GraphStoreService,
    private readonly redis: RedisService,
  ) {}

  @Public()
  @Get()
  async health() {
    const pg = await this.db.query('SELECT 1').then(() => 'up', () => 'down');
    const redis = await this.redis.redis.ping().then(() => 'up', () => 'down');
    return { status: pg === 'up' && redis === 'up' ? 'ok' : 'degraded', postgres: pg, redis, opensearch: this.index.available ? 'up' : 'down', neo4j: this.graph.available ? 'up' : 'down' };
  }
}

@Module({
  imports: [DomainModule],
  controllers: [
    HealthController,
    AuthController,
    UsersController,
    AuditController,
    IdentityController,
    SourcesController,
    CasesController,
    CollectionController,
    EntitiesController,
    ResolutionController,
    NarrativeController,
    EvidenceController,
    FindingsController,
    ReportsController,
    SearchController,
  ],
  providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}

@Module({ imports: [DomainModule], providers: [CollectProcessor] })
export class WorkerModule {}
