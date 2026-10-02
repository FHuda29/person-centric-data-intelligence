import { Component, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Api, fmtDate, Toast } from '../../core/api';
import { CaseContext } from './case-context';

const STATUS_HELP: Record<string, string> = {
  CONFIRMED: 'Primary/authoritative source or direct lawful evidence (note required)',
  CORROBORATED: 'Two or more independent relevant sources',
  UNVERIFIED: 'Claim exists but independent evidence is insufficient',
  CONTRADICTED: 'Credible conflicting evidence exists (note required)',
  REJECTED: 'Not the target or not relevant (note required)',
};

@Component({
  selector: 'app-findings',
  imports: [FormsModule, RouterLink],
  template: `
    <div class="page" style="max-width:1100px">
      <div class="row mb"><div class="grow"><h1>Findings</h1>
        <div class="small muted">Every finding cites at least one evidence object and separates observed fact, source claim, analytical inference and unverified information.</div></div>
        @if (ctx.canEdit()) { <button class="primary" (click)="openNew()">New finding</button> }</div>
      @for (f of items(); track f.id) {
        <div class="card mb">
          <div class="row"><span class="badge {{ f.status }}">{{ f.status }}</span><span class="badge">{{ f.claim_type.replaceAll('_', ' ') }}</span>
            <span class="small muted">confidence {{ (+f.confidence).toFixed(2) }}</span><span class="spacer"></span>
            <span class="tiny faint">by {{ f.created_by_name }} · {{ fmt(f.created_at) }}@if (f.reviewed_at) { · reviewed by {{ f.reviewed_by_name }} {{ fmt(f.reviewed_at) }} }</span></div>
          <h3 class="mt">{{ f.title }}</h3>
          <p style="margin:0 0 8px">{{ f.statement }}</p>
          @if (f.analyst_note) { <div class="small"><span class="muted">Analyst note:</span> {{ f.analyst_note }}</div> }
          @if (f.entities.length) { <div class="small mt"><span class="muted">Entities:</span>&ngsp;@for (e of f.entities; track e.id) { <a [routerLink]="['../entities', e.id]">{{ e.label }}</a>{{ $last ? '' : ', ' }} } </div> }
          <div class="small mt"><span class="muted">Evidence ({{ f.evidence.length }}):</span>
            @for (e of f.evidence; track e.id) { <div class="tiny"><a [routerLink]="['../evidence']" [queryParams]="{ id: e.id }">{{ e.title || e.url || e.id }}</a> <span class="faint">· {{ e.source }} · {{ fmt(e.retrieved_at) }} · {{ e.hash.slice(0, 12) }}…</span></div> }</div>
          @if (ctx.canEdit()) {
            <div class="row mt wrap">
              <select [(ngModel)]="review[f.id].status">@for (s of statuses; track s) { <option [value]="s">{{ s }}</option> }</select>
              <input class="grow" [(ngModel)]="review[f.id].note" placeholder="Analyst note" />
              <button class="sm" (click)="doReview(f.id)">Update status</button>
            </div>
            <div class="tiny faint">{{ help[review[f.id].status] }}</div>
          }
        </div>
      } @empty { <div class="empty">No findings yet.</div> }
    </div>

    @if (showNew()) {
      <div class="modal-bg" (click)="showNew.set(false)">
        <div class="modal col" style="width:min(720px,100%)" (click)="$event.stopPropagation()">
          <h2>New finding</h2>
          <label class="field">Title<input [(ngModel)]="form.title" /></label>
          <label class="field">Statement<textarea rows="3" [(ngModel)]="form.statement"></textarea></label>
          <div class="grid grid-2">
            <label class="field">Claim type<select [(ngModel)]="form.claimType"><option value="OBSERVED_FACT">Observed fact</option><option value="SOURCE_CLAIM">Source claim</option><option value="ANALYTICAL_INFERENCE">Analytical inference</option><option value="UNVERIFIED_INFO">Unverified information</option></select></label>
            <label class="field">Confidence {{ form.confidence }}<input type="range" min="0" max="1" step="0.05" [(ngModel)]="form.confidence" /></label>
          </div>
          <label class="field">Evidence (select ≥1)
            <input placeholder="filter…" [(ngModel)]="evFilter" /></label>
          <div class="evs">
            @for (e of evidence(); track e.id) {
              @if (!evFilter || (e.title + ' ' + e.url).toLowerCase().includes(evFilter.toLowerCase())) {
                <label class="check"><input type="checkbox" [checked]="picked.has(e.id)" (change)="toggle(e.id)" />
                  <span class="small ellipsis">{{ e.title || e.url || e.id }} <span class="faint">· {{ e.source_name }}</span></span></label>
              }
            }
          </div>
          <div class="row"><span class="small muted">{{ picked.size }} selected</span><span class="spacer"></span>
            <button class="ghost" (click)="showNew.set(false)">Cancel</button>
            <button class="primary" [disabled]="!picked.size || !form.title.trim() || !form.statement.trim()" (click)="create()">Create</button></div>
        </div>
      </div>
    }
  `,
  styles: `.evs { max-height: 260px; overflow: auto; border: 1px solid var(--border); border-radius: 6px; padding: 6px; display: flex; flex-direction: column; gap: 3px; }`,
})
export class FindingsPage {
  private api = inject(Api);
  private toast = inject(Toast);
  ctx = inject(CaseContext);
  fmt = fmtDate;
  statuses = Object.keys(STATUS_HELP);
  help = STATUS_HELP;
  items = signal<any[]>([]);
  evidence = signal<any[]>([]);
  showNew = signal(false);
  review: Record<string, { status: string; note: string }> = {};
  form = { title: '', statement: '', claimType: 'OBSERVED_FACT', confidence: 0.6 };
  picked = new Set<string>();
  evFilter = '';

  constructor() {
    effect(() => {
      this.ctx.version();
      if (this.ctx.caseId()) untracked(() => void this.load());
    });
  }

  async load() {
    try {
      const items = await this.api.get<any[]>('/findings', { caseId: this.ctx.caseId() });
      for (const f of items) this.review[f.id] ??= { status: f.status, note: f.analyst_note ?? '' };
      this.items.set(items);
    } catch (e) {
      this.toast.error(e);
    }
  }

  async openNew() {
    this.picked = new Set();
    this.showNew.set(true);
    try {
      this.evidence.set((await this.api.get<any>('/evidence', { caseId: this.ctx.caseId(), limit: 1000 })).items);
    } catch (e) {
      this.toast.error(e);
    }
  }

  toggle(id: string) {
    this.picked.has(id) ? this.picked.delete(id) : this.picked.add(id);
  }

  async create() {
    try {
      await this.api.post('/findings', { caseId: this.ctx.caseId(), ...this.form, confidence: +this.form.confidence, evidenceIds: [...this.picked] });
      this.showNew.set(false);
      this.form = { title: '', statement: '', claimType: 'OBSERVED_FACT', confidence: 0.6 };
      this.ctx.bump();
    } catch (e) {
      this.toast.error(e);
    }
  }

  async doReview(id: string) {
    const r = this.review[id];
    try {
      await this.api.post(`/findings/${id}/review`, { status: r.status, analystNote: r.note || undefined });
      this.toast.show('Finding updated');
      this.ctx.bump();
    } catch (e) {
      this.toast.error(e);
    }
  }
}
