"""Pipe synthetic DPAPI keys to the owned Node child in RAM; never write plaintext."""
import json
from pathlib import Path
import sys
from ap06_authorities import validate_owned_destination, sha256
from ap06_key_custody import unprotect


def read_keys(config):
    root = validate_owned_destination(Path(config['AP06_AUTHORITY_ROOT']),config['identity'],campaign='AP-06-R10')
    context = json.loads((root/'keys/custody.json').read_text())
    if context['identity'] != config['identity'] or context['manifestSha256'] != sha256(root/'manifests/corpus.json'):
        raise ValueError('R11_KEY_BINDING_INVALID')
    return unprotect((root/'keys/fdks.dpapi').read_bytes(),context)


if __name__ == '__main__':
    sys.stdout.buffer.write(read_keys(json.loads(Path(sys.argv[1]).read_text())))
