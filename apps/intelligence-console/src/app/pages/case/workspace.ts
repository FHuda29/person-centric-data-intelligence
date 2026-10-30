import { Component, effect, inject, input, untracked } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { UiIcon } from '../../shared/ui';
import { CaseContext } from './case-context';

@Component({
  selector: 'app-case-workspace',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, UiIcon],
  providers: [CaseContext],
  template: `
    <div class="ws">
      <header class="head">
        <div class="crumbs">
          <a routerLink="/">Cases</a><ui-icon name="chevron" [size]="12" /><span class="mono">{{ ctx.data()?.code }}</span>
        </div>
        <div class="title-row">
          <h1 class="ellipsis">{{ ctx.data()?.title }}</h1>
          <span class="badge {{ ctx.data()?.status }}">{{ ctx.data()?.status }}</span>
          <span class="badge">{{ ctx.data()?.classification }}</span>
          @if (ctx.data()?.access === 'READ') { <span class="badge">read-only</span> }
          <span class="spacer"></span>
          @if (ctx.activeJobs()) { <span class="jobs"><span class="spin"></span>{{ ctx.activeJobs() }} transform job(s) running</span> }
        </div>
      </header>
      <nav class="tabs">
        @for (t of tabs; track t.path) {
          <a [routerLink]="t.path" [routerLinkActiveOptions]="{ exact: t.path === '.' }" routerLinkActive="active">
            <ui-icon [name]="t.icon" [size]="15" />{{ t.label }}
            @if (t.path === 'resolution' && ctx.data()?.stats?.pending_resolution) { <span class="count">{{ ctx.data()?.stats?.pending_resolution }}</span> }
          </a>
        }
      </nav>
      <div class="body"><router-outlet /></div>
    </div>
  `,
  styles: `
    .ws { display: flex; flex-direction: column; height: 100%; }
    .head { padding: 20px var(--gutter) 12px; min-width: 0; }
    .crumbs { display: flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--faint); margin-bottom: 6px; }
    .crumbs a { color: var(--muted); } .crumbs a:hover { color: var(--text); }
    .crumbs .mono { color: var(--muted); font-size: 12px; }
    .title-row { display: flex; align-items: center; gap: 10px; min-width: 0; flex-wrap: wrap; row-gap: 8px; }
    .title-row h1 { margin: 0; font-size: 20px; min-width: 0; max-width: 100%; }
    .jobs { display: inline-flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--accent-text); padding: 5px 12px;
      border-radius: 999px; background: var(--accent-soft); border: 1px solid rgba(76,141,255,.25); white-space: nowrap; }
    .tabs ui-icon { opacity: .8; }
    .tabs { padding: 0 var(--gutter); scroll-snap-type: x proximity;
      mask-image: linear-gradient(90deg, transparent 0, #000 12px, #000 calc(100% - 24px), transparent); }
    .tabs a { scroll-snap-align: start; }
    @media (max-width: 767px) {
      .head { padding-top: 14px; }
      .title-row h1 { font-size: 17px; white-space: normal; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; flex-basis: 100%; }
      .tabs a { padding-left: 10px; padding-right: 10px; }
    }
    .body { flex: 1; min-height: 0; overflow: auto; }
  `,
})
export class CaseWorkspace {
  caseId = input.required<string>();
  ctx = inject(CaseContext);
  tabs = [
    { path: '.', label: 'Dashboard', icon: 'dashboard' },
    { path: 'graph', label: 'Graph Explorer', icon: 'graph' },
    { path: 'entities', label: 'Entities', icon: 'entities' },
    { path: 'timeline', label: 'Timeline', icon: 'timeline' },
    { path: 'narrative', label: 'Narrative', icon: 'narrative' },
    { path: 'evidence', label: 'Evidence', icon: 'evidence' },
    { path: 'resolution', label: 'Resolution', icon: 'merge' },
    { path: 'findings', label: 'Findings', icon: 'finding' },
    { path: 'reports', label: 'Reports', icon: 'report' },
    { path: 'audit', label: 'Audit', icon: 'audit' },
  ];
  constructor() {
    effect(() => {
      const id = this.caseId();
      untracked(() => void this.ctx.open(id));
    });
  }
}
