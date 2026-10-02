import { Component, effect, inject, input, output, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Api, AuthStore, fmtDate, Toast } from '../../core/api';
import { TYPE_LABEL } from '../../core/entity-style';
import { ConfBar, EntChip, EntIcon } from '../../shared/ui';
import { CaseContext } from './case-context';

/** Entity profile: identifiers, attributes with provenance, relationships, evidence, transforms and review. */
@Component({
  selector: 'entity-panel',
  imports: [FormsModule, RouterLink, EntIcon, EntChip, ConfBar],
  template: `
    @if (p(); as d) {
      <div class="col" style="gap:12px">
        <div class="row" style="align-items:flex-start">
          <ent-icon [type]="d.entity.type" [size]="34" />
          <div class="grow">
            <div class="row"><b class="break" [class.mono]="d.entity.masked">{{ revealed()?.label ?? d.entity.label }}</b></div>
            <div class="small muted">{{ label[d.entity.type] }} · {{ d.entity.isSeed ? 'seed · ' : '' }}first seen {{ fmt(d.entity.firstSeen) }}</div>
            <div class="row mt" style="gap:6px">
              <span class="badge {{ d.entity.status }}">{{ d.entity.status }}</span>
              <conf-bar [value]="d.entity.confidence" />
              @if (d.entity.properties?.demo) { <span class="badge demo">fictional demo</span> }
            </div>
          </div>
        </div>

        @if (d.entity.masked && !revealed()) {
          <div class="row small">
            <span class="muted grow">Identifier masked (PII).</span>
            @if (auth.user()?.canRevealPii) {
              <input [(ngModel)]="reason" placeholder="Reason (audited)" style="width:150px" />
              <button class="sm" (click)="reveal()" [disabled]="reason.trim().length < 5">Reveal</button>
            } @else { <span class="faint tiny">no reveal permission</span> }
          </div>
        }

        @if (compact()) {
          <div class="row">
            <button class="sm" (click)="expand.emit({ id: d.entity.id, depth: 1 })">Expand neighbours</button>
            <button class="sm" (click)="expand.emit({ id: d.entity.id, depth: 2 })">Depth 2</button>
            <a class="btn sm" [routerLink]="['/cases', d.entity.caseId, 'entities', d.entity.id]">Full profile</a>
          </div>
        }

        @if (ctx.canEdit()) {
          <div>
            <h4>Transforms</h4>
            <div class="col" style="gap:4px">
              @for (t of transforms(); track t.key) {
                <div class="tr row" [class.off]="!t.runnable">
                  <span class="badge tier">{{ t.tier }}</span>
                  <div class="grow"><div class="small"><b>{{ t.name }}</b></div>
                    @if (!t.runnable) { <div class="tiny faint">blocked: {{ t.blockedReason }}</div> }</div>
                  <button class="sm" [disabled]="!t.runnable || running() === t.key" (click)="run(t.key)">{{ running() === t.key ? '…' : 'Run' }}</button>
                </div>
              } @empty { <div class="small faint">No transforms accept this entity type.</div> }
            </div>
          </div>
        }

        @if (propEntries().length) {
          <div><h4>Properties</h4>
            <dl class="kv">@for (kv of propEntries(); track kv[0]) { <dt>{{ kv[0] }}</dt><dd>{{ kv[1] }}</dd> }</dl></div>
        }

        @if (d.attributes.length) {
          <div><h4>Attributes (with provenance)</h4>
            <table class="t"><tbody>
              @for (a of d.attributes; track $index) {
                <tr><td class="small muted">{{ a.key }}</td><td class="small break">{{ a.value }}</td>
                  <td class="tiny faint nowrap">{{ a.source_name }}@if (a.evidence_id) { · <a [routerLink]="['/cases', d.entity.caseId, 'evidence']" [queryParams]="{ id: a.evidence_id }">evidence</a> }</td></tr>
              }
            </tbody></table></div>
        }

        <div><h4>Relationships ({{ d.relationships.length }})</h4>
          <table class="t"><tbody>
            @for (r of d.relationships.slice(0, relLimit()); track r.id) {
              <tr>
                <td class="tiny nowrap"><span class="faint">{{ r.direction === 'OUT' ? '→' : '←' }}</span> {{ r.type }}
                  <div class="faint">{{ r.label }}</div></td>
                <td class="small">@if (r.other) { <a (click)="select.emit(r.other.id)" style="cursor:pointer"><ent-chip [type]="r.other.type" [label]="r.other.label" [masked]="r.other.masked" [size]="16" /></a> }</td>
                <td><conf-bar [value]="r.confidence" />
                  <div class="row" style="gap:4px;margin-top:3px"><span class="badge {{ r.status }}">{{ r.status }}</span>
                    @if (r.evidenceId) { <a class="tiny" [routerLink]="['/cases', d.entity.caseId, 'evidence']" [queryParams]="{ id: r.evidenceId }">evidence</a> }</div>
                  @if (ctx.canEdit() && r.status === 'CANDIDATE') {
                    <div class="row" style="gap:4px;margin-top:3px">
                      <button class="sm" (click)="reviewRel(r.id, 'CONFIRMED')" [disabled]="!r.evidenceId">Confirm</button>
                      <button class="sm danger" (click)="reviewRel(r.id, 'REJECTED')">Reject</button></div>
                  }
                </td>
              </tr>
            }
          </tbody></table>
          @if (d.relationships.length > relLimit()) { <button class="ghost sm" (click)="relLimit.set(relLimit() + 50)">Show more</button> }
        </div>

        @if (d.resolutionCandidates.length) {
          <div><h4>Resolution candidates</h4>
            @for (c of d.resolutionCandidates; track c.id) {
              <div class="row small" style="padding:3px 0"><span class="badge {{ c.status }}">{{ c.status }}</span>
                <a class="grow" (click)="select.emit(c.other_id)" style="cursor:pointer">{{ c.other_label }}</a><span class="mono">{{ c.score.toFixed(2) }}</span></div>
            }
            <a class="small" [routerLink]="['/cases', d.entity.caseId, 'resolution']">Open Resolution Workbench</a>
          </div>
        }

        @if (d.searchExpansion.length > 1) {
          <div><h4>Search expansion</h4><div class="col" style="gap:3px">@for (q of d.searchExpansion; track q) { <code>{{ q }}</code> }</div></div>
        }

        @if (ctx.canEdit()) {
          <div class="row">
            <span class="small muted grow">Analyst decision</span>
            <button class="sm" (click)="setStatus('RESOLVED')">Mark resolved</button>
            <button class="sm danger" (click)="setStatus('REJECTED')">Reject (not target)</button>
          </div>
        }
      </div>
    } @else {
      <div class="empty"><span class="spin"></span></div>
    }
  `,
  styles: `
    .tr { padding: 5px 8px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-2); }
    .tr.off { opacity: .6; }
    h4 { margin-bottom: 6px; }
  `,
})
export class EntityPanel {
  entityId = input.required<string>();
  compact = input(false);
  expand = output<{ id: string; depth: number }>();
  select = output<string>();
  private api = inject(Api);
  private toast = inject(Toast);
  auth = inject(AuthStore);
  ctx = inject(CaseContext);
  label = TYPE_LABEL;
  fmt = fmtDate;
  p = signal<any | null>(null);
  transforms = signal<any[]>([]);
  revealed = signal<any | null>(null);
  running = signal<string | null>(null);
  relLimit = signal(40);
  propEntries = signal<[string, string][]>([]);
  reason = '';

