import { AfterViewInit, Component, effect, ElementRef, inject, OnDestroy, signal, untracked, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import cytoscape, { Core, ElementDefinition } from 'cytoscape';
import fcose from 'cytoscape-fcose';
import { Api, Toast } from '../../core/api';
import { colorOf, ENTITY_TYPES, iconDataUri, RELATIONSHIP_TYPES, TYPE_LABEL } from '../../core/entity-style';
import { EntIcon, UiIcon } from '../../shared/ui';
import { CaseContext } from './case-context';
import { EntityPanel } from './entity-panel';

cytoscape.use(fcose);

interface GNode { id: string; type: string; label: string; masked: boolean; confidence: number; status: string; isSeed: boolean; degree: number; betweenness: number; component: number; properties: any }
interface GEdge { id: string; from: string; to: string; type: string; confidence: number; status: string; label: string | null; evidenceId: string | null }

@Component({
  selector: 'app-graph-explorer',
  imports: [FormsModule, RouterLink, EntIcon, EntityPanel, UiIcon],
  template: `
    <div class="gx" [class.open]="!!selected() || !!selectedEdge()">
      <aside class="left">
        <h4>Entity types</h4>
        @for (t of types; track t) {
          <label class="check typ" [class.dim]="!counts()[t]">
            <input type="checkbox" [checked]="visibleTypes().has(t)" (change)="toggleType(t)" />
            <ent-icon [type]="t" [size]="16" /><span class="grow ellipsis">{{ label[t] }}</span><span class="faint tiny">{{ counts()[t] ?? 0 }}</span>
          </label>
        }
        <h4 class="mt2">Edges</h4>
        <label class="field">Min confidence {{ minConf().toFixed(2) }}
          <input type="range" min="0" max="1" step="0.05" [ngModel]="minConf()" (ngModelChange)="minConf.set(+$event); applyFilters()" /></label>
        <label class="check"><input type="checkbox" [ngModel]="hideRejected()" (ngModelChange)="hideRejected.set($event); applyFilters()" /> Hide rejected</label>
        <label class="check"><input type="checkbox" [ngModel]="edgeLabels()" (ngModelChange)="edgeLabels.set($event); restyle()" /> Edge labels</label>
        <label class="check"><input type="checkbox" [ngModel]="hideMentions()" (ngModelChange)="hideMentions.set($event); applyFilters()" /> Hide MENTIONED_IN</label>
        <h4 class="mt2">Node size</h4>
        <select [ngModel]="sizeBy()" (ngModelChange)="sizeBy.set($event); restyle()">
          <option value="uniform">Uniform</option><option value="degree">Degree centrality</option><option value="betweenness">Betweenness</option><option value="confidence">Confidence</option>
        </select>
        <h4 class="mt2">Layout</h4>
        <div class="seg">
          @for (l of layouts; track l) { <button class="sm" (click)="layout(l)">{{ l }}</button> }
        </div>
        @if (ctx.canEdit()) {
          <h4 class="mt2">Add entity</h4>
          <form class="col" (ngSubmit)="addEntity()">
            <select name="nt" [(ngModel)]="newType">@for (t of types; track t) { <option [value]="t">{{ label[t] }}</option> }</select>
            <input name="nv" [(ngModel)]="newValue" placeholder="Value" />
            @if (selected()) {
              <select name="nr" [(ngModel)]="newRel">@for (r of relTypes; track r) { <option>{{ r }}</option> }</select>
              <span class="tiny faint">linked from the selected entity</span>
            }
            <button class="sm" [disabled]="!newValue.trim()">Add to graph</button>
          </form>
        }
        <div class="tiny faint mt2">Centrality shows structural position in the collected data — not evidence of coordination or intent.</div>
      </aside>

      <section class="center">
        <div class="toolbar">
          <div class="find"><ui-icon name="search" [size]="14" />
            <input placeholder="Find node…" [ngModel]="find()" (ngModelChange)="find.set($event); highlight()" /></div>
          <span class="small muted ellipsis" [title]="stats()">{{ stats() }}</span>
          <span class="spacer"></span>
          @if (pathFrom()) { <span class="small">Path from <b>{{ nodeLabel(pathFrom()!) }}</b> — select target</span><button class="sm ghost" (click)="pathFrom.set(null)">cancel</button> }
          @if (focusMode()) { <button class="sm" (click)="loadAll()">Show whole case</button> }
          <div class="tb-group">
            <button class="sm ghost" (click)="fit()" title="Fit to screen"><ui-icon name="fit" [size]="15" />Fit</button>
            <button class="sm ghost" (click)="load()" title="Reload graph"><ui-icon name="refresh" [size]="15" />Refresh</button>
            <button class="sm ghost" (click)="png()" title="Export PNG"><ui-icon name="download" [size]="15" />PNG</button>
          </div>
        </div>
        <div #cy class="cy"></div>
        @if (!nodes().length && loaded()) {
          <div class="overlay empty">No entities in this case yet. Add a seed on the Dashboard, then run the investigation or a transform.</div>
        }
        <div class="legend tiny">
          <span><i class="ln"></i> confirmed</span><span><i class="ln dash"></i> candidate</span><span><i class="ln red"></i> rejected</span>
          <span class="sep"></span><span><kbd>Click</kbd> profile</span><span><kbd>Right-click</kbd> transforms</span><span><kbd>Double-click</kbd> expand</span>
        </div>
      </section>

      <aside class="right">
        <button class="ghost sm close" (click)="clearSelection()" aria-label="Close panel">✕</button>
        @if (selected(); as id) {
          <entity-panel [entityId]="id" [compact]="true" (expand)="expand($event.id, $event.depth)" (select)="selectNode($event)" />
          <div class="row mt"><button class="sm" (click)="pathFrom.set(id)">Find path from here…</button></div>
        } @else if (selectedEdge(); as e) {
          <h4>Relationship</h4>
          <dl class="kv">
            <dt>Type</dt><dd><b>{{ e.type }}</b></dd>
            <dt>From</dt><dd>{{ nodeLabel(e.from) }}</dd><dt>To</dt><dd>{{ nodeLabel(e.to) }}</dd>
            <dt>Confidence</dt><dd>{{ e.confidence.toFixed(2) }}</dd><dt>Status</dt><dd><span class="badge {{ e.status }}">{{ e.status }}</span></dd>
            <dt>Note</dt><dd>{{ e.label || '—' }}</dd>
            <dt>Evidence</dt><dd>@if (e.evidenceId) { <a [routerLink]="['/cases', ctx.caseId(), 'evidence']" [queryParams]="{ id: e.evidenceId }">open evidence</a> } @else { none }</dd>
          </dl>
          @if (ctx.canEdit()) {
            <div class="row mt"><button class="sm" [disabled]="!e.evidenceId" (click)="reviewEdge(e.id, 'CONFIRMED')">Confirm</button>
              <button class="sm danger" (click)="reviewEdge(e.id, 'REJECTED')">Reject</button></div>
          }
        }
      </aside>
    </div>

    @if (menu(); as m) {
      <div class="ctx-menu" [style.left.px]="m.x" [style.top.px]="m.y" (click)="$event.stopPropagation()">
        <div class="h">{{ m.label }}</div>
        @for (t of m.transforms; track t.key) {
          <button [disabled]="!t.runnable || !ctx.canEdit()" (click)="runTransform(m.id, t.key)">
            <span><span class="badge tier">{{ t.tier }}</span> {{ t.name }}</span>
            <small>{{ t.runnable ? t.description : 'blocked: ' + t.blockedReason }}</small>
          </button>
        } @empty { <div class="h">No transforms for this type</div> }
        <div class="h">Graph</div>
        <button (click)="expand(m.id, 1); menu.set(null)"><span>Expand neighbours (depth 1)</span></button>
        <button (click)="expand(m.id, 2); menu.set(null)"><span>Expand neighbours (depth 2)</span></button>
        <button (click)="pathFrom.set(m.id); menu.set(null)"><span>Find shortest path from here…</span></button>
      </div>
    }
  `,
  styles: `
    :host { display: block; height: 100%; }
    .gx { display: grid; grid-template-columns: 240px minmax(0, 1fr); height: 100%; min-height: 560px; border-top: 1px solid var(--border); }
    .gx.open { grid-template-columns: 240px minmax(0, 1fr) 380px; }
    .gx:not(.open) .right { display: none; }
    .right { position: relative; }
    .close { position: absolute; top: 12px; right: 12px; width: 28px; padding: 0; z-index: 2; }
    .legend .sep { width: 1px; height: 14px; background: var(--border-2); }
    .legend kbd { margin-right: 4px; }
    .left, .right { overflow: auto; padding: 18px 16px; background: var(--bg-2); }
    .left { border-right: 1px solid var(--border); }
    .right { border-left: 1px solid var(--border); padding: 20px; }
    .left h4 { margin: 0 0 10px; }
    .left .typ { display: flex; width: 100%; padding: 5px 6px; border-radius: 7px; gap: 9px; }
    .left .typ:hover { background: var(--panel); }
    .left .dim { opacity: .4; }
    .left .field, .left select, .left input:not([type]) { width: 100%; }
    .left form button { width: 100%; }
    .seg { display: flex; flex-wrap: wrap; gap: 4px; }
    .seg button { text-transform: capitalize; }
    .center { position: relative; display: flex; flex-direction: column; min-width: 0; }
    .toolbar { display: flex; align-items: center; gap: 12px; padding: 10px 14px; border-bottom: 1px solid var(--border); background: var(--bg-2); min-width: 0; }
    .find { position: relative; display: flex; align-items: center; color: var(--faint); flex: none; }
    .find ui-icon { position: absolute; left: 10px; pointer-events: none; }
    .find input { width: 220px; height: 32px; padding-left: 30px; }
    .tb-group { display: flex; gap: 2px; padding: 2px; border: 1px solid var(--border); border-radius: 9px; background: var(--panel); flex: none; }
    .cy { flex: 1; min-height: 0; background-color: #0a0e14;
      background-image: radial-gradient(rgba(148,163,184,.09) 1px, transparent 1px); background-size: 22px 22px; }
    .overlay { position: absolute; inset: 54px 0 0 0; display: grid; place-items: center; pointer-events: none; }
    .legend { position: absolute; left: 14px; bottom: 12px; display: flex; gap: 14px; align-items: center; color: var(--muted);
      background: rgba(13,17,23,.85); border: 1px solid var(--border); padding: 6px 12px; border-radius: 999px; backdrop-filter: blur(6px); }
    .ln { display: inline-block; width: 18px; border-top: 2px solid #6b7f99; vertical-align: middle; margin-right: 4px; }
    .ln.dash { border-top-style: dashed; } .ln.red { border-top-color: #b04040; }
    kbd { justify-self: start; font: 500 11px var(--sans); color: var(--text-2); background: var(--panel-2); border: 1px solid var(--border-2); border-bottom-width: 2px;
      border-radius: 6px; padding: 2px 7px; text-align: center; }
    @media (max-width: 1280px) { .gx.open { grid-template-columns: 220px minmax(0, 1fr) 340px; } .gx { grid-template-columns: 220px minmax(0, 1fr); } }
    @media (max-width: 1100px) { .gx { grid-template-columns: 1fr; grid-auto-rows: auto 70vh auto; } }
  `,
})
export class GraphExplorer implements AfterViewInit, OnDestroy {
  ctx = inject(CaseContext);
  private api = inject(Api);
  private toast = inject(Toast);
  private host = viewChild.required<ElementRef<HTMLDivElement>>('cy');
  private cy?: Core;

  types = [...ENTITY_TYPES];
  relTypes = RELATIONSHIP_TYPES;
  label = TYPE_LABEL;
  layouts = ['fcose', 'concentric', 'breadthfirst', 'circle', 'grid'];
  nodes = signal<GNode[]>([]);
  edges = signal<GEdge[]>([]);
  loaded = signal(false);
  counts = signal<Record<string, number>>({});
  visibleTypes = signal(new Set<string>(ENTITY_TYPES));
  minConf = signal(0);
  hideRejected = signal(true);
  hideMentions = signal(false);
  edgeLabels = signal(false);
  sizeBy = signal<'uniform' | 'degree' | 'betweenness' | 'confidence'>('degree');
  find = signal('');
  selected = signal<string | null>(null);
  selectedEdge = signal<GEdge | null>(null);
  pathFrom = signal<string | null>(null);
  focusMode = signal(false);
  stats = signal('');
  menu = signal<{ id: string; x: number; y: number; label: string; transforms: any[] } | null>(null);
  newType = 'PERSON';
  newValue = '';
  newRel = 'ASSOCIATED_WITH';
  private closeMenu = () => this.menu.set(null);

  constructor() {
    // the side panel opens/closes with the selection — let cytoscape re-measure its container
    effect(() => {
      this.selected();
      this.selectedEdge();
      setTimeout(() => this.cy?.resize());
    });
    effect(() => {
      this.ctx.version();
      const id = this.ctx.caseId();
      if (id && this.cy) untracked(() => void (this.focusMode() ? null : this.load()));
    });
  }

  ngAfterViewInit() {
    this.cy = cytoscape({
      container: this.host().nativeElement,
      wheelSensitivity: 0.25,
      minZoom: 0.08,
      maxZoom: 3,
      style: this.style(),
    });
    this.cy.on('tap', 'node', (e) => {
      const id = e.target.id();
      if (this.pathFrom() && this.pathFrom() !== id) {
        void this.path(this.pathFrom()!, id);
        this.pathFrom.set(null);
      }
      this.selectedEdge.set(null);
      this.selected.set(id);
    });
    this.cy.on('tap', 'edge', (e) => {
      this.selected.set(null);
      this.selectedEdge.set(this.edges().find((x) => x.id === e.target.id()) ?? null);
    });
    this.cy.on('tap', (e) => {
      if (e.target === this.cy) {
        this.selected.set(null);
        this.selectedEdge.set(null);
      }
      this.menu.set(null);
    });
    this.cy.on('dbltap', 'node', (e) => void this.expand(e.target.id(), 1));
    this.cy.on('cxttap', 'node', (e) => void this.openMenu(e.target.id(), e.originalEvent as MouseEvent));
    document.addEventListener('click', this.closeMenu);
    void this.load();
  }

  clearSelection() {
    this.selected.set(null);
    this.selectedEdge.set(null);
    this.cy?.elements().unselect();
  }

  ngOnDestroy() {
    document.removeEventListener('click', this.closeMenu);
    this.cy?.destroy();
  }

  private style(): any[] {
    return [
      {
        selector: 'node',
        style: {
          'background-color': 'data(color)',
          'background-image': 'data(icon)',
          'background-width': '58%',
          'background-height': '58%',
          width: 'data(size)',
          height: 'data(size)',
          label: 'data(label)',
          color: '#d5dde8',
          'font-family': 'Inter Variable, Inter, system-ui, sans-serif',
          'font-size': 10.5,
          'font-weight': 500,
          'text-valign': 'bottom',
          'text-margin-y': 5,
          'text-max-width': '120px',
          'text-wrap': 'ellipsis',
          'text-background-color': '#0a0e14',
          'text-background-opacity': 0.82,
          'text-background-padding': '2px',
          'text-background-shape': 'roundrectangle',
          // labels drop out when zoomed out so dense graphs stay readable
          'min-zoomed-font-size': 8,
          'border-width': 'data(border)',
          'border-color': '#e2e8f0',
          'overlay-opacity': 0,
        },
      },
      { selector: 'node[?seed]', style: { 'border-color': '#fbbf24', 'border-width': 3 } },
      { selector: 'node[status = "REJECTED"]', style: { opacity: 0.35 } },
      { selector: 'node:selected', style: { 'border-color': '#4c8dff', 'border-width': 4, 'min-zoomed-font-size': 0, 'font-weight': 600 } },
      { selector: 'node[?seed]', style: { 'min-zoomed-font-size': 0 } },
      { selector: 'node.hl', style: { 'border-color': '#f59e0b', 'border-width': 4 } },
      { selector: 'node.faded, edge.faded', style: { opacity: 0.12 } },
      {
        selector: 'edge',
        style: {
          width: 'mapData(conf, 0, 1, 0.6, 3)',
          'line-color': '#3a475a',
          'target-arrow-color': '#3a475a',
          'target-arrow-shape': 'triangle',
          'arrow-scale': 0.7,
          'curve-style': 'bezier',
          'line-style': 'solid',
          label: this.edgeLabels() ? 'data(type)' : '',
          'font-size': 8,
          color: '#8b9bb0',
          'text-rotation': 'autorotate',
          'text-outline-color': '#0a0f16',
          'text-outline-width': 2,
        },
      },
      { selector: 'edge[status = "CANDIDATE"]', style: { 'line-style': 'dashed' } },
      { selector: 'edge[status = "CONFIRMED"]', style: { 'line-color': '#22c55e', 'target-arrow-color': '#22c55e' } },
      { selector: 'edge[status = "REJECTED"]', style: { 'line-color': '#7a2a2a', 'target-arrow-color': '#7a2a2a' } },
      { selector: 'edge.path', style: { 'line-color': '#f59e0b', 'target-arrow-color': '#f59e0b', width: 4 } },
      { selector: 'edge:selected', style: { 'line-color': '#2f8cff', 'target-arrow-color': '#2f8cff', width: 3 } },
    ];
  }

  restyle() {
    if (!this.cy) return;
    this.cy.batch(() => this.cy!.nodes().forEach((n) => {
      n.data('size', this.sizeOf(this.nodes().find((x) => x.id === n.id())));
    }));
    this.cy.style(this.style());
  }

  private sizeOf(n: GNode | undefined) {
    if (!n) return 34;
    const s = this.sizeBy();
    const max = (k: 'degree' | 'betweenness') => Math.max(1e-6, ...this.nodes().map((x) => x[k]));
    if (s === 'degree') return 28 + 46 * Math.sqrt(n.degree / max('degree'));
    if (s === 'betweenness') return 28 + 46 * Math.sqrt(n.betweenness / max('betweenness'));
    if (s === 'confidence') return 24 + 34 * n.confidence;
    return 34;
  }

  private toElements(nodes: GNode[], edges: GEdge[]): ElementDefinition[] {
    const ids = new Set(nodes.map((n) => n.id));
    return [
      ...nodes.map((n) => ({
        group: 'nodes' as const,
        data: {
          id: n.id, label: n.label.length > 48 ? n.label.slice(0, 46) + '…' : n.label, type: n.type, color: colorOf(n.type),
          icon: iconDataUri(n.type), size: this.sizeOf(n), seed: n.isSeed, status: n.status, border: n.isSeed ? 3 : 0, conf: n.confidence,
        },
      })),
      ...edges
        .filter((e) => ids.has(e.from) && ids.has(e.to))
        .map((e) => ({ group: 'edges' as const, data: { id: e.id, source: e.from, target: e.to, type: e.type, conf: e.confidence, status: e.status } })),
    ];
  }

  async load() {
    try {
      const g = await this.api.get<any>('/graph', { caseId: this.ctx.caseId() });
      this.focusMode.set(false);
      this.render(g.nodes, g.edges, true);
      this.stats.set(`${g.nodes.length} nodes · ${g.edges.length} edges · ${g.components} components · ${g.engine}`);
    } catch (e) {
      this.toast.error(e);
    } finally {
      this.loaded.set(true);
    }
  }

  loadAll() {
    void this.load();
  }

  private render(nodes: GNode[], edges: GEdge[], relayout: boolean) {
    if (!this.cy) return;
    const prev = new Map(this.cy.nodes().map((n) => [n.id(), n.position()] as const));
    this.nodes.set(nodes);
    this.edges.set(edges);
    const counts: Record<string, number> = {};
    for (const n of nodes) counts[n.type] = (counts[n.type] ?? 0) + 1;
    this.counts.set(counts);
    this.cy.batch(() => {
      this.cy!.elements().remove();
      this.cy!.add(this.toElements(nodes, edges));
      this.cy!.nodes().forEach((n) => {
        const p = prev.get(n.id());
        if (p) n.position(p);
      });
    });
    this.applyFilters();
    const newNodes = nodes.filter((n) => !prev.has(n.id)).length;
    if (relayout && (newNodes > 0 || prev.size === 0)) this.layout('fcose', prev.size > 0 && newNodes < nodes.length);
  }

  layout(name: string, incremental = false) {
    if (!this.cy) return;
    const opts: any =
      name === 'fcose'
        ? { name, quality: 'default', randomize: !incremental, animate: true, animationDuration: 500, nodeRepulsion: 16000, idealEdgeLength: 120, nodeSeparation: 100, packComponents: true }
        : name === 'concentric'
          ? { name, concentric: (n: any) => n.degree(), levelWidth: () => 2, animate: true }
          : name === 'breadthfirst'
            ? { name, directed: false, spacingFactor: 1.2, animate: true, roots: this.cy.nodes('[?seed]') }
            : { name, animate: true };
    this.cy.elements(':visible').layout(opts).run();
  }

  applyFilters() {
    if (!this.cy) return;
    const vt = this.visibleTypes();
    this.cy.batch(() => {
      this.cy!.nodes().forEach((n) => {
        n.style('display', vt.has(n.data('type')) ? 'element' : 'none');
      });
      this.cy!.edges().forEach((e) => {
        const hide =
          e.data('conf') < this.minConf() ||
          (this.hideRejected() && e.data('status') === 'REJECTED') ||
          (this.hideMentions() && e.data('type') === 'MENTIONED_IN');
        e.style('display', hide ? 'none' : 'element');
      });
    });
  }

  toggleType(t: string) {
    const s = new Set(this.visibleTypes());
    s.has(t) ? s.delete(t) : s.add(t);
    this.visibleTypes.set(s);
    this.applyFilters();
  }

  highlight() {
    if (!this.cy) return;
    const q = this.find().trim().toLowerCase();
    this.cy.nodes().removeClass('hl');
    if (!q) return;
    const hits = this.cy.nodes().filter((n) => String(n.data('label')).toLowerCase().includes(q));
    hits.addClass('hl');
    if (hits.length) this.cy.animate({ fit: { eles: hits, padding: 80 }, duration: 400 });
  }

  fit() {
    this.cy?.animate({ fit: { eles: this.cy.elements(':visible'), padding: 40 }, duration: 300 });
  }

  selectNode(id: string) {
    this.selected.set(id);
    const n = this.cy?.getElementById(id);
    if (n?.nonempty()) {
      this.cy!.elements().unselect();
      n.select();
      this.cy!.animate({ center: { eles: n }, duration: 300 });
    }
  }

  nodeLabel(id: string) {
    return this.nodes().find((n) => n.id === id)?.label ?? id.slice(0, 8);
  }

  async expand(id: string, depth: number) {
    try {
      const g = await this.api.get<any>(`/entities/${id}/neighbors`, { depth });
      this.focusMode.set(true);
      this.render(g.nodes, g.edges, false);
      this.layout('fcose');
      this.stats.set(`Neighbourhood depth ${depth}: ${g.nodes.length} nodes · ${g.edges.length} edges · ${g.engine}`);
    } catch (e) {
      this.toast.error(e);
    }
  }

  async path(from: string, to: string) {
    try {
      const p = await this.api.get<any>(`/entities/${from}/path/${to}`);
      if (!p.found) {
        this.toast.show('No path between these entities');
        return;
      }
      const ids = new Set<string>([...p.nodes.map((n: any) => n.id), ...p.edges.map((e: any) => e.id)]);
      this.cy!.elements().addClass('faded').removeClass('path');
      this.cy!.elements().filter((el) => ids.has(el.id())).removeClass('faded');
      this.cy!.edges().filter((el) => ids.has(el.id())).addClass('path');
      this.stats.set(`Shortest path: ${p.order.length - 1} hop(s) — click the background to clear`);
      this.cy!.one('tap', (e) => e.target === this.cy && this.cy!.elements().removeClass('faded path'));
    } catch (e) {
      this.toast.error(e);
    }
  }

  async openMenu(id: string, ev: MouseEvent) {
    try {
      const transforms = await this.api.get<any[]>(`/entities/${id}/transforms`);
      const x = Math.min(ev.clientX, window.innerWidth - 300);
      const y = Math.min(ev.clientY, window.innerHeight - 200);
      this.menu.set({ id, x, y, label: this.nodeLabel(id), transforms });
    } catch (e) {
      this.toast.error(e);
    }
  }

  async runTransform(id: string, key: string) {
    this.menu.set(null);
    try {
      await this.api.post(`/entities/${id}/transforms/${key}`);
      this.toast.show(`Transform ${key} queued`);
      await this.ctx.pollJobs();
    } catch (e) {
      this.toast.error(e);
    }
  }

  async reviewEdge(id: string, status: string) {
    try {
      const r = await this.api.post<GEdge>(`/relationships/${id}/review`, { status });
      this.selectedEdge.set({ ...this.selectedEdge()!, status: r.status });
      this.ctx.bump();
    } catch (e) {
      this.toast.error(e);
    }
  }

  async addEntity() {
    try {
      await this.api.post('/entities', {
        caseId: this.ctx.caseId(),
        type: this.newType,
        value: this.newValue,
        linkTo: this.selected() ?? undefined,
        relType: this.selected() ? this.newRel : undefined,
      });
      this.newValue = '';
      this.ctx.bump();
    } catch (e) {
      this.toast.error(e);
    }
  }

  png() {
    if (!this.cy) return;
    const a = document.createElement('a');
    a.href = this.cy.png({ full: true, scale: 2, bg: '#0a0e14' });
    a.download = `graph-${this.ctx.data()?.code ?? 'case'}.png`;
    a.click();
  }
}
