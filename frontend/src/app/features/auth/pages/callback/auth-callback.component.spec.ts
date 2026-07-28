import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { AuthCallbackComponent } from './auth-callback.component';
import { AuthService } from '../../../../core/auth/auth.service';
import { ActivatedRoute, Router } from '@angular/router';
import { signal } from '@angular/core';
import { of } from 'rxjs';

describe('AuthCallbackComponent', () => {
  let component: AuthCallbackComponent;
  let fixture: any;
  let authSpy: any;
  let routerSpy: any;
  let activatedRouteStub: any;

  beforeEach(() => {
    authSpy = jasmine.createSpyObj('AuthService', ['linkGoogleDrive', 'handleOAuthCallback'], {
      loading: signal(false),
      error: signal(null)
    });

    routerSpy = jasmine.createSpyObj('Router', ['navigate']);

    activatedRouteStub = {
      snapshot: { queryParams: {} },
      fragment: of(null)
    };

    TestBed.configureTestingModule({
      imports: [AuthCallbackComponent],
      providers: [
        provideZonelessChangeDetection(),
        { provide: AuthService, useValue: authSpy },
        { provide: Router, useValue: routerSpy },
        { provide: ActivatedRoute, useValue: activatedRouteStub }
      ]
    });
  });

  const createComponent = () => {
    fixture = TestBed.createComponent(AuthCallbackComponent);
    component = fixture.componentInstance;
  };

  it('should call linkGoogleDrive if code and state are in queryParams', () => {
    activatedRouteStub.snapshot.queryParams = { code: '123', state: 'abc' };
    createComponent();
    component.ngOnInit();
    fixture.detectChanges();
    
    expect(authSpy.linkGoogleDrive).toHaveBeenCalledWith('123', 'abc');
  });

  it('should handle fragment if present in URL', () => {
    activatedRouteStub.fragment = of('id_token=jwt123');
    createComponent();
    fixture.detectChanges();
    
    expect(authSpy.handleOAuthCallback).toHaveBeenCalledWith('id_token=jwt123');
  });

  it('should handle missing fragment but present queryParams', () => {
    activatedRouteStub.fragment = of(null);
    activatedRouteStub.snapshot.queryParams = { some_param: 'value' };
    createComponent();
    fixture.detectChanges();
    
    expect(authSpy.handleOAuthCallback).toHaveBeenCalledWith('some_param=value');
  });

  it('should handle missing fragment and missing queryParams', () => {
    activatedRouteStub.fragment = of('');
    activatedRouteStub.snapshot.queryParams = {};
    createComponent();
    fixture.detectChanges();
    
    expect(authSpy.handleOAuthCallback).toHaveBeenCalledWith('');
  });

  it('should navigate to login on goToLogin', () => {
    createComponent();
    component.goToLogin();
    expect(routerSpy.navigate).toHaveBeenCalledWith(['/login']);
  });
});
