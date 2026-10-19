/** Plaintext capacity of one encrypted Kasumi chunk. */
export const KASUMI_CHUNK_SIZE = 4 * 1024 * 1024;

/** Fixed KAS2 bytes before the metadata ciphertext: base header, marker, size and MAC. */
export const KASUMI_KAS2_METADATA_PREFIX_SIZE = 56;

/** Maximum KAS2 metadata ciphertext that fits the existing 2 MiB header fetch boundary. */
export const KASUMI_MAX_METADATA_SIZE = 2 * 1024 * 1024 - KASUMI_KAS2_METADATA_PREFIX_SIZE;
