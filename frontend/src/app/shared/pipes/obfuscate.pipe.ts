import { Pipe, PipeTransform } from '@angular/core';

/**
 * Obfuscation pipe for E2EE file names.
 *
 * When the vault is Locked, replaces file names with a lock icon
 * and "Arquivo Encriptado" text. When Unlocked, passes through
 * the original name.
 *
 * Usage: {{ fileName | obfuscate: isLocked() }}
 */
@Pipe({
  name: 'obfuscate',
  pure: true,
})
export class ObfuscatePipe implements PipeTransform {
  transform(value: string, isLocked: boolean): string {
    if (isLocked) {
      const truncated = value.length > 15 ? value.substring(0, 15) + '...' : value;
      return truncated;
    }
    return value;
  }
}
