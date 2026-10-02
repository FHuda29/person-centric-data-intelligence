import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api, AuthStore, fmtDate, Toast } from '../core/api';

@Component({
  selector: 'app-cases',
  imports: [FormsModule, RouterLink],
  template: `
    <div class="page">
      <div class="row mb">
        <div class="grow">
          <h1>Cases</h1>
          <div class="muted small">Every search runs inside a case with a documented purpose, scope, classification and retention.</div>
        </div>
        @if (auth.canEdit()) {
          <button (click)="loadDemo()" [disabled]="busy()">Load fictional demo case</button>
          <button class="primary" (click)="showNew.set(true)">New case</button>
        }
      </div>
      <div class="card flush">
        <table class="t">
          <thead><tr><th>Code</th><th>Title / purpose</th><th>Status</th><th>Class.</th><th>Entities</th><th>Findings</th><th>Jobs</th><th>Retention</th><th>Owner</th></tr></thead>
          <tbody>
            @for (c of cases(); track c.id) {
              <tr>
                <td class="nowrap"><a [routerLink]="['/cases', c.id]" class="mono">{{ c.code }}</a></td>
                <td><a [routerLink]="['/cases', c.id]"><b>{{ c.title }}</b></a><div class="small muted">{{ c.purpose }}</div></td>
                <td><span class="badge {{ c.status }}">{{ c.status }}</span></td>
                <td class="small">{{ c.classification }}</td>
                <td>{{ c.entity_count }}</td>
                <td>{{ c.finding_count }}</td>
                <td>@if (c.active_jobs) { <span class="badge RUNNING">{{ c.active_jobs }} active</span> } @else { <span class="faint">—</span> }</td>
                <td class="small nowrap">{{ fmt(c.retention_until, false) }}</td>
                <td class="small">{{ c.owner_name }}</td>
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
