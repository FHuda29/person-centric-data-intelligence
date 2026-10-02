import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { DbService } from '../../common/db.service';
import { AuthUser } from '../../common/types';

export type Access = 'READ' | 'EDIT';

/** Central policy decisions: case-level ACL (RBAC + membership) and source policy (paper §2, §6, §13). */
@Injectable()
export class PolicyService {
  constructor(private readonly db: DbService) {}

  assertAdmin(user: AuthUser) {
    if (user.role !== 'ADMIN') throw new ForbiddenException('Administrator role required');
  }

  async caseAccess(user: AuthUser, caseId: string): Promise<Access | null> {
    const row = await this.db.one<{ owner_id: string; access: string | null }>(
      `SELECT c.owner_id, m.access FROM cases.cases c
       LEFT JOIN cases.case_members m ON m.case_id = c.id AND m.user_id = $2
       WHERE c.id = $1`,
      [caseId, user.id],
    );
    if (!row) throw new NotFoundException('Case not found');
    if (user.role === 'ADMIN' || row.owner_id === user.id) return user.role === 'VIEWER' ? 'READ' : 'EDIT';
    if (!row.access) return null;
    return user.role === 'VIEWER' ? 'READ' : (row.access as Access);
  }

  async assertCaseAccess(user: AuthUser, caseId: string, need: Access): Promise<void> {
    if (!/^[0-9a-f-]{36}$/i.test(caseId ?? '')) throw new BadRequestException('Valid caseId required');
    const access = await this.caseAccess(user, caseId);
    if (!access) throw new ForbiddenException('No access to this case');
    if (need === 'EDIT' && access !== 'EDIT') throw new ForbiddenException('Read-only access to this case');
  }

  /** Collection is only allowed on open cases that are still within retention. */
  async assertCaseCollectable(caseId: string): Promise<void> {
    const c = await this.db.one(`SELECT status, retention_until FROM cases.cases WHERE id = $1`, [caseId]);
    if (!c) throw new NotFoundException('Case not found');
    if (c.status !== 'OPEN') throw new BadRequestException(`Case is ${c.status}; collection is not permitted`);
    if (new Date(c.retention_until) < new Date()) throw new BadRequestException('Case retention period has expired');
  }

  async caseIdOfEntity(entityId: string): Promise<string> {
    const r = await this.db.one<{ case_id: string }>('SELECT case_id FROM intelligence.entities WHERE id = $1', [
      entityId,
    ]);
    if (!r) throw new NotFoundException('Entity not found');
    return r.case_id;
  }

  async accessibleCaseIds(user: AuthUser): Promise<string[]> {
    const rows = await this.db.query<{ id: string }>(
      user.role === 'ADMIN'
        ? `SELECT id FROM cases.cases WHERE status <> 'PURGED'`
        : `SELECT c.id FROM cases.cases c LEFT JOIN cases.case_members m ON m.case_id = c.id AND m.user_id = $1
           WHERE c.status <> 'PURGED' AND (c.owner_id = $1 OR m.user_id IS NOT NULL)`,
      user.role === 'ADMIN' ? [] : [user.id],
    );
    return rows.map((r) => r.id);
  }
}
