import { Component, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Api, fmtDate, Toast } from '../../core/api';
import { ENTITY_TYPES, TYPE_LABEL } from '../../core/entity-style';
import { ConfBar, EntChip } from '../../shared/ui';
import { CaseContext } from './case-context';

@Component({
  selector: 'app-entities',
  imports: [FormsModule, RouterLink, EntChip, ConfBar],
  template: `
    <div class="page">
      <div class="row mb wrap">
        <input placeholder="Filter by label…" [(ngModel)]="q" (keyup.enter)="load(0)" style="width:240px" />
        <select [(ngModel)]="type" (ngModelChange)="load(0)"><option value="">All types</option>@for (t of types; track t) { <option [value]="t">{{ label[t] }}</option> }</select>
        <select [(ngModel)]="status" (ngModelChange)="load(0)"><option value="">Any status</option><option>CANDIDATE</option><option>RESOLVED</option><option>REJECTED</option></select>
        <button class="sm" (click)="load(0)">Apply</button>
        <span class="spacer"></span><span class="small muted">{{ total() }} entities · PII masked in list view</span>
      </div>
      <div class="card flush">
        <table class="t">
          <thead><tr><th>Entity</th><th>Type</th><th>Status</th><th>Confidence</th><th>Links</th><th>Source</th><th>Last seen</th></tr></thead>
          <tbody>
            @for (e of items(); track e.id) {
              <tr>
                <td style="max-width:420px"><a [routerLink]="[e.id]"><ent-chip [type]="e.type" [label]="e.label" [masked]="e.masked" /></a>
                  @if (e.isSeed) { <span class="badge" style="margin-left:6px">seed</span> }</td>
                <td class="small muted nowrap">{{ label[e.type] }}</td>
                <td><span class="badge {{ e.status }}">{{ e.status }}</span></td>
                <td><conf-bar [value]="e.confidence" /></td>
                <td>{{ e.degree }}</td>
                <td class="small faint nowrap">{{ e.properties?.source ?? '—' }}</td>
                <td class="small nowrap">{{ fmt(e.lastSeen) }}</td>
              </tr>
            } @empty { <tr><td colspan="7" class="empty">No entities match.</td></tr> }
          </tbody>
        </table>
      </div>
      <div class="row mt"><span class="spacer"></span>
        <button class="sm" [disabled]="offset() === 0" (click)="load(offset() - 100)">Previous</button>
        <span class="small muted">{{ offset() + 1 }}–{{ offset() + items().length }}</span>
        <button class="sm" [disabled]="offset() + 100 >= total()" (click)="load(offset() + 100)">Next</button>
      </div>
    </div>
  `,
})
export class EntitiesPage {
  private api = inject(Api);
  private toast = inject(Toast);
  ctx = inject(CaseContext);
  types = ENTITY_TYPES;
  label = TYPE_LABEL;
  fmt = fmtDate;
  q = '';
  type = '';
  status = '';
  items = signal<any[]>([]);
  total = signal(0);
  offset = signal(0);

  constructor() {
    effect(() => {
      this.ctx.version();
      if (this.ctx.caseId()) untracked(() => void this.load(this.offset()));
    });
  }

  async load(offset: number) {
    try {
      const r = await this.api.get<any>('/entities', { caseId: this.ctx.caseId(), q: this.q, type: this.type, status: this.status, limit: 100, offset });
      this.items.set(r.items);
      this.total.set(r.total);
      this.offset.set(offset);
    } catch (e) {
      this.toast.error(e);
    }
  }
}
