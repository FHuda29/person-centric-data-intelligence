import { Component, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Api, fmtDate, Toast } from '../../core/api';
import { CaseContext } from './case-context';

@Component({
  selector: 'app-audit-table',
  imports: [FormsModule],
  template: `
    <div class="page">
      <div class="row mb"><div class="grow"><h1>Audit trail</h1><div class="small muted">Append-only (database-enforced). Searches, reveals, exports, reviews, merges and collection are recorded.</div></div>
        <input placeholder="Filter action…" [(ngModel)]="action" (keyup.enter)="load()" /><button class="sm" (click)="load()">Apply</button></div>
      <div class="card flush"><table class="t">
        <thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Object</th><th>Detail</th><th>Request</th></tr></thead>
        <tbody>
          @for (a of items(); track a.id) {
            <tr><td class="small nowrap">{{ fmt(a.timestamp) }}</td><td class="small">{{ a.actor_name }}</td><td><code>{{ a.action }}</code></td>
              <td class="small">{{ a.object_type }} <span class="faint mono tiny">{{ a.object_id?.slice(0, 8) }}</span></td>
              <td class="tiny muted break" style="max-width:420px">{{ detail(a.detail) }}</td><td class="mono tiny faint">{{ a.request_id?.slice(0, 8) }}</td></tr>
          } @empty { <tr><td colspan="6" class="empty">No audit events.</td></tr> }
        </tbody></table></div>
    </div>
  `,
})
export class CaseAuditPage {
  private api = inject(Api);
  private toast = inject(Toast);
  ctx = inject(CaseContext);
  fmt = fmtDate;
  action = '';
  items = signal<any[]>([]);
  detail = (d: any) => (d && Object.keys(d).length ? JSON.stringify(d).slice(0, 300) : '');

  constructor() {
    effect(() => {
      this.ctx.version();
      if (this.ctx.caseId()) untracked(() => void this.load());
    });
  }

  async load() {
    try {
      this.items.set(await this.api.get('/audit', { caseId: this.ctx.caseId(), action: this.action, limit: 500 }));
    } catch (e) {
      this.toast.error(e);
    }
  }
}
