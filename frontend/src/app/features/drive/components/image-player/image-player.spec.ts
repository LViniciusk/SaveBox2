import { ComponentFixture, TestBed } from '@angular/core/testing';

import { ImagePlayer } from './image-player';

describe('ImagePlayer', () => {
  let component: ImagePlayer;
  let fixture: ComponentFixture<ImagePlayer>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ImagePlayer]
    })
    .compileComponents();

    fixture = TestBed.createComponent(ImagePlayer);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
