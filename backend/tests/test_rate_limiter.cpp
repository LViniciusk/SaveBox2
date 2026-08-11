#include <catch2/catch_test_macros.hpp>
#include "middlewares/RateLimitMiddleware.hpp"
#include "test_helpers.hpp"
#include "database/DatabasePool.hpp"
#include <string>
#include <vector>

// Helper: simula uma requisição HTTP para o middleware
static crow::response simulate_request(RateLimitMiddleware& mw, const std::string& ip, const std::string& path = "/api/data", const std::string& forwarded_ip = "") {
    crow::request req;
    req.remote_ip_address = ip;
    req.url = path;
    if (!forwarded_ip.empty()) {
        req.add_header("CF-Connecting-IP", forwarded_ip);
        req.add_header("X-Real-IP", forwarded_ip);
    }

    crow::response res;
    RateLimitMiddleware::context ctx;

    mw.before_handle(req, res, ctx);
    return res;
}

namespace {

struct B39BanCleanup {
    DatabasePool& pool;
    std::vector<std::string> ips;

    ~B39BanCleanup() {
        try {
            auto conn = pool.acquire_connection();
            pqxx::work txn(*conn);
            for (const auto& ip : ips) {
                txn.exec("DELETE FROM banned_ips WHERE ip = $1", pqxx::params{ip});
            }
            txn.commit();
        } catch (...) {
        }
    }

    void clear() {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        for (const auto& ip : ips) {
            txn.exec("DELETE FROM banned_ips WHERE ip = $1", pqxx::params{ip});
        }
        txn.commit();
    }
};

int persisted_ban_count(DatabasePool& pool, const std::string& ip) {
    auto conn = pool.acquire_connection();
    pqxx::nontransaction txn(*conn);
    return txn.exec("SELECT COUNT(*) FROM banned_ips WHERE ip = $1", pqxx::params{ip})[0][0].as<int>();
}

} // namespace

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

    SECTION("Proxy confiavel preserva identidades independentes dos clientes") {
        RateLimitMiddleware trusted_mw(true);
        const std::string proxy_ip = "192.168.1.50";
        const std::string cf_ip = "203.0.113.5";
        
        // Simula 5 acessos normais vindos do mesmo IP do Cloudflare
        for (int i = 0; i < 5; ++i) {
            crow::response res = simulate_request(trusted_mw, proxy_ip, "/login", cf_ip);
            REQUIRE(res.code == 200);
        }
        
        // O 6o acesso do mesmo IP do Cloudflare deve ser bloqueado
        crow::response res = simulate_request(trusted_mw, proxy_ip, "/login", cf_ip);
        REQUIRE(res.code == 429);
        
        // Um novo IP vindo do mesmo Proxy não deve ser bloqueado
        const std::string new_cf_ip = "203.0.113.6";
        crow::response res_new = simulate_request(trusted_mw, proxy_ip, "/login", new_cf_ip);
        REQUIRE(res_new.code == 200);
    }
}

TEST_CASE("B.36 untrusted peers cannot rotate rate-limit identity with forwarded headers", "[rate_limiter][b36]") {
    RateLimitMiddleware mw;
    const std::string peer = "198.51.100.10";

    for (int i = 0; i < 5; ++i) {
        REQUIRE(simulate_request(mw, peer, "/login", "203.0.113." + std::to_string(i + 1)).code == 200);
    }

    REQUIRE(simulate_request(mw, peer, "/login", "203.0.113.6").code == 429);
}

TEST_CASE("B.36 trusted proxy preserves separate client buckets", "[rate_limiter][b36]") {
    RateLimitMiddleware mw(true);
    const std::string proxy = "192.0.2.10";

    for (int i = 0; i < 5; ++i) {
        REQUIRE(simulate_request(mw, proxy, "/login", "203.0.113.10").code == 200);
    }
    REQUIRE(simulate_request(mw, proxy, "/login", "203.0.113.10").code == 429);
    REQUIRE(simulate_request(mw, proxy, "/login", "203.0.113.11").code == 200);
}

