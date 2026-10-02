import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map } from 'rxjs';
import { AuthStore, Toast } from './core/api';
import { UiIcon } from './shared/ui';

const COLLAPSE_KEY = 'pcdi.sidebar.collapsed';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, FormsModule, UiIcon],
  template: `
    @if (showShell()) {
      <div class="shell" [class.collapsed]="collapsed()">
        <aside class="side">
          <a routerLink="/" class="brand" title="PCDI Intelligence Console">
            <span class="logo">
              <svg width="20" height="20" viewBox="0 0 32 32" aria-hidden="true">
                <path d="M8 9 24 8M8 9l12 15M24 8l-4 16M7 23l13 1M8 9 7 23" stroke="rgba(255,255,255,.55)" stroke-width="1.6" fill="none" />
                <circle cx="8" cy="9" r="4" fill="#fff" /><circle cx="24" cy="8" r="3.2" fill="#bfe0ff" />
                <circle cx="20" cy="24" r="4.4" fill="#fff" /><circle cx="7" cy="23" r="2.8" fill="#bfe0ff" />
              </svg>
            </span>
            <span class="brand-text"><b>PCDI</b><small>Intelligence Console</small></span>
          </a>

          <nav class="nav">
            <span class="nav-h">Workspace</span>
            <a routerLink="/" [class.active]="inCases()" title="Cases">
              <ui-icon name="cases" [size]="18" /><span>Cases</span></a>
            <a routerLink="/search" routerLinkActive="active" title="Search"><ui-icon name="search" [size]="18" /><span>Search</span></a>
            <a routerLink="/sources" routerLinkActive="active" title="Transform Hub"><ui-icon name="hub" [size]="18" /><span>Transform Hub</span></a>
            <span class="nav-h">Settings</span>
            <a routerLink="/admin" routerLinkActive="active" [title]="isAdmin() ? 'Administration' : 'Account'">
              <ui-icon [name]="isAdmin() ? 'shield' : 'user'" [size]="18" /><span>{{ isAdmin() ? 'Administration' : 'Account' }}</span></a>
          </nav>

          <div class="side-foot">
            <div class="me" [title]="auth.user()?.displayName ?? ''">
              <span class="avatar">{{ initials() }}</span>
              <span class="me-text"><b class="ellipsis">{{ auth.user()?.displayName }}</b><small>{{ roleLabel() }}</small></span>
            </div>
            <button class="ghost icon-btn" (click)="logout()" title="Sign out" aria-label="Sign out"><ui-icon name="logout" [size]="17" /></button>
          </div>
          <button class="collapse" (click)="toggle()" [attr.aria-label]="collapsed() ? 'Expand sidebar' : 'Collapse sidebar'">
            <ui-icon name="chevron" [size]="14" />
          </button>
        </aside>

        <div class="main-col">
          <header class="topbar">
            <form class="usearch" (ngSubmit)="search()" role="search">
              <ui-icon name="search" [size]="16" />
              <input name="q" [(ngModel)]="q" placeholder="Search collected content & entities…" aria-label="Universal search" />
              <kbd>Enter</kbd>
            </form>
            <span class="spacer"></span>
            <span class="env"><span class="dot" style="background: var(--ok)"></span>Audited session</span>
          </header>
          <main><router-outlet /></main>
        </div>
      </div>
    } @else {
      <main class="full"><router-outlet /></main>
    }
    <div class="toast">
      @for (t of toast.items(); track t.id) {
        <div [class.err]="t.err">{{ t.text }}</div>
      }
    </div>
  `,
  styles: `
    :host { display: block; height: 100vh; }
    .shell { display: grid; grid-template-columns: 240px minmax(0, 1fr); height: 100vh; transition: grid-template-columns .2s var(--ease); }
    .shell.collapsed { grid-template-columns: 68px minmax(0, 1fr); }
    .side { position: relative; display: flex; flex-direction: column; gap: 6px; padding: 16px 12px 12px; background: var(--bg-2); border-right: 1px solid var(--border); min-width: 0; }
    .brand { display: flex; align-items: center; gap: 11px; padding: 4px 6px 18px; color: var(--text); }
    .logo { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 10px; flex: none;
      background: linear-gradient(140deg, #5b9bff, #3a5fe0 60%, #6d4ce0); box-shadow: 0 4px 14px -4px rgba(76,141,255,.6), 0 0 0 1px rgba(255,255,255,.12) inset; }
    .brand-text { display: flex; flex-direction: column; line-height: 1.15; min-width: 0; }
    .brand-text b { font-size: 15px; letter-spacing: .02em; }
    .brand-text small { font-size: 11.5px; color: var(--muted); white-space: nowrap; }
    .nav { display: flex; flex-direction: column; gap: 2px; }
    .nav-h { font-size: 10.5px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--faint); padding: 14px 10px 6px; white-space: nowrap; }
    .nav a { display: flex; align-items: center; gap: 11px; height: 38px; padding: 0 10px; border-radius: 9px; color: var(--muted); font-weight: 500; font-size: 13.5px; white-space: nowrap; }
    .nav a:hover { color: var(--text); background: var(--panel); }
    .nav a.active { color: var(--text); background: var(--panel-2); box-shadow: 0 0 0 1px var(--border) inset; }
    .nav a.active ui-icon { color: var(--accent-text); }
    .side-foot { margin-top: auto; display: flex; align-items: center; gap: 6px; padding: 10px 6px 2px; border-top: 1px solid var(--border); }
    .me { display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0; }
    .avatar { display: grid; place-items: center; width: 32px; height: 32px; border-radius: 50%; flex: none; font-size: 12px; font-weight: 600;
      background: linear-gradient(140deg, #2b3445, #1c2230); border: 1px solid var(--border-2); color: var(--text-2); }
    .me-text { display: flex; flex-direction: column; min-width: 0; line-height: 1.25; }
    .me-text b { font-size: 13px; } .me-text small { font-size: 11.5px; color: var(--muted); }
    .icon-btn { width: 32px; height: 32px; padding: 0; flex: none; }
    .collapse { position: absolute; top: 24px; right: -12px; width: 24px; height: 24px; padding: 0; border-radius: 50%; z-index: 5;
      background: var(--panel-2); color: var(--muted); opacity: 0; transition: opacity .15s, transform .2s var(--ease); transform: rotate(180deg); }
    .side:hover .collapse, .collapse:focus-visible { opacity: 1; }
    .collapsed .collapse { transform: rotate(0deg); }
    .collapsed .brand-text, .collapsed .nav a span, .collapsed .nav-h, .collapsed .me-text { display: none; }
    .collapsed .nav-h { display: block; height: 14px; padding: 0; overflow: hidden; color: transparent; }
    .collapsed .nav a { justify-content: center; padding: 0; }
    .collapsed .brand { justify-content: center; padding: 4px 0 18px; }
    .collapsed .side-foot { flex-direction: column; padding: 10px 0 2px; }
    .main-col { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
    .topbar { display: flex; align-items: center; gap: 16px; height: 60px; padding: 0 32px; border-bottom: 1px solid var(--border); flex: none; background: rgba(9,12,17,.85); }
    .usearch { position: relative; display: flex; align-items: center; flex: 1; max-width: 560px; color: var(--faint); }
    .usearch ui-icon { position: absolute; left: 12px; pointer-events: none; }
    .usearch input { width: 100%; height: 38px; padding-left: 38px; padding-right: 64px; background: var(--panel); border-color: var(--border); border-radius: 10px; }
    .usearch kbd { position: absolute; right: 10px; font: 500 10.5px var(--sans); color: var(--faint); border: 1px solid var(--border-2); border-radius: 5px; padding: 2px 6px; pointer-events: none; }
    .env { display: inline-flex; align-items: center; gap: 8px; font-size: 12px; color: var(--muted); white-space: nowrap; }
    main { flex: 1; min-height: 0; overflow: auto; }
    main.full { height: 100vh; }
    @media (max-width: 900px) {
      .shell, .shell.collapsed { grid-template-columns: 68px minmax(0, 1fr); }
      .brand-text, .nav a span, .me-text, .collapse, .env { display: none; }
      .nav-h { height: 14px; padding: 0; overflow: hidden; color: transparent; }
      .nav a { justify-content: center; padding: 0; }
      .side-foot { flex-direction: column; }
      .topbar { padding: 0 16px; }
    }
  `,
})
export class App {
  protected readonly auth = inject(AuthStore);
  protected readonly toast = inject(Toast);
  private readonly router = inject(Router);
  protected q = '';
  protected readonly collapsed = signal(readCollapsed());
  private readonly url = toSignal(
    this.router.events.pipe(filter((e) => e instanceof NavigationEnd), map((e) => (e as NavigationEnd).urlAfterRedirects)),
    { initialValue: this.router.url },
  );
  protected readonly showShell = computed(() => !!this.auth.token() && !this.url().startsWith('/login'));
  protected readonly inCases = computed(() => this.url() === '/' || this.url().startsWith('/cases'));
  protected readonly isAdmin = computed(() => this.auth.user()?.role === 'ADMIN');
  protected readonly roleLabel = computed(() => {
    const r = this.auth.user()?.role ?? '';
    return r.charAt(0) + r.slice(1).toLowerCase();
  });
  protected readonly initials = computed(() =>
    (this.auth.user()?.displayName ?? this.auth.user()?.username ?? '?')
      .split(/\s+/)
      .map((w) => w[0])
      .slice(0, 2)
      .join('')
      .toUpperCase(),
  );

  toggle() {
    this.collapsed.update((v) => !v);
    try {
      localStorage.setItem(COLLAPSE_KEY, this.collapsed() ? '1' : '0');
    } catch {
      /* storage unavailable */
    }
  }

  search() {
    if (this.q.trim()) void this.router.navigate(['/search'], { queryParams: { q: this.q.trim() } });
  }
  logout() {
    this.auth.clear();
    void this.router.navigate(['/login']);
  }
}

function readCollapsed() {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === '1';
  } catch {
    return false;
  }
}