  constructor() {
    effect(() => {
      const id = this.entityId();
      this.ctx.version();
      untracked(() => void this.load(id));
    });
  }

  async load(id: string) {
    try {
      const [p, t] = await Promise.all([this.api.get(`/entities/${id}`), this.api.get<any[]>(`/entities/${id}/transforms`)]);
      if (id !== this.entityId()) return;
      if (this.p()?.entity?.id !== id) this.revealed.set(null);
      this.p.set(p);
      this.transforms.set(t);
      const props = p.entity.properties ?? {};
      this.propEntries.set(
        Object.entries(props)
          .filter(([k, v]) => v !== null && v !== '' && !['aliases', 'demo'].includes(k) && typeof v !== 'object')
          .map(([k, v]) => [k, String(v)] as [string, string])
          .concat(Array.isArray(props.aliases) && props.aliases.length ? [['aliases', props.aliases.join(', ')]] : []),
      );
    } catch (e) {
      this.toast.error(e);
    }
  }

  async run(key: string) {
    this.running.set(key);
    try {
      await this.api.post(`/entities/${this.entityId()}/transforms/${key}`);
      this.toast.show(`Transform ${key} queued`);
      await this.ctx.pollJobs();
    } catch (e) {
      this.toast.error(e);
    } finally {
      this.running.set(null);
    }
  }

  async reveal() {
    try {
      this.revealed.set(await this.api.post(`/entities/${this.entityId()}/reveal`, { reason: this.reason }));
      this.reason = '';
    } catch (e) {
      this.toast.error(e);
    }
  }

  async reviewRel(id: string, status: string) {
    try {
      await this.api.post(`/relationships/${id}/review`, { status });
      this.ctx.bump();
    } catch (e) {
      this.toast.error(e);
    }
  }

  async setStatus(status: string) {
    try {
      await this.api.post(`/entities/${this.entityId()}/status`, { status });
      this.ctx.bump();
    } catch (e) {
      this.toast.error(e);
    }
  }
}
