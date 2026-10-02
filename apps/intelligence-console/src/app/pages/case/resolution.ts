import { Component, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Api, Toast } from '../../core/api';
import { CaseContext } from './case-context';

const SIGNAL_LABEL: Record<string, string> = {
  phone: 'Exact verified phone', email: 'Exact email', name: 'Name similarity', organization: 'Organization overlap',
  location: 'Location overlap', username: 'Username similarity', temporal: 'Temporal consistency',
};

@Component({
  selector: 'app-resolution',
  imports: [FormsModule, RouterLink],
  template: `
    <div class="page">
      <div class="row mb">
        <div class="grow"><h1>Resolution Workbench</h1>
          <div class="small muted">score = Σ(weightᵢ · signalᵢ) − conflict penalty · &lt;{{ th()?.candidate }} unresolved · {{ th()?.candidate }}–{{ th()?.reviewReady }} candidate · ≥{{ th()?.reviewReady }} review-ready (requires a deterministic identifier). Name similarity alone never merges.</div></div>
        <select [(ngModel)]="filter" (ngModelChange)="load()"><option value="">All open & reviewed</option><option>REVIEW_READY</option><option>CANDIDATE</option><option>UNRESOLVED</option><option>MERGED</option><option>REJECTED</option></select>
        @if (ctx.canEdit()) { <button class="sm" (click)="recompute()">Recompute</button> }
      </div>
      @if (weights(); as w) {
        <div class="card mb small row wrap">@for (k of keys(w); track k) { <span class="nowrap"><span class="muted">{{ sig[k] }}</span>&ngsp;<b>{{ w[k] }}</b></span><span class="faint">·</span> }
          <span class="muted">auto-merge deterministic:&ngsp;<b>{{ autoMerge() ? 'on' : 'off' }}</b></span></div>
      }
      @for (c of items(); track c.id) {
        <div class="card mb">
          <div class="row">
            <span class="badge {{ c.status }}">{{ c.status }}</span>
            @if (c.deterministic) { <span class="badge ok">deterministic identifier</span> }
            <b class="mono">{{ c.score.toFixed(3) }}</b>
            <span class="spacer"></span>
          </div>
          <div class="grid grid-2 mt">
            @for (side of [{ id: c.entity_a, label: c.a_label, key: c.a_key, props: c.a_props, seed: c.a_seed }, { id: c.entity_b, label: c.b_label, key: c.b_key, props: c.b_props, seed: c.b_seed }]; track side.id) {
              <div class="side">
                <div class="row"><a [routerLink]="['../entities', side.id]"><b>{{ side.label }}</b></a> @if (side.seed) { <span class="badge">seed</span> }</div>
                <div class="tiny faint mono break">{{ side.key }}</div>
                <div class="tiny muted">{{ side.props?.description || side.props?.source || '' }}</div>
                @if (ctx.canEdit() && (c.status === 'CANDIDATE' || c.status === 'REVIEW_READY' || c.status === 'UNRESOLVED')) {
                  <button class="sm mt" (click)="pending.set({ id: c.id, survivor: side.id, label: side.label })">Keep this as survivor…</button>
                }
              </div>
            }
          </div>
          <table class="t mt" style="max-width:780px"><tbody>
            @for (k of sigKeys; track k) {
              <tr><td class="small muted nowrap" style="width:200px">{{ sig[k] }}</td>
                <td><span class="bar" style="display:block;max-width:420px"><i [style.width.%]="(c.signals[k] ?? 0) * 100"></i></span></td>
                <td class="mono small nowrap" style="width:130px;text-align:right">{{ (c.signals[k] ?? 0).toFixed(2) }} × {{ weights()?.[k] }}</td></tr>
            }
            @if (c.signals._conflicts?.length) { <tr><td class="small" style="color:#fca5a5">Conflicts (−{{ c.signals._penalty }})</td><td colspan="2" class="small">{{ c.signals._conflicts.join('; ') }}</td></tr> }
          </tbody></table>
          @if (ctx.canEdit() && !['MERGED', 'REJECTED'].includes(c.status)) {
            <div class="row mt"><span class="spacer"></span><button class="sm danger" (click)="reject(c.id)">Reject — different entities</button></div>
          }
        </div>
      } @empty { <div class="empty">No resolution candidates. Candidates appear when person records share identifiers or have similar names.</div> }
    </div>

    @if (pending(); as p) {
      <div class="modal-bg" (click)="pending.set(null)">
        <div class="modal col" (click)="$event.stopPropagation()">
          <h2>Merge into “{{ p.label }}”</h2>
          <p class="small muted">Relationships and attributes of the other record move to the survivor; the other record is marked MERGED. This decision is audited.</p>
          <label class="field">Review note (required)<textarea rows="3" [(ngModel)]="note" placeholder="Why these records refer to the same person"></textarea></label>
          <div class="row"><span class="spacer"></span><button class="ghost" (click)="pending.set(null)">Cancel</button>
            <button class="primary" [disabled]="note.trim().length < 5" (click)="merge()">Merge</button></div>
        </div>
      </div>
    }
  `,
  styles: `.side { padding: 10px; border: 1px solid var(--border); border-radius: 6px; background: var(--bg-2); }`,
})
export class ResolutionPage {
  private api = inject(Api);
  private toast = inject(Toast);
  ctx = inject(CaseContext);
  sig = SIGNAL_LABEL;
  sigKeys = Object.keys(SIGNAL_LABEL);
  filter = '';
  note = '';
  items = signal<any[]>([]);
  weights = signal<Record<string, number> | null>(null);
  th = signal<any>(null);
  autoMerge = signal(false);
  pending = signal<{ id: string; survivor: string; label: string } | null>(null);
  keys = (o: object) => Object.keys(o);

  constructor() {
    effect(() => {
      this.ctx.version();
      if (this.ctx.caseId()) untracked(() => void this.load());
    });
  }

  async load() {
    try {
      const r = await this.api.get<any>('/resolution', { caseId: this.ctx.caseId(), status: this.filter });
      this.items.set(r.candidates);
      this.weights.set(r.weights);
      this.th.set(r.thresholds);
      this.autoMerge.set(r.autoMergeDeterministic);
    } catch (e) {
      this.toast.error(e);
    }
  }

  async recompute() {
    try {
      const r = await this.api.post<any>('/resolution/recompute', { caseId: this.ctx.caseId() });
      this.toast.show(`${r.pairs} pair(s) scored`);
      await this.load();
    } catch (e) {
      this.toast.error(e);
    }
  }

  async merge() {
    const p = this.pending()!;
    try {
      await this.api.post(`/resolution/${p.id}/merge`, { survivorId: p.survivor, note: this.note });
      this.pending.set(null);
      this.note = '';
      this.toast.show('Entities merged');
      this.ctx.bump();
    } catch (e) {
      this.toast.error(e);
    }
  }

  async reject(id: string) {
    try {
      await this.api.post(`/resolution/${id}/reject`, { note: 'Analyst: different entities' });
      this.ctx.bump();
    } catch (e) {
      this.toast.error(e);
    }
  }
}
