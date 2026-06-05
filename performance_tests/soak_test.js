import http from 'k6/http';
import { check, sleep } from 'k6';
import { randomBytes } from 'k6/crypto';

export const options = {
    vus: 10, // Moderate traffic
    duration: '4h', // Run for 4 hours to detect memory leaks
};

export function setup() {
    return {
        token: __ENV.JWT_TOKEN || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJleHAiOjE3ODA3NjY4MTAsImlhdCI6MTc4MDY4MDQxMCwidXNlcl9pZCI6IjE4NCJ9.9bAYKSUJzcsY4MstOxZm7AtbpN5FzQYmBPSF2zKYH3A'
    };
}

export default function (data) {
    const baseUrl = 'http://localhost:8080';
    const params = {
        headers: {
            'Authorization': `Bearer ${data.token}`,
            'Content-Type': 'application/json'
        },
    };

    // 1. Init Upload
    const initPayload = JSON.stringify({
        folder_id: null,
        encrypted_name: 'soak_test_file.txt',
        name_hash: 'soak_hash_' + __VU + '_' + __ITER,
        encrypted_fdk: 'soak_fdk_123',
        size_bytes: 1024 * 1024, // 1MB
        total_chunks: 1,
        storage_provider: 'local'
    });

    const resInit = http.post(`${baseUrl}/files`, initPayload, params);
    check(resInit, { 'Init status is 201': (r) => r.status === 201 });

    let fileId;
    try {
        fileId = resInit.json('file_id');
    } catch (e) {
        // If init fails (e.g., bad token), sleep and return to prevent errors
        sleep(1);
        return;
    }

    if (!fileId) return;

    // 2. Upload Chunk
    const chunkParams = {
        headers: {
            'Authorization': `Bearer ${data.token}`,
            'Content-Type': 'application/octet-stream',
            'X-Chunk-Index': '0'
        },
    };
    const chunkPayload = randomBytes(1024 * 1024).buffer; // 1MB
    const resChunk = http.post(`${baseUrl}/files/${fileId}/chunks`, chunkPayload, chunkParams);
    check(resChunk, { 'Chunk status is 200/201': (r) => r.status === 200 || r.status === 201 });

    // 4. Download File (Init Download)
    const resDownload = http.get(`${baseUrl}/files/${fileId}/download`, params);
    check(resDownload, { 'Download status is 200': (r) => r.status === 200 });

    // 5. Delete File (Moves to trash)
    const resDelete = http.del(`${baseUrl}/files/${fileId}`, null, params);
    check(resDelete, { 'Delete status is 200': (r) => r.status === 200 });

    // 6. Empty Trash (Frees quota)
    const resEmpty = http.del(`${baseUrl}/trash/empty`, null, params);
    check(resEmpty, { 'Empty trash status is 200': (r) => r.status === 200 });

    // Sleep to pace the test
    sleep(1);
}
