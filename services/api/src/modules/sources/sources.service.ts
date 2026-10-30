import { BadRequestException, Body, Controller, Get, Injectable, Logger, NotFoundException, Param, Patch } from '@nestjs/common';
import { CurrentUser, RequestId, Roles } from '../../common/auth';
import { DbService } from '../../common/db.service';
import { AuthUser } from '../../common/types';
import { AuditService } from '../audit/audit.service';
import { IdentityService } from '../identity/identity.service';
import {
  DnsConnector,
  IdentifierParserConnector,
  internalSources,
  RdapConnector,
  WikidataConnector,
  WikipediaConnector,
} from '../connectors/basic.connectors';
import { Connector } from '../connectors/connector.types';
import { DemoDatasetConnector } from '../connectors/demo.connector';
import {
  BraveSearchConnector,
  GdeltConnector,
  GithubConnector,
  GravatarConnector,
  NumverifyConnector,
  UsernamePresenceConnector,
  WebPageConnector,
} from '../connectors/web.connectors';
import {
  BlueskyActorsConnector,
  BlueskyPostsConnector,
  GithubUserSearchConnector,
  GoogleNewsRssConnector,
  HackerNewsSearchConnector,
  MastodonAccountsConnector,
  RedditapisSearchConnector,
  RedditSearchConnector,
  SandbaseInstagramUsersConnector,
  SandbaseTiktokSearchConnector,
  SandbaseXSearchConnector,
  SearxNewsConnector,
  SearxSocialConnector,
  SearxWebConnector,
  StackExchangeUsersConnector,
  XRecentSearchConnector,
  YoutubeSearchConnector,
} from '../connectors/social.connectors';

export interface SourceRow {
  id: string;
  connector_key: string;
  name: string;
  tier: string;
  access_method: string;
  policy_state: 'APPROVED' | 'PENDING' | 'DISABLED';
  connector_status: string;
  rate_limit_per_min: number;
  input_types: string[];
  [k: string]: any;
}

/** Source Registry (paper §6): every connector is registered with owner, legal basis, limits and policy state. */
@Injectable()
export class SourcesService {
  private readonly log = new Logger('SourceRegistry');
  readonly connectors = new Map<string, Connector>();

  constructor(
    private readonly db: DbService,
    identity: IdentityService,
  ) {
    const all: Connector[] = [
      new IdentifierParserConnector(),
      new DnsConnector(),
      new RdapConnector(),
      new WikidataConnector(),
      new WikipediaConnector(),
      new GdeltConnector(),
      new WebPageConnector(),
      new GithubConnector(),
      new UsernamePresenceConnector(),
      new GravatarConnector(),
      new NumverifyConnector(),
      new BraveSearchConnector((t, l, ctx) => identity.expand(t, l, ctx)),
      new SearxWebConnector((t, l, ctx) => identity.expand(t, l, ctx)),
      new SearxSocialConnector(),
      new SearxNewsConnector(),
      new GoogleNewsRssConnector(),
      new BlueskyActorsConnector(),
      new MastodonAccountsConnector(),
      new StackExchangeUsersConnector(),
      new GithubUserSearchConnector(),
      new HackerNewsSearchConnector(),
      new RedditSearchConnector(),
      new YoutubeSearchConnector(),
      new XRecentSearchConnector(),
      new BlueskyPostsConnector(),
      new RedditapisSearchConnector(),
      new SandbaseXSearchConnector(),
      new SandbaseInstagramUsersConnector(),
      new SandbaseTiktokSearchConnector(),
      new DemoDatasetConnector(),
      ...internalSources(),
    ];
    for (const c of all) this.connectors.set(c.def.key, c);
  }

  /** Registers connectors; policy_state set by an admin is preserved across restarts. */
  async sync(): Promise<void> {
    for (const c of this.connectors.values()) {
      const d = c.def;
      const status = d.requiresCredential?.() ? 'NEEDS_CREDENTIALS' : 'READY';
      await this.db.query(
        `INSERT INTO sources.sources(connector_key, name, owner, category, tier, access_method, base_url, legal_basis,
           auth_mode, rate_limit_per_min, allowed_fields, input_types, output_types, retention_days, policy_state,
           connector_status, description)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
         ON CONFLICT (connector_key) DO UPDATE SET name = EXCLUDED.name, owner = EXCLUDED.owner,
           category = EXCLUDED.category, tier = EXCLUDED.tier, access_method = EXCLUDED.access_method,
           base_url = EXCLUDED.base_url, legal_basis = EXCLUDED.legal_basis, auth_mode = EXCLUDED.auth_mode,
           allowed_fields = EXCLUDED.allowed_fields, input_types = EXCLUDED.input_types,
           output_types = EXCLUDED.output_types, connector_status = EXCLUDED.connector_status,
           description = EXCLUDED.description`,
        [
          d.key, d.name, d.owner, d.category, d.tier, d.accessMethod, (d as any).baseUrl ?? null, d.legalBasis,
          d.authMode, d.rateLimitPerMin, d.allowedFields, d.inputTypes, d.outputTypes, d.retentionDays,
          d.defaultPolicy, status, d.description,
        ],
      );
    }
    this.log.log(`Source registry synced (${this.connectors.size} connectors)`);
  }

  async list(): Promise<SourceRow[]> {
    const rows = await this.db.query<SourceRow>('SELECT * FROM sources.sources ORDER BY tier, name');
    return rows.map((r) => ({ ...r, auto_run: this.connectors.get(r.connector_key)?.def.autoRun ?? false }));
  }

  async byKey(key: string): Promise<SourceRow> {
    const r = await this.db.one<SourceRow>('SELECT * FROM sources.sources WHERE connector_key = $1', [key]);
    if (!r) throw new NotFoundException(`Unknown source ${key}`);
    return r;
  }

  /** Source policy gate: collector never executes disabled/unapproved or unconfigured sources (paper §16). */
  isRunnable(s: SourceRow): { ok: boolean; reason?: string } {
    if (s.policy_state !== 'APPROVED') return { ok: false, reason: `source policy is ${s.policy_state}` };
    if (s.connector_status !== 'READY') return { ok: false, reason: `connector status ${s.connector_status}` };
    if (!this.connectors.has(s.connector_key)) return { ok: false, reason: 'connector not installed' };
    return { ok: true };
  }
}

@Controller('sources')
export class SourcesController {
  constructor(
    private readonly sources: SourcesService,
    private readonly db: DbService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  list() {
    return this.sources.list();
  }

  @Patch(':id')
  @Roles('ADMIN')
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() b: { policy_state?: string; rate_limit_per_min?: number; retention_days?: number; legal_basis?: string },
    @RequestId() rid: string,
  ) {
    if (b.policy_state && !['APPROVED', 'PENDING', 'DISABLED'].includes(b.policy_state)) {
      throw new BadRequestException('Invalid policy_state');
    }
    const before = await this.db.one('SELECT policy_state, rate_limit_per_min FROM sources.sources WHERE id = $1', [id]);
    if (!before) throw new NotFoundException();
    const row = await this.db.one(
      `UPDATE sources.sources SET policy_state = COALESCE($2, policy_state),
         rate_limit_per_min = COALESCE($3, rate_limit_per_min), retention_days = COALESCE($4, retention_days),
         legal_basis = COALESCE($5, legal_basis), updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id, b.policy_state ?? null, b.rate_limit_per_min ?? null, b.retention_days ?? null, b.legal_basis ?? null],
    );
    await this.audit.record({ actor: user, action: 'source.policy.updated', objectType: 'source', objectId: id, requestId: rid, detail: { before, after: b } });
    return row;
  }
}
