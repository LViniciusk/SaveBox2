import {
  buildSecurityPhraseRecoveryText,
  downloadSecurityPhraseRecoveryFile,
} from './recovery-file';

describe('security phrase recovery file', () => {
  it('contains only the security phrase contract', () => {
    const text = buildSecurityPhraseRecoveryText('nova frase segura');

    expect(text).toContain('NANIKA RECOVERY');
    expect(text).toContain('nova frase segura');
    expect(text).toContain('Zero-Knowledge');
    expect(text).not.toContain('Vault Key');
    expect(text).not.toContain('Master Key');
    expect(text).not.toContain('FDK');
    expect(text).not.toContain('JWT');
    expect(text).not.toContain('Google token');
  });

  it('downloads and always revokes the object URL', () => {
    const anchor = document.createElement('a');
    spyOn(document, 'createElement').and.returnValue(anchor);
    spyOn(URL, 'createObjectURL').and.returnValue('blob:recovery');
    const click = spyOn(anchor, 'click');
    const remove = spyOn(anchor, 'remove');
    const revoke = spyOn(URL, 'revokeObjectURL');

    downloadSecurityPhraseRecoveryFile('frase');

    expect(click).toHaveBeenCalled();
    expect(anchor.download).toBe('nanika-recovery.txt');
    expect(remove).toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledWith('blob:recovery');
  });

  it('revokes the URL when clicking fails', () => {
    const anchor = document.createElement('a');
    spyOn(document, 'createElement').and.returnValue(anchor);
    spyOn(URL, 'createObjectURL').and.returnValue('blob:recovery');
    spyOn(anchor, 'click').and.throwError('blocked');
    spyOn(anchor, 'remove');
    const revoke = spyOn(URL, 'revokeObjectURL');

    expect(() => downloadSecurityPhraseRecoveryFile('frase')).toThrowError('blocked');
    expect(revoke).toHaveBeenCalledWith('blob:recovery');
  });
});
