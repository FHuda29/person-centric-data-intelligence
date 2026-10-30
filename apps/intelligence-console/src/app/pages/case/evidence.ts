import { Component, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Api, fmtDate, Toast } from '../../core/api';
import { UiIcon } from '../../shared/ui';
import { CaseContext } from './case-context';

@Component({
  selector: 'app-evidence',
  imports: [FormsModule, UiIcon],
  template: `
    <div class="ev" [class.has-sel]="!!sel()">
      <div class="list">
        <div class="list-head">
          <div class="row">
            <div class="find grow"><ui-icon name="search" [size]="14" />
              <input placeholder="Search title, URL, excerpt…" [(ngModel)]="q" (keyup.enter)="load()" /></div>
            @if (ctx.canEdit()) {
              <label class="btn" title="Upload document" style="cursor:pointer"><ui-icon name="upload" [size]="15" />Upload<input type="file" hidden accept=".txt,.md,.csv,.json,.html,.htm" (change)="upload($event)" /></label>
            }
          </div>
          <div class="tiny muted">{{ total() }} evidence objects · SHA-256 addressed</div>
        </div>
        @for (e of items(); track e.id) {
          <div class="it" [class.sel]="e.id === id()" (click)="open(e.id)">
            <span class="badge tier" [title]="'Source tier ' + (e.tier ?? '?')">{{ e.tier ?? '?' }}</span>
            <div class="grow">
              <div class="it-title">{{ e.title || e.url || e.id }}</div>
              <div class="tiny faint ellipsis">{{ e.source_name }} · {{ fmt(e.retrieved_at) }}</div>
            </div>
          </div>
        }
      </div>
      <div class="view">
        @if (sel(); as e) {
          <button class="ghost sm back" (click)="back()"><ui-icon name="chevron" [size]="14" />All evidence</button>
          <h2 class="break">{{ e.title || 'Evidence ' + e.id.slice(0, 8) }}</h2>
          <dl class="kv mt">
            <dt>Evidence ID</dt><dd class="mono">{{ e.id }}</dd>
            <dt>Source</dt><dd>{{ e.source_name }} (tier {{ e.tier }}) · <code>{{ e.connector_key }}</code></dd>
            <dt>Access method</dt><dd>{{ e.access_method }}</dd>
            <dt>Legal / access basis</dt><dd>{{ e.legal_basis }}</dd>
            <dt>URL / source ID</dt><dd class="break">@if (e.url?.startsWith('http')) { <a [href]="e.url" target="_blank" rel="noopener noreferrer">{{ e.url }}</a> } @else { {{ e.url || '—' }} }</dd>
            <dt>Published</dt><dd>{{ fmt(e.published_at) }}</dd>
            <dt>Retrieved</dt><dd>{{ fmt(e.retrieved_at) }}</dd>
            <dt>SHA-256</dt><dd class="mono break">{{ e.hash }}</dd>
            <dt>Object</dt><dd class="mono break">{{ e.object_ref }} ({{ e.content_type }})</dd>
            <dt>Collector</dt><dd class="mono">{{ e.collector_version }}</dd>
            @if (e.created_by_name) { <dt>Collected by</dt><dd>{{ e.created_by_name }}</dd> }
          </dl>
          @if (e.excerpt) { <h4 class="mt2">Excerpt</h4><blockquote>{{ e.excerpt }}</blockquote> }
          <div class="row mt"><button class="sm" (click)="raw()">View raw object (audited)</button></div>
          @if (rawText()) { <pre class="raw">{{ rawText() }}</pre> }
          @if (e.relationships?.length) {
            <h4 class="mt2">Supports relationships</h4>
            @for (r of e.relationships; track r.id) { <div class="small">{{ r.from_label }} <b class="muted">{{ r.type }}</b> {{ r.to_label }} <span class="badge {{ r.status }}">{{ r.status }}</span></div> }
          }
          @if (e.findings?.length) {
            <h4 class="mt2">Cited by findings</h4>
            @for (f of e.findings; track f.id) { <div class="small">{{ f.title }} <span class="badge {{ f.status }}">{{ f.status }}</span></div> }
          }
        } @else {
          <div class="placeholder">
            <span class="ph-ic"><ui-icon name="evidence" [size]="22" /></span>
            <h3>Select an evidence object</h3>
            <p class="muted small">Each object is stored immutably with its SHA-256 hash, source, access basis and retrieval time. Opening the raw object is audited.</p>
          </div>
        }
      </div>
    </div>
  `,
  styles: `
    :host { display: block; height: 100%; }
    .ev { display: grid; grid-template-columns: 400px minmax(0, 1fr); height: 100%; border-top: 1px solid var(--border); }
    .list { border-right: 1px solid var(--border); overflow: auto; background: var(--bg-2); }
    .list-head { position: sticky; top: 0; z-index: 2; display: flex; flex-direction: column; gap: 8px; padding: 14px 14px 10px; background: var(--bg-2); border-bottom: 1px solid var(--border); }
    .find { position: relative; display: flex; align-items: center; color: var(--faint); }
    .find ui-icon { position: absolute; left: 10px; pointer-events: none; }
    .find input { width: 100%; padding-left: 30px; }
    .it { display: flex; gap: 10px; align-items: flex-start; padding: 11px 14px; border-bottom: 1px solid var(--border); cursor: pointer; transition: background .12s; }
    .it:hover { background: var(--panel); }
    .it.sel { background: var(--accent-soft); box-shadow: 2px 0 0 var(--accent) inset; }
    .it .badge { margin-top: 1px; }
    .it-title { font-size: 13px; line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; margin-bottom: 2px; }
    .view { overflow: auto; padding: 28px 36px; }
    .view > :not(.placeholder) { max-width: 920px; }
    .placeholder { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; max-width: 380px; margin: 0 auto; }
    .ph-ic { display: grid; place-items: center; width: 52px; height: 52px; border-radius: 14px; background: var(--panel-2); border: 1px solid var(--border-2); color: var(--muted); margin-bottom: 14px; }
    .placeholder h3 { margin-bottom: 6px; }
    blockquote { margin: 0; padding: 12px 16px; border-left: 3px solid var(--accent); background: var(--panel); border-radius: 0 10px 10px 0; white-space: pre-wrap; font-size: 13.5px; line-height: 1.6; }
    .raw { background: #06090d; border: 1px solid var(--border); border-radius: 10px; padding: 14px; max-height: 420px; overflow: auto; font: 11.5px/1.5 var(--mono); white-space: pre-wrap; word-break: break-all; }
    .back { display: none; margin: -6px 0 10px -8px; }
    .back ui-icon { transform: rotate(180deg); }
    @media (max-width: 900px) {
      .ev { grid-template-columns: 1fr; }
      .list { border-right: 0; }
      .view { padding: 20px var(--gutter); }
      /* master-detail: list first, detail replaces it once an item is chosen */
      .ev:not(.has-sel) .view, .ev.has-sel .list { display: none; }
      .back { display: inline-flex; }
    }
  `,
})
export class EvidencePage {
  id = input<string | undefined>();
  private api = inject(Api);
  private toast = inject(Toast);
  private router = inject(Router);
  ctx = inject(CaseContext);
  fmt = fmtDate;
  q = '';
  items = signal<any[]>([]);
  total = signal(0);
  sel = signal<any | null>(null);
  rawText = signal('');

