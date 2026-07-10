import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { AppStateService, AppStatus } from './core/state/app-state.service';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  protected readonly appState = inject(AppStateService);
  protected readonly AppStatus = AppStatus;
}
