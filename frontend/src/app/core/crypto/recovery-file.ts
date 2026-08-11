export function buildSecurityPhraseRecoveryText(phrase: string): string {
  return [
    '=== NANIKA RECOVERY ===',
    '',
    'Guarde esta frase em um local seguro, preferencialmente offline.',
    '',
    `Sua Frase de Segurança: ${phrase}`,
    '',
    'Aviso: o Nanika usa arquitetura Zero-Knowledge.',
    'O Nanika não consegue recuperar esta frase caso ela seja perdida.',
  ].join('\r\n');
}

export function downloadSecurityPhraseRecoveryFile(phrase: string): void {
  const blob = new Blob([buildSecurityPhraseRecoveryText(phrase)], {
    type: 'text/plain;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'nanika-recovery.txt';
  try {
    document.body.appendChild(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    URL.revokeObjectURL(url);
  }
}
