import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api, AuthStore, fmtDate, Toast } from '../core/api';
import { UiIcon } from '../shared/ui';

@Component({
  selector: 'app-cases',
  imports: [FormsModule, RouterLink, UiIcon],
  template: `
    <div class="page">
      <div class="row mb">
        <div class="grow">
          <h1>Cases</h1>
          <div class="muted small">Every search runs inside a case with a documented purpose, scope, classification and retention.</div>
        </div>
        @if (auth.canEdit()) {
          <button (click)="loadDemo()" [disabled]="busy()"><ui-icon name="sparkle" [size]="15" />Demo case</button>
          <button class="primary" (click)="showNew.set(true)"><ui-icon name="plus" [size]="15" />New case</button>
        }
      </div>
      <div class="summary">
        <div class="tile"><span>Total cases</span><b>{{ cases().length }}</b></div>
        <div class="tile"><span>Open</span><b>{{ countBy('OPEN') }}</b></div>
        <div class="tile"><span>Active jobs</span><b>{{ activeJobs() }}</b></div>
        <div class="tile"><span>Findings</span><b>{{ findings() }}</b></div>
      </div>
      <div class="card flush">
        <table class="t stack">
          <thead><tr><th>Code</th><th>Title / purpose</th><th>Status</th><th>Class.</th><th>Entities</th><th>Findings</th><th>Jobs</th><th>Retention</th><th>Owner</th></tr></thead>
          <tbody>
            @for (c of cases(); track c.id) {
              <tr class="case-row" (click)="open(c.id, $event)">
                <td class="nowrap"><a [routerLink]="['/cases', c.id]" class="mono code">{{ c.code }}</a></td>
                <td class="title-cell"><a [routerLink]="['/cases', c.id]"><b>{{ c.title }}</b></a><div class="small muted clamp">{{ c.purpose }}</div></td>
                <td data-label="Status"><span class="badge {{ c.status }}">{{ c.status }}</span></td>
                <td data-label="Classification" class="small">{{ c.classification }}</td>
                <td data-label="Entities">{{ c.entity_count }}</td>
                <td data-label="Findings">{{ c.finding_count }}</td>
                <td data-label="Jobs">@if (c.active_jobs) { <span class="badge RUNNING">{{ c.active_jobs }} active</span> } @else { <span class="faint">—</span> }</td>
                <td data-label="Retention" class="small nowrap">{{ fmt(c.retention_until, false) }}</td>
                <td data-label="Owner" class="small">{{ c.owner_name }}</td>
              </tr>
            } @empty {
              <tr><td colspan="9" class="empty">No cases yet. Create one, or load the fictional demo case to explore the platform offline.</td></tr>
            }
          </tbody>
        </table>
      </div>
    </div>

    @if (showNew()) {
      <div class="modal-bg" (click)="showNew.set(false)">
        <form class="modal col" (click)="$event.stopPropagation()" (ngSubmit)="create()">
          <h2>New case</h2>
          <label class="field">Title<input name="title" [(ngModel)]="form.title" required /></label>
          <label class="field">Purpose (required, documented and audited)
            <textarea name="purpose" rows="3" [(ngModel)]="form.purpose" placeholder="e.g. Approved third-party due diligence on a prospective vendor director"></textarea></label>
          <label class="field">Scope<textarea name="scope" rows="2" [(ngModel)]="form.scope" placeholder="Identifiers, sources and time window in scope"></textarea></label>
          <label class="field">Legal / access basis<input name="legal" [(ngModel)]="form.legalBasis" placeholder="e.g. Contract clause 7.2 / internal policy INT-SEC-04" /></label>
          <div class="grid grid-2">
            <label class="field">Classification
              <select name="cls" [(ngModel)]="form.classification">
                <option>INTERNAL</option><option>CONFIDENTIAL</option><option>RESTRICTED</option>
              </select></label>
            <label class="field">Retention (days)<input name="ret" type="number" min="1" max="3650" [(ngModel)]="form.retentionDays" /></label>
          </div>
          <div class="row"><span class="spacer"></span>
            <button type="button" class="ghost" (click)="showNew.set(false)">Cancel</button>
            <button class="primary" [disabled]="busy() || form.purpose.trim().length < 10 || !form.title.trim()">Create case</button>
          </div>
        </form>
      </div>
    }
  `,
  styles: `
    .summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 16px; }
    .tile { display: flex; flex-direction: column; gap: 6px; padding: 14px 18px; border-radius: var(--radius-lg); background: var(--panel); border: 1px solid var(--border); }
    .tile span { font-size: 12px; color: var(--muted); }
    .tile b { font-size: 24px; font-weight: 600; letter-spacing: -.02em; line-height: 1; font-variant-numeric: tabular-nums; }
    .case-row { cursor: pointer; }
    .clamp { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; max-width: 520px; }
    @media (max-width: 767px) {
      .summary { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
      .tile { padding: 12px 14px; } .tile b { font-size: 20px; }
      .code { font-size: 11.5px; color: var(--muted); }
      .title-cell { padding-bottom: 8px !important; }
      .title-cell b { font-size: 14.5px; }
    }
  `,
})
export class CasesPage implements OnInit {
  private api = inject(Api);
  private toast = inject(Toast);
  private router = inject(Router);
  auth = inject(AuthStore);
  cases = signal<any[]>([]);
  showNew = signal(false);
  busy = signal(false);
  fmt = fmtDate;
  form = { title: '', purpose: '', scope: '', legalBasis: '', classification: 'CONFIDENTIAL', retentionDays: 180 };

