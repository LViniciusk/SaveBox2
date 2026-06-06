import http from 'k6/http';
import { check } from 'k6';
import { randomBytes } from 'k6/crypto';

export const options = {
    vus: 50, // 50 Virtual Users
    duration: '30s', // Continually upload for 30 seconds
};

export function setup() {
    // Note: To run this test, you must pass a valid JWT token via environment variable
    // Example: k6 run -e JWT_TOKEN="your.jwt.token" load_upload_chunks.js
    // Also, you must provide a valid file_id that has been initialized.
    // Example: k6 run -e JWT_TOKEN="..." -e FILE_ID="1" load_upload_chunks.js

    
    return {
        token: __ENV.JWT_TOKEN || 'token',
        fileId: __ENV.FILE_ID || '1'
    };
}

export default function (data) {
    const url = `http://localhost:8080/files/${data.fileId}/chunks`;
    
    // Generate a 4MB random binary payload
    const payload = randomBytes(4 * 1024 * 1024).buffer;

    const params = {
        headers: {
            'Authorization': `Bearer ${data.token}`,
            'Content-Type': 'application/octet-stream',
            'X-Chunk-Index': __VU.toString() // Use VU id to simulate different chunk indexes
        },
    };

    const res = http.post(url, payload, params);

    check(res, {
        'status is 200 or 201': (r) => r.status === 200 || r.status === 201,
        'response time < 3000ms': (r) => r.timings.duration < 3000,
    });
}
