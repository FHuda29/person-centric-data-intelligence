import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CurrentUser, RequestId, Roles } from '../../common/auth';
import { DbService } from '../../common/db.service';
import { StorageService } from '../../common/storage.service';
import { escapeHtml as h, maskValue, sha256 } from '../../common/text';
import { AuthUser, PII_TYPES } from '../../common/types';
import { AuditService } from '../audit/audit.service';
import { NarrativeService } from '../narrative/narrative.service';
import { PolicyService } from '../policy/policy.service';

const STATUS_COLOR: Record<string, string> = {
  CONFIRMED: '#15803d',
  CORROBORATED: '#2563eb',
  UNVERIFIED: '#b45309',
  CONTRADICTED: '#b91c1c',
  REJECTED: '#6b7280',
};

@Controller('reports')
export class ReportsController {
  constructor(
    private readonly db: DbService,
    private readonly storage: StorageService,
    private readonly policy: PolicyService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async list(@CurrentUser() user: AuthUser, @Query('caseId') caseId: string) {
    await this.policy.assertCaseAccess(user, caseId, 'READ');
    return this.db.query(
      `SELECT r.id, r.title, r.hash, r.classification, r.created_at, u.username AS created_by_name
       FROM intelligence.reports r LEFT JOIN iam.users u ON u.id = r.created_by WHERE r.case_id = $1 ORDER BY r.created_at DESC`,
      [caseId],
    );
  }

  /** Builds an HTML intelligence report: findings + evidence status + timestamps, watermarked with classification. */
  @Post()
  @Roles('ADMIN', 'ANALYST')
  async create(
    @CurrentUser() user: AuthUser,
    @Body() b: { caseId: string; title?: string; includeRejected?: boolean; revealPii?: boolean },
    @RequestId() rid: string,
  ) {
    await this.policy.assertCaseAccess(user, b.caseId, 'EDIT');
    if (b.revealPii && !user.canRevealPii) throw new BadRequestException('PII reveal permission required to export unmasked identifiers');
    const c = await this.db.one('SELECT c.*, u.display_name AS owner_name FROM cases.cases c JOIN iam.users u ON u.id = c.owner_id WHERE c.id = $1', [b.caseId]);
    const findings = await this.db.query(
      `SELECT f.*, ru.username AS reviewer FROM intelligence.findings f LEFT JOIN iam.users ru ON ru.id = f.reviewed_by
       WHERE f.case_id = $1 ${b.includeRejected ? '' : `AND f.status <> 'REJECTED'`}
       ORDER BY CASE f.status WHEN 'CONFIRMED' THEN 0 WHEN 'CORROBORATED' THEN 1 WHEN 'UNVERIFIED' THEN 2 WHEN 'CONTRADICTED' THEN 3 ELSE 4 END, f.created_at`,
      [b.caseId],
    );
    if (!findings.length) throw new BadRequestException('The case has no findings to report');
    const fe = await this.db.query(
      `SELECT fe.finding_id, e.id, e.url, e.title, e.retrieved_at, e.published_at, e.hash, e.access_method, s.name AS source, s.tier
       FROM intelligence.finding_evidence fe JOIN evidence.evidence e ON e.id = fe.evidence_id
       LEFT JOIN sources.sources s ON s.id = e.source_id
       WHERE fe.finding_id = ANY($1::uuid[]) ORDER BY e.retrieved_at`,
      [findings.map((f) => f.id)],
    );
    const entityIds = [...new Set(findings.flatMap((f) => f.entity_ids ?? []))];
    const ents = entityIds.length
      ? await this.db.query('SELECT id, canonical_type, label, confidence, resolution_status FROM intelligence.entities WHERE id = ANY($1::uuid[])', [entityIds])
      : [];
    const label = (e: any) => (PII_TYPES.has(e.canonical_type) && !b.revealPii ? maskValue(e.canonical_type, e.label) : e.label);
    const narratives = await this.db.query(
      `SELECT kind, topic, source_count, first_seen, last_seen, array_length(observation_ids,1) AS n FROM intelligence.narratives
       WHERE case_id = $1 AND kind = 'CLAIM' ORDER BY source_count DESC LIMIT 10`,
      [b.caseId],
    );
    const sources = await this.db.query(
      `SELECT DISTINCT s.name, s.tier, s.access_method, s.legal_basis FROM evidence.evidence e JOIN sources.sources s ON s.id = e.source_id
       WHERE e.id = ANY($1::uuid[]) ORDER BY s.tier`,
      [fe.map((x) => x.id)],
    );
    const generatedAt = new Date().toISOString();
    const title = b.title?.trim() || `Intelligence Report — ${c.code}`;
    const counts = findings.reduce((acc: Record<string, number>, f) => ((acc[f.status] = (acc[f.status] ?? 0) + 1), acc), {});
    const cls = h(c.classification);
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${h(title)}</title>
<style>
body{font-family:Georgia,'Times New Roman',serif;color:#111827;max-width:900px;margin:0 auto;padding:40px 32px;line-height:1.5;position:relative}
body::before{content:'${cls} · ${h(c.code)} · ${h(user.username)}';position:fixed;top:45%;left:-10%;width:120%;text-align:center;transform:rotate(-24deg);
font:700 56px/1 Arial,sans-serif;color:rgba(185,28,28,.07);pointer-events:none;white-space:nowrap}
.banner{background:#7f1d1d;color:#fff;text-align:center;font:700 12px Arial;letter-spacing:.2em;padding:6px;margin:-40px -32px 24px}
h1{font-size:26px;margin:0 0 4px}h2{font-size:18px;border-bottom:2px solid #1e3a5f;padding-bottom:4px;margin-top:32px;color:#1e3a5f}
table{border-collapse:collapse;width:100%;font:13px Arial,sans-serif}th,td{border:1px solid #d1d5db;padding:6px 8px;text-align:left;vertical-align:top}
th{background:#eef2f7}.meta td:first-child{width:180px;font-weight:600}
.f{border:1px solid #d1d5db;border-left:6px solid var(--c);padding:12px 16px;margin:14px 0;page-break-inside:avoid}
.pill{display:inline-block;font:700 11px Arial;color:#fff;background:var(--c);padding:2px 8px;border-radius:10px;letter-spacing:.05em}
.small{font:12px Arial;color:#4b5563}.mono{font-family:Consolas,monospace;font-size:11px;word-break:break-all}
.note{background:#fffbeb;border:1px solid #fcd34d;padding:10px 14px;font:13px Arial}
</style></head><body>
<div class="banner">${cls}</div>
<h1>${h(title)}</h1>
<div class="small">Generated ${h(generatedAt)} by ${h(user.displayName)} (${h(user.username)}) · Person-Centric Data Intelligence Platform</div>
<h2>1. Case</h2>
<table class="meta">
<tr><td>Case</td><td>${h(c.code)} — ${h(c.title)}</td></tr>
<tr><td>Purpose</td><td>${h(c.purpose)}</td></tr>
<tr><td>Scope</td><td>${h(c.scope ?? '—')}</td></tr>
<tr><td>Legal / access basis</td><td>${h(c.legal_basis ?? '—')}</td></tr>
<tr><td>Owner</td><td>${h(c.owner_name)}</td></tr>
<tr><td>Classification</td><td>${cls}</td></tr>
<tr><td>Retention until</td><td>${h(new Date(c.retention_until).toISOString().slice(0, 10))}</td></tr>
</table>
<h2>2. Summary of findings</h2>
<table><tr>${Object.keys(STATUS_COLOR).map((s) => `<th>${s}</th>`).join('')}</tr>
<tr>${Object.keys(STATUS_COLOR).map((s) => `<td>${counts[s] ?? 0}</td>`).join('')}</tr></table>
<p class="note">Evidence status definitions — CONFIRMED: primary/authoritative source or direct lawful evidence · CORROBORATED: two or more
independent relevant sources · UNVERIFIED: claim without sufficient independent evidence · CONTRADICTED: credible conflicting evidence ·
REJECTED: analyst determined not the target or not relevant. Claim types separate observed facts, source claims, analytical inference and
unverified information.</p>
<h2>3. Findings</h2>
${findings
  .map((f, i) => {
    const evs = fe.filter((x) => x.finding_id === f.id);
    const fents = ents.filter((e) => (f.entity_ids ?? []).includes(e.id));
    return `<div class="f" style="--c:${STATUS_COLOR[f.status]}">
<div><span class="pill">${h(f.status)}</span> <span class="small">${h(f.claim_type.replace(/_/g, ' '))} · confidence ${Number(f.confidence).toFixed(2)}</span></div>
<h3 style="margin:8px 0 4px">${i + 1}. ${h(f.title)}</h3>
<p style="margin:4px 0">${h(f.statement)}</p>
${f.analyst_note ? `<p class="small"><b>Analyst note:</b> ${h(f.analyst_note)}</p>` : ''}
${fents.length ? `<p class="small"><b>Entities:</b> ${fents.map((e) => `${h(label(e))} (${h(e.canonical_type)})`).join('; ')}</p>` : ''}
<table><tr><th>#</th><th>Evidence</th><th>Source (tier)</th><th>Published</th><th>Retrieved</th><th>SHA-256</th></tr>
${evs
  .map(
    (e, k) => `<tr><td>${k + 1}</td><td>${h(e.title ?? '')}<br><span class="mono">${h(e.url ?? 'internal:' + e.id)}</span></td>
<td>${h(e.source ?? '')} (${h(e.tier ?? '')})<br><span class="small">${h(e.access_method)}</span></td>
<td>${e.published_at ? h(new Date(e.published_at).toISOString()) : '—'}</td><td>${h(new Date(e.retrieved_at).toISOString())}</td>
<td class="mono">${h(e.hash)}</td></tr>`,
  )
  .join('')}</table>
<div class="small">Created ${h(new Date(f.created_at).toISOString())}${f.reviewed_at ? ` · reviewed ${h(new Date(f.reviewed_at).toISOString())} by ${h(f.reviewer)}` : ' · not yet reviewed'}</div>
</div>`;
  })
  .join('\n')}
${
  narratives.length
    ? `<h2>4. Narrative observations</h2><p class="note">${h(NarrativeService.DISCLAIMER)}</p>
<table><tr><th>Repeated claim</th><th>Distinct actors</th><th>Items</th><th>First seen</th><th>Last seen</th></tr>
${narratives.map((n) => `<tr><td>${h(n.topic)}</td><td>${n.source_count}</td><td>${n.n}</td><td>${h(new Date(n.first_seen).toISOString())}</td><td>${h(new Date(n.last_seen).toISOString())}</td></tr>`).join('')}</table>`
    : ''
}
<h2>${narratives.length ? 5 : 4}. Sources used</h2>
<table><tr><th>Source</th><th>Tier</th><th>Access method</th><th>Legal / access basis</th></tr>
${sources.map((s) => `<tr><td>${h(s.name)}</td><td>${h(s.tier)}</td><td>${h(s.access_method)}</td><td>${h(s.legal_basis)}</td></tr>`).join('')}</table>
<p class="small" style="margin-top:32px">Identifiers are ${b.revealPii ? 'shown unmasked (authorised export)' : 'masked'} in this report.
Centrality, similarity and timing measures describe structure in collected data and are not evidence of coordination or intent.
This report is a technical intelligence product, not a legal opinion.</p>
</body></html>`;
    const buf = Buffer.from(html, 'utf8');
    const hash = sha256(buf);
    const ref = await this.storage.put(`cases/${b.caseId}/reports/${hash}.html`, buf, 'text/html');
    const r = await this.db.one(
      `INSERT INTO intelligence.reports(case_id, title, object_ref, hash, classification, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, title, hash, created_at`,
      [b.caseId, title, ref, hash, c.classification, user.id],
    );
    await this.audit.record({ actor: user, action: 'report.generated', objectType: 'report', objectId: r.id, caseId: b.caseId, requestId: rid, detail: { findings: findings.length, revealPii: !!b.revealPii, hash } });
    return r;
  }

  /** Export (download) of a report — permission-checked and audited. */
  @Get(':id/download')
  @Roles('ADMIN', 'ANALYST')
  async download(@CurrentUser() user: AuthUser, @Param('id') id: string, @RequestId() rid: string, @Res() res: Response) {
    const r = await this.db.one('SELECT * FROM intelligence.reports WHERE id = $1', [id]);
    if (!r) throw new NotFoundException();
    await this.policy.assertCaseAccess(user, r.case_id, 'READ');
    await this.audit.record({ actor: user, action: 'report.exported', objectType: 'report', objectId: id, caseId: r.case_id, requestId: rid });
    const buf = await this.storage.getBuffer(r.object_ref);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="report-${r.hash.slice(0, 12)}.html"`);
    res.setHeader('X-Content-SHA256', r.hash);
    res.send(buf);
  }
}
