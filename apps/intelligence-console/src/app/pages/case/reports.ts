import { Component, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DomSanitizer } from '@angular/platform-browser';
import { Api, AuthStore, fmtDate, Toast } from '../../core/api';
import { CaseContext } from './case-context';

@Component({
  selector: 'app-reports',
  imports: [FormsModule],
  template: `
    <div class="page" style="max-width:1000px">
      <h1>Report Builder</h1>
      <div class="small muted mb">Exports include every finding with evidence status, claim type, evidence timestamps and SHA-256 hashes, watermarked with the case classification. Every export is audited.</div>
      @if (ctx.canEdit()) {
        <div class="card mb row wrap">
          <input class="grow" [(ngModel)]="title" placeholder="Report title (optional)" />
          <label class="check"><input type="checkbox" [(ngModel)]="includeRejected" /> include rejected findings</label>
          @if (auth.user()?.canRevealPii) { <label class="check"><input type="checkbox" [(ngModel)]="revealPii" /> unmasked identifiers</label> }
          <button class="primary" (click)="generate()" [disabled]="busy()">Generate report</button>
        </div>
      }
      <div class="card flush">
        <table class="t">
          <thead><tr><th>Title</th><th>Classification</th><th>SHA-256</th><th>Created</th><th></th></tr></thead>
          <tbody>
            @for (r of items(); track r.id) {
              <tr><td>{{ r.title }}</td><td><span class="badge">{{ r.classification }}</span></td><td class="mono tiny">{{ r.hash.slice(0, 16) }}…</td>
                <td class="small">{{ fmt(r.created_at) }} · {{ r.created_by_name }}</td>
                <td class="nowrap"><button class="sm" (click)="preview(r.id)">Preview</button> <button class="sm" (click)="download(r)">Download</button></td></tr>
            } @empty { <tr><td colspan="5" class="empty">No reports yet (a report requires at least one finding).</td></tr> }
          </tbody>
        </table>
      </div>
      @if (previewUrl()) { <iframe class="pv mt" [src]="previewUrl()" sandbox="" title="Report preview"></iframe> }
    </div>
  `,
  styles: `.pv { width: 100%; height: 75vh; border: 1px solid var(--border); border-radius: 8px; background: #fff; }`,
})
export class ReportsPage {
  private api = inject(Api);
  private toast = inject(Toast);
  auth = inject(AuthStore);
  ctx = inject(CaseContext);
  fmt = fmtDate;
  items = signal<any[]>([]);
  busy = signal(false);
  previewUrl = signal<any>(null);
  title = '';
  includeRejected = false;
  revealPii = false;
  private sanitizer = inject(DomSanitizer);

  constructor() {
    effect(() => {
      this.ctx.version();
      if (this.ctx.caseId()) untracked(() => void this.load());
    });
  }

  async load() {
    try {
      this.items.set(await this.api.get('/reports', { caseId: this.ctx.caseId() }));
    } catch (e) {
      this.toast.error(e);
    }
  }

  async generate() {
    this.busy.set(true);
    try {
      await this.api.post('/reports', { caseId: this.ctx.caseId(), title: this.title || undefined, includeRejected: this.includeRejected, revealPii: this.revealPii });
      this.toast.show('Report generated');
      await this.load();
    } catch (e) {
      this.toast.error(e);
    } finally {
      this.busy.set(false);
    }
  }

  async preview(id: string) {
    try {
      const { url } = await this.api.blobUrl(`/reports/${id}/download`);
      this.previewUrl.set(this.sanitizer.bypassSecurityTrustResourceUrl(url));
    } catch (e) {
      this.toast.error(e);
    }
  }

  async download(r: any) {
    try {
      const { url } = await this.api.blobUrl(`/reports/${r.id}/download`);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${r.title.replace(/[^\w.-]+/g, '_')}.html`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } catch (e) {
      this.toast.error(e);
    }
  }
}

