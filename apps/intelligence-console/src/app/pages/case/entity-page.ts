import { Component, inject, input } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { EntityPanel } from './entity-panel';
import { CaseContext } from './case-context';

@Component({
  selector: 'app-entity-page',
  imports: [EntityPanel, RouterLink],
  template: `
    <div class="page" style="max-width:980px">
      <a routerLink="../" class="small">← Entities</a>
      <div class="card mt"><entity-panel [entityId]="entityId()" (select)="go($event)" /></div>
    </div>
  `,
})
export class EntityPage {
  entityId = input.required<string>();
  private router = inject(Router);
  private ctx = inject(CaseContext);
  go(id: string) {
    void this.router.navigate(['/cases', this.ctx.caseId(), 'entities', id]);
  }
}
