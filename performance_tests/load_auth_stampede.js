import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
    scenarios: {
        stampede: {
            executor: 'per-vu-iterations',
            vus: 500, // 500 Virtual Users
            iterations: 1, // 1 request per VU
            maxDuration: '5s',
        },
    },
};

export default function () {
    const url = 'http://localhost:8080/api/auth/google';
    
    // Simulate a mocked Google JWT (usually fails verification unless mocked in backend,
    // but the goal is to hit the server logic and JWKS lock).
    const payload = JSON.stringify({
        id_token: 'mock.jwt.token',
        nonce: 'k6_nonce_123'
    });

    const params = {
        headers: {
            'Content-Type': 'application/json',
        },
    };

    const res = http.post(url, payload, params);

    // It might return 400 or 500 depending on mock, but we check for timeouts or TCP drops.
    // Ideally it returns something consistently without dropping connections.
    check(res, {
        'status is not 0 (no drop)': (r) => r.status !== 0,
        'response time < 2000ms': (r) => r.timings.duration < 2000,
    });
}
