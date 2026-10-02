import { Controller, Get, Injectable, Logger, Query } from '@nestjs/common';
import { DbService } from '../../common/db.service';
import { AuthUser } from '../../common/types';
import { CurrentUser } from '../../common/auth';
import { PolicyService } from '../policy/policy.service';

export interface AuditInput {
  actor?: AuthUser | null;
  action: string;
  objectType: string;
  objectId?: string | null;
  caseId?: string | null;
  requestId?: string | null;
  detail?: Record<string, unknown>;
}

/** Immutable append-only audit trail (enforced by DB trigger). */
@Injectable()
export class AuditService {
  private readonly log = new Logger('Audit');
  constructor(private readonly db: DbService) {}

  async record(e: AuditInput): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO audit.audit_events(actor_id, actor_name, action, object_type, object_id, case_id, request_id, detail)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          e.actor?.id ?? null,
          e.actor?.username ?? 'system',
          e.action,
          e.objectType,
          e.objectId ?? null,
          e.caseId ?? null,
          e.requestId ?? null,
          JSON.stringify(e.detail ?? {}),
        ],
      );
    } catch (err) {
      // Audit failures must be visible; they are never silently swallowed.
      this.log.error(`Audit write failed for ${e.action}: ${err.message}`);
      throw err;
    }
  }
}

@Controller('audit')
export class AuditController {
  constructor(
    private readonly db: DbService,
    private readonly policy: PolicyService,
  ) {}

  @Get()
  async list(
    @CurrentUser() user: AuthUser,
    @Query('caseId') caseId?: string,
    @Query('action') action?: string,
    @Query('limit') limit = '200',
  ) {
    if (caseId) await this.policy.assertCaseAccess(user, caseId, 'READ');
    else this.policy.assertAdmin(user);
    const params: unknown[] = [];
    const where: string[] = [];
    if (caseId) where.push(`case_id = $${params.push(caseId)}`);
    if (action) where.push(`action ILIKE $${params.push(`%${action}%`)}`);
    const n = Math.min(1000, Number(limit) || 200);
    return this.db.query(
      `SELECT id, actor_id, actor_name, action, object_type, object_id, case_id, request_id, detail, timestamp
       FROM audit.audit_events ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY timestamp DESC LIMIT ${n}`,
      params,
    );
  }
}
