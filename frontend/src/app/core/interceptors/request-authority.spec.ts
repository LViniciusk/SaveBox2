import { isUrlWithinBase } from './request-authority';

describe('isUrlWithinBase', () => {
  const browserOrigin = 'https://app.example.test';

  it('accepts an exact base and descendants with a relative base', () => {
    expect(isUrlWithinBase('/backend', '/backend', browserOrigin)).toBeTrue();
    expect(isUrlWithinBase('/backend/files/1', '/backend', browserOrigin)).toBeTrue();
  });

  it('accepts trailing slash, query, and hash variations', () => {
    expect(isUrlWithinBase('/backend/', '/backend', browserOrigin)).toBeTrue();
    expect(isUrlWithinBase('/backend/files/1?x=1#part', '/backend/', browserOrigin)).toBeTrue();
  });

  it('rejects path-prefix lookalikes', () => {
    expect(isUrlWithinBase('/backend-evil/files', '/backend', browserOrigin)).toBeFalse();
    expect(isUrlWithinBase('/backends/files', '/backend', browserOrigin)).toBeFalse();
  });

  it('requires the exact origin for absolute bases', () => {
    const base = 'https://upload.example.test/backend';
    expect(isUrlWithinBase('https://upload.example.test/backend/files', base, browserOrigin)).toBeTrue();
    expect(isUrlWithinBase('https://upload.example.test.attacker.test/backend/files', base, browserOrigin)).toBeFalse();
    expect(isUrlWithinBase('https://evil.test/backend/files', base, browserOrigin)).toBeFalse();
    expect(isUrlWithinBase('http://upload.example.test/backend/files', base, browserOrigin)).toBeFalse();
    expect(isUrlWithinBase('https://upload.example.test:8443/backend/files', base, browserOrigin)).toBeFalse();
  });

  it('fails closed for malformed URLs', () => {
    expect(isUrlWithinBase('://not-a-url', '/backend', browserOrigin)).toBeFalse();
  });
});
