import { Component, computed, HostListener, inject, signal } from '@angular/core';
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
      <div class="shell" [class.collapsed]="collapsed()" [class.drawer-open]="drawer()">
        <div class="scrim" (click)="drawer.set(false)" aria-hidden="true"></div>
        <aside class="side">
          <div class="brand-row">
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
            <button class="ghost icon-btn drawer-close" (click)="drawer.set(false)" aria-label="Close menu"><ui-icon name="close" [size]="18" /></button>
          </div>

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

          <div class="side-card">
            <span class="dot" style="background: var(--ok)"></span>
            <span>Audited session — every search, reveal and export is logged.</span>
          </div>

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
            <button class="ghost icon-btn burger" (click)="drawer.set(true)" aria-label="Open menu"><ui-icon name="menu" [size]="20" /></button>
            <a routerLink="/" class="mbrand" aria-label="PCDI home">
              <span class="logo sm">
                <svg width="16" height="16" viewBox="0 0 32 32" aria-hidden="true">
                  <circle cx="8" cy="9" r="4" fill="#fff" /><circle cx="24" cy="8" r="3.2" fill="#bfe0ff" />
                  <circle cx="20" cy="24" r="4.4" fill="#fff" /><circle cx="7" cy="23" r="2.8" fill="#bfe0ff" />
                </svg>
              </span>
            </a>
            <form class="usearch" (ngSubmit)="search()" role="search">
              <ui-icon name="search" [size]="16" />
              <input name="q" [(ngModel)]="q" placeholder="Search collected content & entities…" aria-label="Universal search" enterkeyhint="search" />
              <kbd>Enter</kbd>
            </form>
            <span class="env"><span class="dot" style="background: var(--ok)"></span>Audited session</span>
            <span class="avatar top-avatar" [title]="auth.user()?.displayName ?? ''">{{ initials() }}</span>
          </header>
          <main><router-outlet /></main>
        </div>

        <nav class="bottom-nav" aria-label="Primary">
          <a routerLink="/" [class.active]="inCases()"><ui-icon name="cases" [size]="21" /><span>Cases</span></a>
          <a routerLink="/search" routerLinkActive="active"><ui-icon name="search" [size]="21" /><span>Search</span></a>
          <a routerLink="/sources" routerLinkActive="active"><ui-icon name="hub" [size]="21" /><span>Sources</span></a>
          <a routerLink="/admin" routerLinkActive="active"><ui-icon [name]="isAdmin() ? 'shield' : 'user'" [size]="21" /><span>{{ isAdmin() ? 'Admin' : 'Account' }}</span></a>
        </nav>
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
    :host { display: block; height: 100vh; height: 100dvh; }
    .shell { display: grid; grid-template-columns: 248px minmax(0, 1fr); height: 100%; transition: grid-template-columns .2s var(--ease); }
    .shell.collapsed { grid-template-columns: 72px minmax(0, 1fr); }
    .side { position: relative; display: flex; flex-direction: column; gap: 6px; padding: 16px 12px 12px; min-width: 0; z-index: 30;
      background: linear-gradient(180deg, rgba(79,107,255,.05), transparent 30%), var(--bg-2); border-right: 1px solid var(--border); }
    .brand-row { display: flex; align-items: center; gap: 8px; }
    .brand { display: flex; align-items: center; gap: 11px; padding: 4px 6px 18px; color: var(--text); flex: 1; min-width: 0; }
    .logo { display: grid; place-items: center; width: 36px; height: 36px; border-radius: 11px; flex: none;
      background: var(--accent-grad); box-shadow: 0 6px 18px -6px rgba(79,107,255,.7), 0 0 0 1px rgba(255,255,255,.14) inset; }
    .logo.sm { width: 32px; height: 32px; border-radius: 10px; }
    .brand-text { display: flex; flex-direction: column; line-height: 1.15; min-width: 0; }
    .brand-text b { font-size: 15px; letter-spacing: .04em; }
    .brand-text small { font-size: 11.5px; color: var(--muted); white-space: nowrap; }
    .drawer-close { display: none; margin-bottom: 14px; }
    .nav { display: flex; flex-direction: column; gap: 2px; }
    .nav-h { font-size: 10.5px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--faint); padding: 14px 10px 6px; white-space: nowrap; }
    .nav a { position: relative; display: flex; align-items: center; gap: 11px; height: 40px; padding: 0 12px; border-radius: 10px; color: var(--muted);
      font-weight: 500; font-size: 13.5px; white-space: nowrap; transition: background .15s var(--ease), color .15s var(--ease); }
    .nav a:hover { color: var(--text); background: var(--panel); }
    .nav a.active { color: var(--text); background: linear-gradient(90deg, rgba(79,107,255,.16), rgba(79,107,255,.04)); box-shadow: 0 0 0 1px rgba(79,107,255,.22) inset; }
    .nav a.active::before { content: ''; position: absolute; left: -12px; top: 9px; bottom: 9px; width: 3px; border-radius: 0 3px 3px 0; background: var(--accent-grad); }
    .nav a.active ui-icon { color: var(--accent-text); }
    .side-card { margin-top: auto; display: flex; gap: 10px; align-items: flex-start; padding: 12px; border-radius: 12px; font-size: 11.5px; line-height: 1.45;
      color: var(--muted); background: var(--panel); border: 1px solid var(--border); }
    .side-card .dot { margin-top: 4px; box-shadow: 0 0 0 3px rgba(34,197,94,.15); }
    .side-foot { display: flex; align-items: center; gap: 6px; padding: 10px 6px 2px; margin-top: 8px; border-top: 1px solid var(--border); }
    .me { display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0; }
    .avatar { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 50%; flex: none; font-size: 12px; font-weight: 600;
      background: linear-gradient(140deg, #2b3550, #1a2132); border: 1px solid var(--border-2); color: var(--text-2); }
    .me-text { display: flex; flex-direction: column; min-width: 0; line-height: 1.25; }
    .me-text b { font-size: 13px; } .me-text small { font-size: 11.5px; color: var(--muted); }
    .icon-btn { width: 36px; height: 36px; padding: 0; flex: none; }
    .collapse { position: absolute; top: 26px; right: -12px; width: 24px; height: 24px; padding: 0; border-radius: 50%; z-index: 5;
      background: var(--panel-2); color: var(--muted); opacity: 0; transition: opacity .15s, transform .2s var(--ease); transform: rotate(180deg); }
    .side:hover .collapse, .collapse:focus-visible { opacity: 1; }
    .collapsed .collapse { transform: rotate(0deg); }
    .collapsed .brand-text, .collapsed .nav a span, .collapsed .me-text, .collapsed .side-card { display: none; }
    .collapsed .nav-h { display: block; height: 14px; padding: 0; overflow: hidden; color: transparent; }
    .collapsed .nav a { justify-content: center; padding: 0; }
    .collapsed .brand { justify-content: center; padding: 4px 0 18px; }
    .collapsed .side-foot { flex-direction: column; padding: 10px 0 2px; margin-top: auto; }
    .main-col { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
    .topbar { position: relative; z-index: 20; display: flex; align-items: center; gap: 16px; height: 62px; padding: 0 var(--gutter); flex: none;
      border-bottom: 1px solid var(--border); background: var(--glass); backdrop-filter: saturate(160%) blur(14px); -webkit-backdrop-filter: saturate(160%) blur(14px); }
    .burger, .mbrand, .top-avatar, .bottom-nav, .scrim { display: none; }
    .usearch { position: relative; display: flex; align-items: center; flex: 1; max-width: 600px; color: var(--faint); }
    .usearch ui-icon { position: absolute; left: 13px; pointer-events: none; }
    .usearch input { width: 100%; height: 40px; padding-left: 40px; padding-right: 64px; background: var(--panel); border-color: var(--border); border-radius: 12px; }
    .usearch kbd { position: absolute; right: 10px; font: 500 10.5px var(--sans); color: var(--faint); border: 1px solid var(--border-2); border-radius: 5px; padding: 2px 6px; pointer-events: none; }
    .env { margin-left: auto; display: inline-flex; align-items: center; gap: 8px; font-size: 12px; color: var(--muted); white-space: nowrap;
      padding: 6px 12px; border-radius: 999px; border: 1px solid var(--border); background: var(--panel); }
    main { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; }
    main.full { height: 100%; }

    /* tablet: icon rail */
    @media (max-width: 1100px) and (min-width: 768px) {
      .shell, .shell.collapsed { grid-template-columns: 72px minmax(0, 1fr); }
      .brand-text, .nav a span, .me-text, .collapse, .side-card, .env { display: none; }
      .nav-h { height: 14px; padding: 0; overflow: hidden; color: transparent; }
      .nav a { justify-content: center; padding: 0; }
      .brand { justify-content: center; padding: 4px 0 18px; }
      .side-foot { flex-direction: column; margin-top: auto; padding: 10px 0 2px; }
    }

    /* phone: off-canvas drawer + bottom navigation */
    @media (max-width: 767px) {
      .shell, .shell.collapsed { display: block; height: 100%; }
      .main-col { height: 100%; }
      .side { position: fixed; inset: 0 auto 0 0; width: min(300px, 86vw); padding-top: calc(16px + env(safe-area-inset-top));
        transform: translateX(-102%); transition: transform .25s var(--ease); box-shadow: var(--shadow-lg); }
      .drawer-open .side { transform: none; }
      .scrim { display: block; position: fixed; inset: 0; z-index: 25; background: rgba(3,5,8,.6); backdrop-filter: blur(3px);
        opacity: 0; pointer-events: none; transition: opacity .2s var(--ease); }
      .drawer-open .scrim { opacity: 1; pointer-events: auto; }
      .drawer-close { display: inline-flex; }
      .collapse { display: none; }
      /* the desktop "collapsed" preference must not shrink the drawer */
      .collapsed .brand-text, .collapsed .me-text { display: flex; }
      .collapsed .nav a span { display: inline; }
      .collapsed .side-card { display: flex; }
      .collapsed .nav a { justify-content: flex-start; padding: 0 12px; }
      .collapsed .nav-h { height: auto; padding: 14px 10px 6px; color: var(--faint); }
      .collapsed .brand { justify-content: flex-start; padding: 4px 6px 18px; }
      .collapsed .side-foot { flex-direction: row; padding: 10px 6px 2px; }
      .topbar { gap: 10px; height: calc(58px + env(safe-area-inset-top)); padding-top: env(safe-area-inset-top); }
      .burger, .top-avatar { display: grid; }
      .mbrand { display: flex; flex: none; }
      .top-avatar { width: 32px; height: 32px; font-size: 11px; }
      .usearch kbd, .env { display: none; }
      .usearch input { height: 38px; padding-right: 12px; }
      main { padding-bottom: var(--bottom-nav); }
      .bottom-nav { display: grid; grid-template-columns: repeat(4, 1fr); position: fixed; left: 0; right: 0; bottom: 0; z-index: 20;
        height: var(--bottom-nav); padding-bottom: env(safe-area-inset-bottom); border-top: 1px solid var(--border);
        background: var(--glass); backdrop-filter: saturate(160%) blur(16px); -webkit-backdrop-filter: saturate(160%) blur(16px); }
      .bottom-nav a { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; color: var(--faint); font-size: 11px; font-weight: 500; }
      .bottom-nav a.active { color: var(--accent-text); }
      .bottom-nav a.active ui-icon { filter: drop-shadow(0 0 8px rgba(79,107,255,.6)); }
    }
  `,
})
export class App {
  protected readonly auth = inject(AuthStore);
  protected readonly toast = inject(Toast);
  private readonly router = inject(Router);
  protected q = '';
  protected readonly collapsed = signal(readCollapsed());
  protected readonly drawer = signal(false);
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

  constructor() {
    // the mobile drawer closes whenever a navigation completes
    this.router.events.pipe(filter((e) => e instanceof NavigationEnd)).subscribe(() => this.drawer.set(false));
  }

  @HostListener('document:keydown.escape')
  closeDrawer() {
    this.drawer.set(false);
  }

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