  countBy(status: string) {
    return this.cases().filter((c) => c.status === status).length;
  }
  activeJobs() {
    return this.cases().reduce((n, c) => n + (+c.active_jobs || 0), 0);
  }
  findings() {
    return this.cases().reduce((n, c) => n + (+c.finding_count || 0), 0);
  }

  /** Whole row is a tap target (mobile cards); real links inside keep their own behaviour. */
  open(id: string, ev: MouseEvent) {
    if (!(ev.target as HTMLElement).closest('a, button')) void this.router.navigate(['/cases', id]);
  }

  ngOnInit() {
    void this.load();
  }

  async load() {
    try {
      this.cases.set(await this.api.get('/cases'));
    } catch (e) {
      this.toast.error(e);
    }
  }

  async create() {
    this.busy.set(true);
    try {
      const c = await this.api.post<any>('/cases', this.form);
      this.showNew.set(false);
      void this.router.navigate(['/cases', c.id]);
    } catch (e) {
      this.toast.error(e);
    } finally {
      this.busy.set(false);
    }
  }

  /** Creates a case seeded with the fictional demo organisation and runs the demo transform. */
  async loadDemo() {
    this.busy.set(true);
    try {
      const c = await this.api.post<any>('/cases', {
        title: 'DEMO — Coastal protest narrative network (fictional)',
        purpose: 'Training / demonstration of the narrative & network methodology using a fully fictional dataset.',
        scope: 'Synthetic dataset only (demo.fictional-network). No real persons.',
        legalBasis: 'Synthetic data — no personal data processed',
        classification: 'INTERNAL',
        retentionDays: 30,
      });
      const seed = await this.api.post<any>(`/cases/${c.id}/seeds`, { type: 'ORGANIZATION', value: 'Forum Pesisir Nusantara', purpose: 'demo' });
      await this.api.post(`/entities/${seed.entity.id}/transforms/demo.fictional-network`);
      this.toast.show('Demo case created — the demo transform is running. Run Narrative analysis once the job completes.');
      void this.router.navigate(['/cases', c.id, 'graph']);
    } catch (e) {
      this.toast.error(e);
    } finally {
      this.busy.set(false);
    }
  }
}
