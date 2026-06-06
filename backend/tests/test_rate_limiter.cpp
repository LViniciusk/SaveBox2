#include <catch2/catch_test_macros.hpp>
#include "middlewares/RateLimitMiddleware.hpp"
#include <string>

// Helper: simula uma requisição HTTP para o middleware
static crow::response simulate_request(RateLimitMiddleware& mw, const std::string& ip, const std::string& path = "/api/data", const std::string& spoofed_ip = "") {
    crow::request req;
    req.remote_ip_address = ip;
    req.url = path;
    if (!spoofed_ip.empty()) {
        req.add_header("CF-Connecting-IP", spoofed_ip);
    }

    crow::response res;
    RateLimitMiddleware::context ctx;

    mw.before_handle(req, res, ctx);
    return res;
}

TEST_CASE("Rate Limiter - Prevenção de Reverse DoS (Eviction Segura)", "[rate_limiter]") {

    RateLimitMiddleware mw;

    SECTION("IP que excede o limite recebe 429 e NÃO é perdoado após eviction") {
        const std::string attacker_ip = "10.0.0.1";

        for (int i = 0; i < 5001; ++i) {
            simulate_request(mw, attacker_ip);
        }

        {
            crow::response res = simulate_request(mw, attacker_ip);
            REQUIRE(res.code == 429);
        }


        for (int i = 0; i < 10001; ++i) {
            simulate_request(mw, "spoof_" + std::to_string(i));
        }

        {
            crow::response res = simulate_request(mw, attacker_ip);
            REQUIRE(res.code == 429);
        }
    }

    SECTION("Sob DDoS real (mapa cheio de infratores com contagens elevadas), novos IPs são rejeitados") {
        for (int i = 0; i < 10001; ++i) {
            for (int j = 0; j < 5; ++j) {
                simulate_request(mw, "ddos_" + std::to_string(i));
            }
        }

        crow::response res = simulate_request(mw, "new_victim_ip");
        REQUIRE((res.code == 429 || res.code == 503));
    }

    SECTION("Rate limit básico continua funcionando (sem regressão)") {
        const std::string normal_ip = "192.168.1.100";

        for (int i = 0; i < 5000; ++i) {
            crow::response res = simulate_request(mw, normal_ip);
            REQUIRE(res.code == 200); 
        }

        crow::response res = simulate_request(mw, normal_ip);
        REQUIRE(res.code == 429);
    }

    SECTION("Rate limit em rotas de autenticação é mais restritivo") {
        const std::string brute_ip = "172.16.0.50";

        for (int i = 0; i < 5; ++i) {
            crow::response res = simulate_request(mw, brute_ip, "/login");
            REQUIRE(res.code == 200);
        }

        crow::response res = simulate_request(mw, brute_ip, "/login");
        REQUIRE(res.code == 429);
    }

    SECTION("Self-DoS Prevention: Tentativas falhadas no Login não bloqueiam a API geral") {
        const std::string isolate_ip = "172.16.0.99";

        for (int i = 0; i < 6; ++i) {
            simulate_request(mw, isolate_ip, "/login");
        }
        
        crow::response res_login = simulate_request(mw, isolate_ip, "/login");
        REQUIRE(res_login.code == 429);

        crow::response res_api = simulate_request(mw, isolate_ip, "/api/data");
        REQUIRE(res_api.code == 200);
    }

    SECTION("Compatibilidade Cloudflare via CF-Connecting-IP") {
        const std::string proxy_ip = "192.168.1.50";
        const std::string cf_ip = "203.0.113.5";
        
        // Simula 5 acessos normais vindos do mesmo IP do Cloudflare
        for (int i = 0; i < 5; ++i) {
            crow::response res = simulate_request(mw, proxy_ip, "/login", cf_ip);
            REQUIRE(res.code == 200);
        }
        
        // O 6o acesso do mesmo IP do Cloudflare deve ser bloqueado
        crow::response res = simulate_request(mw, proxy_ip, "/login", cf_ip);
        REQUIRE(res.code == 429);
        
        // Um novo IP vindo do mesmo Proxy não deve ser bloqueado
        const std::string new_cf_ip = "203.0.113.6";
        crow::response res_new = simulate_request(mw, proxy_ip, "/login", new_cf_ip);
        REQUIRE(res_new.code == 200);
    }
}
