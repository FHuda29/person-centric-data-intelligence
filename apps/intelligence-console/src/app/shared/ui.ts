import { Component, computed, input } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { inject } from '@angular/core';
import { colorOf, iconSvg, TYPE_LABEL } from '../core/entity-style';

/** Round type icon (graph-node look) — used in lists, chips and legends. */
@Component({
  selector: 'ent-icon',
  template: `<span class="ei" [style.background]="color()" [style.width.px]="size()" [style.height.px]="size()" [innerHTML]="svg()" [title]="title()"></span>`,
  styles: `.ei { display: inline-grid; place-items: center; border-radius: 50%; flex: none; } .ei ::ng-deep svg { width: 62%; height: 62%; }`,
})
export class EntIcon {
  type = input.required<string>();
  size = input(20);
  private s = inject(DomSanitizer);
  color = computed(() => colorOf(this.type()));
  title = computed(() => TYPE_LABEL[this.type()] ?? this.type());
  svg = computed<SafeHtml>(() => this.s.bypassSecurityTrustHtml(iconSvg(this.type())));
}

@Component({
  selector: 'ent-chip',
  imports: [EntIcon],
  template: `<span class="chip"><ent-icon [type]="type()" [size]="size()" /><span class="ellipsis" [class.masked]="masked()">{{ label() }}</span></span>`,
  styles: `.chip { max-width: 100%; } .masked { font-family: var(--mono); font-size: 12px; }`,
})
export class EntChip {
  type = input.required<string>();
  label = input.required<string>();
  masked = input(false);
  size = input(18);
}

// 24×24 stroke icons for navigation and actions (inherit currentColor).
const UI_ICONS: Record<string, string> = {
  cases: '<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>',
  hub: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  shield: '<path d="M12 3 5 6v5c0 4.5 3 8.3 7 10 4-1.7 7-5.5 7-10V6z"/><path d="m9 12 2 2 4-4"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4.4 3.6-7 8-7s8 2.6 8 7"/>',
  logout: '<path d="M15 4h3.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H15"/><path d="M10 16l-4-4 4-4M6 12h10"/>',
  dashboard: '<rect x="3" y="3" width="8" height="10" rx="1.5"/><rect x="13" y="3" width="8" height="6" rx="1.5"/><rect x="13" y="11" width="8" height="10" rx="1.5"/><rect x="3" y="15" width="8" height="6" rx="1.5"/>',
  graph: '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="8" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="m8.3 7 7.4.8M7.3 8.2l3.6 7.6M16.9 10.2l-3.6 5.6"/>',
  entities: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  timeline: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  narrative: '<path d="M4 5h16v11H9l-5 4z"/><path d="M8 9h8M8 12h5"/>',
  evidence: '<path d="M6 2.5h8l4 4v15H6z"/><path d="M14 2.5v4h4M9 13l2 2 4-4"/>',
  merge: '<circle cx="6" cy="5" r="2.2"/><circle cx="6" cy="19" r="2.2"/><circle cx="18" cy="12" r="2.2"/><path d="M6 7.2v9.6M6 9c0 3 3 3 9.8 3"/>',
  finding: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2V16h5v-.1c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z"/>',
  report: '<path d="M6 2.5h8l4 4v15H6z"/><path d="M14 2.5v4h4M9 17v-3M12 17v-6M15 17v-2"/>',
  audit: '<path d="M9 4h6M9 4a2 2 0 0 0-2 2H6a1.5 1.5 0 0 0-1.5 1.5v12A1.5 1.5 0 0 0 6 21h12a1.5 1.5 0 0 0 1.5-1.5v-12A1.5 1.5 0 0 0 18 6h-1a2 2 0 0 0-2-2M9 4a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2"/><path d="M8.5 12h7M8.5 16h5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  play: '<path d="M7 4.5v15l12-7.5z"/>',
  sparkle: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4"/>',
  fit: '<path d="M4 9V5.5A1.5 1.5 0 0 1 5.5 4H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15"/>',
  download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
  upload: '<path d="M12 20V9M7 14l5-5 5 5M5 4h14"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  inbox: '<path d="M3 13h5l1.5 3h5L16 13h5"/><path d="M5.5 5h13L21 13v5.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5V13z"/>',
  cursor: '<path d="m5 3 14 7-6 2-2 6z"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m3 13 9 5 9-5"/>',
};

/** Line icon from the console's built-in set. */
@Component({
  selector: 'ui-icon',
  template: `<svg [attr.width]="size()" [attr.height]="size()" viewBox="0 0 24 24" fill="none" stroke="currentColor" [attr.stroke-width]="stroke()"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" [innerHTML]="svg()"></svg>`,
  styles: `:host { display: inline-flex; flex: none; } svg { display: block; }`,
})
export class UiIcon {
  name = input.required<string>();
  size = input(16);
  stroke = input(1.8);
  private s = inject(DomSanitizer);
  svg = computed<SafeHtml>(() => this.s.bypassSecurityTrustHtml(UI_ICONS[this.name()] ?? ''));
}

@Component({
  selector: 'conf-bar',
  template: `<span class="row" style="gap:6px"><span class="bar" style="width:60px"><i [style.width.%]="value() * 100" [style.background]="color()"></i></span><span class="tiny muted">{{ value().toFixed(2) }}</span></span>`,
})
export class ConfBar {
  value = input(0);
  color = computed(() => (this.value() >= 0.8 ? 'var(--ok)' : this.value() >= 0.55 ? 'var(--accent)' : 'var(--warn)'));
}
