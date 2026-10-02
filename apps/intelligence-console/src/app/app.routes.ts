import { Routes } from '@angular/router';
import { authGuard } from './core/api';

export const routes: Routes = [
  { path: 'login', loadComponent: () => import('./pages/login').then((m) => m.LoginPage) },
  {
    path: '',
    canActivate: [authGuard],
    children: [
      { path: '', loadComponent: () => import('./pages/cases').then((m) => m.CasesPage) },
      { path: 'search', loadComponent: () => import('./pages/search').then((m) => m.SearchPage) },
      { path: 'sources', loadComponent: () => import('./pages/sources').then((m) => m.SourcesPage) },
      { path: 'admin', loadComponent: () => import('./pages/admin').then((m) => m.AdminPage) },
      {
        path: 'cases/:caseId',
        loadComponent: () => import('./pages/case/workspace').then((m) => m.CaseWorkspace),
        children: [
          { path: '', loadComponent: () => import('./pages/case/dashboard').then((m) => m.CaseDashboard) },
          { path: 'graph', loadComponent: () => import('./pages/case/graph-explorer').then((m) => m.GraphExplorer) },
          { path: 'entities', loadComponent: () => import('./pages/case/entities').then((m) => m.EntitiesPage) },
          { path: 'entities/:entityId', loadComponent: () => import('./pages/case/entity-page').then((m) => m.EntityPage) },
          { path: 'timeline', loadComponent: () => import('./pages/case/timeline').then((m) => m.TimelinePage) },
          { path: 'narrative', loadComponent: () => import('./pages/case/narrative').then((m) => m.NarrativePage) },
          { path: 'evidence', loadComponent: () => import('./pages/case/evidence').then((m) => m.EvidencePage) },
          { path: 'resolution', loadComponent: () => import('./pages/case/resolution').then((m) => m.ResolutionPage) },
          { path: 'findings', loadComponent: () => import('./pages/case/findings').then((m) => m.FindingsPage) },
          { path: 'reports', loadComponent: () => import('./pages/case/reports').then((m) => m.ReportsPage) },
          { path: 'audit', loadComponent: () => import('./pages/case/audit').then((m) => m.CaseAuditPage) },
        ],
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
