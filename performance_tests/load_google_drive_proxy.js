import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
    vus: 200, // 200 Virtual Users
    duration: '1m', // 1 minute
};

export function setup() {
    return {
        token: __ENV.JWT_TOKEN || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJleHAiOjE3ODA3NjY4MTAsImlhdCI6MTc4MDY4MDQxMCwidXNlcl9pZCI6IjE4NCJ9.9bAYKSUJzcsY4MstOxZm7AtbpN5FzQYmBPSF2zKYH3A'
    };
}

export default function (data) {
    const tokenUrl = 'http://localhost:8080/api/storage/google/token';
    const initUrl = 'http://localhost:8080/files';
    
    const params = {
        headers: {
            'Authorization': `Bearer ${data.token}`,
            'Content-Type': 'application/json'
        },
    };

    // 1. Request Token
    const resToken = http.get(tokenUrl, params);
    
    // We check that it completes quickly, even if it returns 404 (Not linked).
    // The goal is to stress the backend routing and DB reads.
    check(resToken, {
        'token response time < 500ms': (r) => r.timings.duration < 500,
    });

    // 2. Init Upload (Google Drive)
    const initPayload = JSON.stringify({
        folder_id: null,
        encrypted_name: 'test_perf_drive.txt',
        name_hash: 'hash_perf_' + __VU + '_' + __ITER,
        encrypted_fdk: 'fdk_perf_123',
        size_bytes: 1048576, // 1MB
        storage_provider: 'google_drive'
    });

    const resInit = http.post(initUrl, initPayload, params);

    check(resInit, {
        'init response time < 1000ms': (r) => r.timings.duration < 1000,
    });
    
    sleep(0.1);
}
