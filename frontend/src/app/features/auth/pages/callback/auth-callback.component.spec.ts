import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { AuthCallbackComponent } from './auth-callback.component';
import { AuthService } from '../../../../core/auth/auth.service';
import { ActivatedRoute, Router } from '@angular/router';
import { signal } from '@angular/core';

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
      snapshot: { queryParams: {}, fragment: null }
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

  it('links Google Drive exclusively when code and state are present', () => {
    activatedRouteStub.snapshot = {
      queryParams: { code: '123', state: 'abc' },
      fragment: null,
    };
    createComponent();
    component.ngOnInit();

    expect(authSpy.linkGoogleDrive).toHaveBeenCalledWith('123', 'abc');
    expect(authSpy.linkGoogleDrive).toHaveBeenCalledTimes(1);
    expect(authSpy.handleOAuthCallback).not.toHaveBeenCalled();
  });

  it('handles the Google login fragment when no link code exists', () => {
    activatedRouteStub.snapshot = {
      queryParams: {},
      fragment: 'id_token=jwt123&state=nonce123',
    };
    createComponent();
    component.ngOnInit();

    expect(authSpy.handleOAuthCallback).toHaveBeenCalledWith('id_token=jwt123&state=nonce123');
    expect(authSpy.handleOAuthCallback).toHaveBeenCalledTimes(1);
    expect(authSpy.linkGoogleDrive).not.toHaveBeenCalled();
  });

  it('fails safely with an empty callback when no callback data exists', () => {
    activatedRouteStub.snapshot = { queryParams: {}, fragment: null };
    createComponent();
    component.ngOnInit();

    expect(authSpy.handleOAuthCallback).toHaveBeenCalledWith('');
    expect(authSpy.handleOAuthCallback).toHaveBeenCalledTimes(1);
    expect(authSpy.linkGoogleDrive).not.toHaveBeenCalled();
  });

  it('does not convert arbitrary query parameters into an OAuth fragment', () => {
    activatedRouteStub.snapshot = {
      queryParams: { foo: 'bar' },
      fragment: null,
    };
    createComponent();
    component.ngOnInit();

    expect(authSpy.handleOAuthCallback).toHaveBeenCalledWith('');
    expect(authSpy.linkGoogleDrive).not.toHaveBeenCalled();
  });

  it('gives code and state precedence over a simultaneous login fragment', () => {
    activatedRouteStub.snapshot = {
      queryParams: { code: 'x', state: 'y' },
      fragment: 'id_token=z&state=w',
    };
    createComponent();
    component.ngOnInit();

    expect(authSpy.linkGoogleDrive).toHaveBeenCalledWith('x', 'y');
    expect(authSpy.handleOAuthCallback).not.toHaveBeenCalled();
  });

  it('returns safely to Drive when Google rejects Drive linking', () => {
    activatedRouteStub.snapshot = {
      queryParams: { error: 'access_denied', state: 'drive-state' },
      fragment: null,
    };
    createComponent();
    component.ngOnInit();

    expect(authSpy.linkGoogleDrive).not.toHaveBeenCalled();
    expect(authSpy.handleOAuthCallback).not.toHaveBeenCalled();
    expect(routerSpy.navigate).toHaveBeenCalledWith(['/drive/home'], { replaceUrl: true });
  });

  it('returns safely to Drive for any provider error with state', () => {
    activatedRouteStub.snapshot = {
      queryParams: { error: 'temporarily_unavailable', state: 'drive-state' },
      fragment: null,
    };
    createComponent();
    component.ngOnInit();

    expect(authSpy.linkGoogleDrive).not.toHaveBeenCalled();
    expect(authSpy.handleOAuthCallback).not.toHaveBeenCalled();
    expect(routerSpy.navigate).toHaveBeenCalledWith(['/drive/home'], { replaceUrl: true });
  });

  it('fails closed when provider error and code are both present', () => {
    activatedRouteStub.snapshot = {
      queryParams: { code: 'unused', error: 'access_denied', state: 'drive-state' },
      fragment: null,
    };
    createComponent();
    component.ngOnInit();

    expect(authSpy.linkGoogleDrive).not.toHaveBeenCalled();
    expect(authSpy.handleOAuthCallback).not.toHaveBeenCalled();
    expect(routerSpy.navigate).toHaveBeenCalledWith(['/drive/home'], { replaceUrl: true });
  });

  it('does not treat a provider error without state as Drive linking', () => {
    activatedRouteStub.snapshot = {
      queryParams: { error: 'access_denied' },
      fragment: null,
    };
    createComponent();
    component.ngOnInit();

    expect(authSpy.linkGoogleDrive).not.toHaveBeenCalled();
    expect(authSpy.handleOAuthCallback).toHaveBeenCalledWith('');
    expect(routerSpy.navigate).not.toHaveBeenCalled();
  });

  it('keeps login errors in the fragment login flow', () => {
    activatedRouteStub.snapshot = {
      queryParams: {},
      fragment: 'error=access_denied&state=nonce',
    };
    createComponent();
    component.ngOnInit();

    expect(authSpy.handleOAuthCallback).toHaveBeenCalledWith('error=access_denied&state=nonce');
    expect(authSpy.linkGoogleDrive).not.toHaveBeenCalled();
  });

  it('should navigate to login on goToLogin', () => {
    createComponent();
    component.goToLogin();
    expect(routerSpy.navigate).toHaveBeenCalledWith(['/login']);
  });
});
