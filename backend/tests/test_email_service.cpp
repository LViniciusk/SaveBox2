#include <catch2/catch_test_macros.hpp>
#include "Services/EmailService.hpp"

#include <cpr/cpr.h>
#include <string>

class MockEmailServiceUnit : public EmailService {
public:
    MockEmailServiceUnit()
        : EmailService("Eu_amo_senti-la_na_pele", "eu_amo_senti-la_na_pele") {}

    mutable cpr::Response post_response;
    mutable cpr::Response get_response;

protected:
    cpr::Response make_post_request(const std::string&,
                                    const cpr::Header&,
                                    const cpr::Body&) const override {
        return post_response;
    }

    cpr::Response make_get_request(const std::string&) const override {
        return get_response;
    }
};

TEST_CASE("EmailService - Envio e Validacao sem HTTP real", "[email][service]") {
    MockEmailServiceUnit service;

    SECTION("Disparo de E-mail - Sucesso (HTTP 200)") {
        service.post_response = cpr::Response{};
        service.post_response.error = cpr::Error{};
        service.post_response.error.code = cpr::ErrorCode::OK;
        service.post_response.status_code = 200;

        REQUIRE(service.send_verification_email("user@test.com", "token123") == true);
    }

    SECTION("Disparo de E-mail - Falha de API (HTTP 401)") {
        service.post_response = cpr::Response{};
        service.post_response.error = cpr::Error{};
        service.post_response.error.code = cpr::ErrorCode::OK;
        service.post_response.status_code = 401;
        service.post_response.text = "unauthorized";

        REQUIRE(service.send_verification_email("user@test.com", "token123") == false);
    }

    SECTION("Disparo de E-mail - Falha de API (HTTP 500)") {
        service.post_response = cpr::Response{};
        service.post_response.error = cpr::Error{};
        service.post_response.error.code = cpr::ErrorCode::OK;
        service.post_response.status_code = 500;
        service.post_response.text = "server error";

        REQUIRE(service.send_verification_email("user@test.com", "token123") == false);
    }

    SECTION("Validacao de Dominio - Dominio valido") {
        service.get_response = cpr::Response{};
        service.get_response.error = cpr::Error{};
        service.get_response.error.code = cpr::ErrorCode::OK;
        service.get_response.status_code = 200;
        service.get_response.text = R"({
            "email_deliverability": {"status": "deliverable", "is_smtp_valid": true, "is_mx_valid": true},
            "email_quality": {"score": 0.95, "is_disposable": false},
            "email_risk": {"address_risk_status": "low"}
        })";

        REQUIRE(service.is_domain_valid_via_api("gmail.com") == true);
    }

    SECTION("Validacao de Dominio - Dominio descartavel") {
        service.get_response = cpr::Response{};
        service.get_response.error = cpr::Error{};
        service.get_response.error.code = cpr::ErrorCode::OK;
        service.get_response.status_code = 200;
        service.get_response.text = R"({
            "email_deliverability": {"status": "undeliverable", "is_smtp_valid": false, "is_mx_valid": false},
            "email_quality": {"score": 0.0, "is_disposable": false},
            "email_risk": {"address_risk_status": "high"}
        })";

        REQUIRE(service.is_domain_valid_via_api("mailinator.com") == false);
    }

    SECTION("Validacao de Dominio - Falha de rede (fail-open por status 500)") {
        service.get_response = cpr::Response{};
        service.get_response.error = cpr::Error{};
        service.get_response.error.code = cpr::ErrorCode::OK;
        service.get_response.status_code = 500;

        REQUIRE(service.is_domain_valid_via_api("gmail.com") == true);
    }

    SECTION("Validacao de Dominio - Falha de rede (fail-open por timeout/status 0)") {
        service.get_response = cpr::Response{};
        service.get_response.error = cpr::Error{};
        service.get_response.error.code = cpr::ErrorCode::OK;
        service.get_response.status_code = 0;

        REQUIRE(service.is_domain_valid_via_api("gmail.com") == true);
    }

    SECTION("Validacao de Dominio - JSON malformado (fail-open)") {
        service.get_response = cpr::Response{};
        service.get_response.error = cpr::Error{};
        service.get_response.error.code = cpr::ErrorCode::OK;
        service.get_response.status_code = 200;
        service.get_response.text = "isso_nao_e_json";

        REQUIRE(service.is_domain_valid_via_api("gmail.com") == true);
    }
}
