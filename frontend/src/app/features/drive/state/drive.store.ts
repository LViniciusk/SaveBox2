import { Injectable, signal } from '@angular/core';

export interface DriveFile {
  id: number;
  name: string;
  type: string;
  size: string;
  modifiedAt: string;
  owner: string;
}

@Injectable({ providedIn: 'root' })
export class DriveStore {
  readonly files = signal<DriveFile[]>([
    {
      id: 1,
      name: 'Documentos Pessoais',
      type: 'folder',
      size: '—',
      modifiedAt: '9 jul 2026',
      owner: 'eu',
    },
    {
      id: 2,
      name: 'Relatório Financeiro Q2 2026.pdf',
      type: 'pdf',
      size: '2,4 MB',
      modifiedAt: '8 jul 2026',
      owner: 'eu',
    },
    {
      id: 3,
      name: 'foto_ferias_2026.jpg',
      type: 'image',
      size: '4,1 MB',
      modifiedAt: '5 jul 2026',
      owner: 'eu',
    },
    {
      id: 4,
      name: 'Projeto SaveBox - Arquitetura.docx',
      type: 'doc',
      size: '890 KB',
      modifiedAt: '3 jul 2026',
      owner: 'eu',
    },
    {
      id: 5,
      name: 'Orçamento_2026.xlsx',
      type: 'spreadsheet',
      size: '1,2 MB',
      modifiedAt: '1 jul 2026',
      owner: 'eu',
    },
  ]);
}
