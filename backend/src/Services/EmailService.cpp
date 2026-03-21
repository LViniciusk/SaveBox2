#include "services/EmailService.hpp"

#include <cpr/cpr.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <cctype>
#include <cstdlib>
#include <iostream>

namespace {

    bool json_bool_value(const nlohmann::json& j, const std::string& key) {
        if (!j.contains(key)) {
            return false;
        }

        const auto& node = j.at(key);
        if (node.is_boolean()) {
            return node.get<bool>();
        }

        if (node.is_object() && node.contains("value") && node.at("value").is_boolean()) {
            return node.at("value").get<bool>();
        }

        return false;
    }

    double json_double_value(const nlohmann::json& j, const std::string& key, double default_value) {
        if (!j.contains(key)) {
            return default_value;
        }

        const auto& node = j.at(key);
        if (node.is_number_float() || node.is_number_integer()) {
            return node.get<double>();
        }

        if (node.is_string()) {
            try {
                return std::stod(node.get<std::string>());
            } catch (...) {
                return default_value;
            }
        }

        return default_value;
    }

    std::string to_lower(std::string text) {
        std::transform(text.begin(), text.end(), text.begin(),
                    [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
        return text;
    }

} 

EmailService::EmailService(const std::string& resend_api_key, const std::string& validation_api_key)
    : resend_api_key_(resend_api_key), validation_api_key_(validation_api_key) {}

cpr::Response EmailService::make_post_request(const std::string& url,
                                              const cpr::Header& headers,
                                              const cpr::Body& body) const {
    return cpr::Post(
        cpr::Url{url},
        headers,
        body,
        cpr::Timeout{10000}
    );
}

cpr::Response EmailService::make_get_request(const std::string& url) const {
    return cpr::Get(
        cpr::Url{url},
        cpr::Timeout{8000}
    );
}

bool EmailService::send_verification_email(const std::string& to_email, const std::string& token) const {
    nlohmann::json payload;
    payload["from"] = "SaveBox@verify.lvinik.app";
    payload["to"] = to_email;
    payload["subject"] = "SaveBox - Verifique sua conta";
    payload["html"] = "<p>Para verificar sua conta, clique no link: "
                      "<a href='https://savebox.lvinik.app/verify?token=" + token + "'>"
                      "Verificar conta</a></p>";

    auto response = make_post_request(
        "https://api.resend.com/emails",
        cpr::Header{{"Authorization", "Bearer " + resend_api_key_},
                    {"Content-Type", "application/json"}},
        cpr::Body{payload.dump()}
    );

    if (response.error.code != cpr::ErrorCode::OK) {
        std::cerr << "[EmailService] Falha HTTP ao enviar e-mail: " << response.error.message << "\n";
        return false;
    }

    if (response.status_code == 200 || response.status_code == 201) {
        return true;
    }

    std::cerr << "[EmailService] Falha no envio via Resend. Status="
              << response.status_code << " Body=" << response.text << "\n";
    return false;
}

bool EmailService::is_domain_valid_via_api(const std::string& domain) const {
    if (domain.empty()) {
        return false;
    }

    const bool has_at = domain.find('@') != std::string::npos;
    const std::string email_to_check = has_at ? domain : ("test@" + domain);

    const std::string url =
        "https://emailreputation.abstractapi.com/v1/?api_key=" + validation_api_key_ +
        "&email=" + email_to_check;

    auto response = make_get_request(url);

    // Resiliencia: em falha de rede/timeout/5xx, nao bloqueia cadastro.
    if (response.error.code != cpr::ErrorCode::OK || response.status_code >= 500 || response.status_code == 0) {
        return true;
    }

    if (response.status_code < 200 || response.status_code >= 300) {
        return true;
    }

    nlohmann::json body = nlohmann::json::parse(response.text, nullptr, false);
    if (body.is_discarded()) {
        return true;
    }

    if (body.contains("email_quality") && body.at("email_quality").is_object()) {
        const auto& quality = body.at("email_quality");

        if (json_bool_value(quality, "is_disposable")) {
            return false;
        }

        const double score = json_double_value(quality, "score", 1.0);
        if (score >= 0.0 && score < 0.2) {
            return false;
        }
    }

    if (body.contains("email_deliverability") && body.at("email_deliverability").is_object()) {
        const auto& deliverability = body.at("email_deliverability");

        if (deliverability.contains("status") && deliverability.at("status").is_string()) {
            const std::string status = to_lower(deliverability.at("status").get<std::string>());
            if (status == "undeliverable") {
                return false;
            }
        }

        if (deliverability.contains("is_smtp_valid") && deliverability.at("is_smtp_valid").is_boolean() &&
            !deliverability.at("is_smtp_valid").get<bool>()) {
            return false;
        }

        if (deliverability.contains("is_mx_valid") && deliverability.at("is_mx_valid").is_boolean() &&
            !deliverability.at("is_mx_valid").get<bool>()) {
            return false;
        }
    }

    if (body.contains("email_risk") && body.at("email_risk").is_object()) {
        const auto& risk = body.at("email_risk");

        if (risk.contains("address_risk_status") && risk.at("address_risk_status").is_string()) {
            const std::string address_risk = to_lower(risk.at("address_risk_status").get<std::string>());
            if (address_risk == "high") {
                return false;
            }
        }
    }

    return true;
}