TEST_CASE("B.36 forged forwarded identity cannot consume a victim bucket", "[rate_limiter][b36]") {
    RateLimitMiddleware mw;
    const std::string victim = "203.0.113.77";

    for (int i = 0; i < 5; ++i) {
        REQUIRE(simulate_request(mw, "198.51.100.20", "/login", victim).code == 200);
    }

    REQUIRE(simulate_request(mw, victim, "/login").code == 200);
}

TEST_CASE("B.36 malformed forwarded identities cannot create arbitrary buckets", "[rate_limiter][b36]") {
    RateLimitMiddleware mw(true);
    const std::string peer = "198.51.100.40";
    const std::vector<std::string> malformed{
        "", " ", "not-an-ip", "999.999.999.999", "1.2.3.4, 5.6.7.8", std::string(256, 'x')
    };

    for (size_t i = 0; i < malformed.size(); ++i) {
        const int expected = i < 5 ? 200 : 429;
        REQUIRE(simulate_request(mw, peer, "/login", malformed[i]).code == expected);
    }
}

TEST_CASE("B.39 ban transition persists and survives middleware restart", "[rate_limiter][b39]") {
    const std::string ip = "198.51.100.239";
    DatabasePool pool(2, get_secure_conn_string());
    B39BanCleanup cleanup{pool, {ip}};
    cleanup.clear();

    RateLimitMiddleware first;
    first.init(pool);

    for (int attempt = 1; attempt <= 15; ++attempt) {
        const auto response = simulate_request(first, ip, "/login");
        if (attempt <= 5) {
            CHECK(response.code == 200);
        } else if (attempt < 15) {
            CHECK(response.code == 429);
        } else {
            CHECK(response.code == 403);
        }
    }

    const int row_count = persisted_ban_count(pool, ip);
    CHECK(row_count == 1);

    if (row_count == 1) {
        auto conn = pool.acquire_connection();
        pqxx::nontransaction txn(*conn);
        const auto row = txn.exec(
            "SELECT COUNT(*) FROM banned_ips "
            "WHERE ip = $1 "
            "AND expires_at > NOW() + INTERVAL '23 hours 59 minutes' "
            "AND expires_at < NOW() + INTERVAL '24 hours 1 minute' "
            "AND reason = 'Força bruta em autenticação'",
            pqxx::params{ip});
        CHECK(row[0][0].as<int>() == 1);
    }

    RateLimitMiddleware restarted;
    restarted.init(pool);
    CHECK(simulate_request(restarted, ip).code == 403);
    CHECK(simulate_request(restarted, "198.51.100.240").code == 200);
}

TEST_CASE("B.39 ban local falha fechado sem pool", "[rate_limiter][b39]") {
    RateLimitMiddleware middleware;
    const std::string ip = "198.51.100.240";

    for (int attempt = 1; attempt <= 15; ++attempt) {
        const auto response = simulate_request(middleware, ip, "/login");
        if (attempt <= 5) {
            CHECK(response.code == 200);
        } else if (attempt < 15) {
            CHECK(response.code == 429);
        } else {
            CHECK(response.code == 403);
        }
    }

    CHECK(simulate_request(middleware, ip, "/api/data").code == 403);
}

TEST_CASE("B.39 init carrega bans ativos e ignora bans expirados", "[rate_limiter][b39]") {
    const std::string active_ip = "203.0.113.239";
    const std::string expired_ip = "203.0.113.240";
    DatabasePool pool(2, get_secure_conn_string());
    B39BanCleanup cleanup{pool, {active_ip, expired_ip}};
    cleanup.clear();

    {
        auto conn = pool.acquire_connection();
        pqxx::work txn(*conn);
        txn.exec(
            "INSERT INTO banned_ips(ip, expires_at, reason) "
            "VALUES($1, NOW() + INTERVAL '24 hours', 'B39 active')",
            pqxx::params{active_ip});
        txn.exec(
            "INSERT INTO banned_ips(ip, expires_at, reason) "
            "VALUES($1, NOW() - INTERVAL '1 hour', 'B39 expired')",
            pqxx::params{expired_ip});
        txn.commit();
    }

    RateLimitMiddleware middleware;
    middleware.init(pool);
    CHECK(simulate_request(middleware, active_ip).code == 403);
    CHECK(simulate_request(middleware, expired_ip).code == 200);
}