  constructor() {
    effect(() => {
      this.ctx.version();
      if (this.ctx.caseId()) untracked(() => void this.load());
    });
    effect(() => {
      const id = this.id();
      if (id) untracked(() => void this.show(id));
    });
  }

  async load() {
    try {
      const r = await this.api.get<any>('/evidence', { caseId: this.ctx.caseId(), q: this.q, limit: 300 });
      this.items.set(r.items);
      this.total.set(r.total);
    } catch (e) {
      this.toast.error(e);
    }
  }

  open(id: string) {
    void this.router.navigate([], { queryParams: { id }, replaceUrl: true });
  }

  back() {
    this.sel.set(null);
    void this.router.navigate([], { queryParams: { id: null }, replaceUrl: true });
  }

  async show(id: string) {
    this.rawText.set('');
    try {
      this.sel.set(await this.api.get(`/evidence/${id}`));
    } catch (e) {
      this.toast.error(e);
    }
  }

  async raw() {
    try {
      const t = await this.api.text(`/evidence/${this.sel().id}/raw`);
      let pretty = t;
      try {
        pretty = JSON.stringify(JSON.parse(t), null, 2);
      } catch {
        /* not JSON */
      }
      this.rawText.set(pretty.slice(0, 200000));
    } catch (e) {
      this.toast.error(e);
    }
  }

  async upload(ev: Event) {
    const file = (ev.target as HTMLInputElement).files?.[0];
    if (!file) return;
    const fd = new FormData();
    fd.append('file', file);
    try {
      const r = await this.api.upload<any>(`/cases/${this.ctx.caseId()}/documents`, fd);
      this.toast.show(`Document ingested: ${r.entities} entities, ${r.mentions} mentions extracted`);
      this.ctx.bump();
    } catch (e) {
      this.toast.error(e);
    }
    (ev.target as HTMLInputElement).value = '';
  }
}
