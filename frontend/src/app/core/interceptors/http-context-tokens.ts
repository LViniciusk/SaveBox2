import { HttpContextToken } from '@angular/common/http';

export const BYPASS_LOGOUT = new HttpContextToken<boolean>(() => false);
