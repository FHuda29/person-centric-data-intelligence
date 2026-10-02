import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Api, fmtDate, Toast } from '../../core/api';
import { CaseContext } from './case-context';

@Component({
  selector: 'app-timeline',
  imports: [FormsModule, RouterLink],
  template: `
    <div class="page" style="max-width:1000px">
      <div class="row mb wrap">
        <label class="field">From<input type="date" [(ngModel)]="from" /></label>
        <label class="field">To<input type="date" [(ngModel)]="to" /></label>
        <label class="field">Source<select [(ngModel)]="source"><option value="">All</option>@for (s of sources(); track s) { <option>{{ s }}</option> }</select></label>
        <button class="sm" style="align-self:flex-end" (click)="load()">Apply</button>
        <span class="spacer"></span>
        <label class="check" style="align-self:flex-end"><input type="checkbox" [(ngModel)]="datedOnly" /> Published date only</label>
      </div>
      @for (g of groups(); track g.day) {
        <div class="day"><span class="mono">{{ g.day }}</span><span class="faint small">{{ g.items.length }} item(s)</span></div>
        @for (it of g.items; track it.id + it.kind) {
          <div class="item" [class]="it.kind">
            <span class="time mono tiny">{{ it.time.slice(11, 16) }}</span>
            <span class="k badge">{{ it.kind }}</span>
            <div class="grow">
              @if (it.kind === 'CONTENT') {
                <div>{{ it.title }}</div>
                <div class="tiny faint">{{ it.author }} · {{ it.source_name }} @if (!it.dated) { · <i>retrieval time (no publish date)</i> }
                  · <a [routerLink]="['../evidence']" [queryParams]="{ id: it.evidence_id }">evidence</a>
                  @if (it.url && it.url.startsWith('http')) { · <a [href]="it.url" target="_blank" rel="noopener noreferrer">source ↗</a> }</div>
              } @else if (it.kind === 'FINDING') {
                <div><a routerLink="../findings">{{ it.title }}</a> <span class="badge {{ it.status }}">{{ it.status }}</span></div>
              } @else { <div><b>{{ it.title }}</b></div> }
            </div>
          </div>
        }
      } @empty { <div class="empty">No dated items yet.</div> }
    </div>
  `,
  styles: `
    .day { display: flex; gap: 10px; align-items: baseline; margin: 18px 0 6px; padding-bottom: 4px; border-bottom: 1px solid var(--border); }
    .item { display: flex; gap: 10px; padding: 6px 0 6px 12px; border-left: 2px solid var(--border-2); margin-left: 6px; }
    .item.EVENT { border-left-color: var(--danger); } .item.FINDING { border-left-color: var(--ok); }
    .time { width: 38px; color: var(--muted); padding-top: 2px; } .k { flex: none; }
  `,
})
export class TimelinePage {
  private api = inject(Api);
  private toast = inject(Toast);
  ctx = inject(CaseContext);
  fmt = fmtDate;
  from = '';
  to = '';
  source = '';
  datedOnly = false;
  items = signal<any[]>([]);
  sources = computed(() => [...new Set(this.items().filter((i) => i.source).map((i) => i.source))]);
  groups = computed(() => {
    const m = new Map<string, any[]>();
    for (const it of this.items()) {
      if (this.datedOnly && !it.dated) continue;
      const t = new Date(it.time).toISOString();
      const day = t.slice(0, 10);
      m.set(day, [...(m.get(day) ?? []), { ...it, time: t }]);
    }
    return [...m].map(([day, items]) => ({ day, items }));
  });

  constructor() {
    effect(() => {
      this.ctx.version();
      if (this.ctx.caseId()) untracked(() => void this.load());
    });
  }

  async load() {
    try {
      this.items.set(
        await this.api.get(`/cases/${this.ctx.caseId()}/timeline`, {
          from: this.from ? `${this.from}T00:00:00Z` : null,
          to: this.to ? `${this.to}T23:59:59Z` : null,
          source: this.source,
        }),
      );
    } catch (e) {
      this.toast.error(e);
    }
  }
}