TEST_CASE("B.82 Google login compartilha o bucket estrito de autenticacao", "[rate_limiter][b82]") {
    RateLimitMiddleware middleware;
    const std::string ip = "198.51.100.182";

    for (int attempt = 1; attempt <= 5; ++attempt) {
        CHECK(simulate_request(middleware, ip, "/api/auth/google").code == 200);
    }
    CHECK(simulate_request(middleware, ip, "/api/auth/google").code == 429);
}

TEST_CASE("B.82 rotas de credencial compartilham um unico contador", "[rate_limiter][b82]") {
    RateLimitMiddleware middleware;
    const std::string ip = "198.51.100.183";

    CHECK(simulate_request(middleware, ip, "/login").code == 200);
    CHECK(simulate_request(middleware, ip, "/register").code == 200);
    CHECK(simulate_request(middleware, ip, "/verify?token=test").code == 200);
    CHECK(simulate_request(middleware, ip, "/api/auth/google").code == 200);
    CHECK(simulate_request(middleware, ip, "/login").code == 200);
    CHECK(simulate_request(middleware, ip, "/api/auth/google").code == 429);
}

TEST_CASE("B.82 refresh possui bucket limitado e isolado do bucket de credencial", "[rate_limiter][b82]") {
    RateLimitMiddleware middleware;
    const std::string ip = "198.51.100.184";

    for (int attempt = 1; attempt <= 60; ++attempt) {
        CHECK(simulate_request(middleware, ip, "/api/auth/refresh").code == 200);
    }
    CHECK(simulate_request(middleware, ip, "/api/auth/refresh").code == 429);
    CHECK(simulate_request(middleware, ip, "/login").code == 200);
    CHECK(simulate_request(middleware, ip, "/api/data").code == 200);
}

TEST_CASE("B.82 classificacao remove query, ignora OPTIONS e rejeita lookalikes", "[rate_limiter][b82]") {
    RateLimitMiddleware middleware;
    const std::string ip = "198.51.100.185";

    for (int attempt = 0; attempt < 6; ++attempt) {
        CHECK(simulate_request(middleware, ip, "/api/auth/google?attempt=" + std::to_string(attempt)).code ==
              (attempt < 5 ? 200 : 429));
    }

    RateLimitMiddleware options_middleware;
    for (int attempt = 0; attempt < 20; ++attempt) {
        crow::request req;
        req.remote_ip_address = "198.51.100.186";
        req.url = "/api/auth/google";
        req.method = crow::HTTPMethod::Options;
        crow::response res;
        RateLimitMiddleware::context ctx;
        options_middleware.before_handle(req, res, ctx);
        CHECK(res.code == 200);
    }
    CHECK(simulate_request(options_middleware, "198.51.100.186", "/api/auth/google").code == 200);

    RateLimitMiddleware lookalike_middleware;
    const std::string lookalike_ip = "198.51.100.187";
    for (int attempt = 0; attempt < 6; ++attempt) {
        CHECK(simulate_request(lookalike_middleware, lookalike_ip,
                               attempt % 2 == 0 ? "/api/auth/google-evil" : "/login-extra").code == 200);
    }
}

TEST_CASE("B.82 Google login aplica a mesma transicao de ban persistente", "[rate_limiter][b82][b39]") {
    const std::string ip = "198.51.100.188";
    DatabasePool pool(2, get_secure_conn_string());
    B39BanCleanup cleanup{pool, {ip}};
    cleanup.clear();

    RateLimitMiddleware first;
    first.init(pool);
    for (int attempt = 1; attempt <= 15; ++attempt) {
        const auto response = simulate_request(first, ip, "/api/auth/google");
        if (attempt <= 5) {
            CHECK(response.code == 200);
        } else if (attempt < 15) {
            CHECK(response.code == 429);
        } else {
            CHECK(response.code == 403);
        }
    }

    CHECK(persisted_ban_count(pool, ip) == 1);

    RateLimitMiddleware restarted;
    restarted.init(pool);
    CHECK(simulate_request(restarted, ip, "/api/auth/google").code == 403);
}
