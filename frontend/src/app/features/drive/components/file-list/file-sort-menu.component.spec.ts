import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { FileSortMenuComponent } from './file-sort-menu.component';

describe('FileSortMenuComponent', () => {
  let fixture: ComponentFixture<FileSortMenuComponent>;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [FileSortMenuComponent],
      providers: [provideZonelessChangeDetection()],
    });
    fixture = TestBed.createComponent(FileSortMenuComponent);
    fixture.componentRef.setInput('column', 'size');
    fixture.componentRef.setInput('direction', 'desc');
    fixture.componentRef.setInput('foldersMode', 'mixed');
    fixture.detectChanges();
  });

  it('renders the selected state and emits typed sort values', () => {
    const columns: string[] = [];
    const directions: string[] = [];
    const folders: string[] = [];
    fixture.componentInstance.columnChange.subscribe(value => columns.push(value));
    fixture.componentInstance.directionChange.subscribe(value => directions.push(value));
    fixture.componentInstance.foldersModeChange.subscribe(value => folders.push(value));
    const buttons = Array.from(fixture.nativeElement.querySelectorAll('button')) as HTMLButtonElement[];

    buttons.find(button => button.textContent.includes('Nome'))!.click();
    buttons.find(button => button.textContent.includes('Menor pro maior'))!.click();
    buttons.find(button => button.textContent.includes('No topo'))!.click();

    expect(columns).toEqual(['name']);
    expect(directions).toEqual(['asc']);
    expect(folders).toEqual(['top']);
    expect(fixture.nativeElement.textContent).toContain('check');
  });

  it('labels each sort direction using the selected column', () => {
    expect(fixture.componentInstance.directionLabel('asc')).toBe('Menor pro maior');
    expect(fixture.componentInstance.directionLabel('desc')).toBe('Maior pro menor');
  });
});
