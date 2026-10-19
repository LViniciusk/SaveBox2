#include "Services/EmailService.hpp"

#include <cpr/cpr.h>
#include <nlohmann/json.hpp>

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdlib>
#include <iostream>
#include <iomanip>
#include <optional>
#include <sstream>

namespace {

    std::optional<bool> json_bool_value(const nlohmann::json& j, const std::string& key) {
        if (!j.contains(key)) {
            return std::nullopt;
        }

        const auto& node = j.at(key);
        if (node.is_boolean()) {
            return node.get<bool>();
        }

        if (node.is_object() && node.contains("value") && node.at("value").is_boolean()) {
            return node.at("value").get<bool>();
        }

        return std::nullopt;
    }

    std::optional<double> json_double_value(const nlohmann::json& j, const std::string& key) {
        if (!j.contains(key)) {
            return std::nullopt;
        }

        const auto& node = j.at(key);
        if (node.is_number()) {
            const double value = node.get<double>();
            return std::isfinite(value) ? std::optional<double>{value} : std::nullopt;
        }

        if (node.is_string()) {
            try {
                const std::string text = node.get<std::string>();
                std::size_t consumed = 0;
                const double value = std::stod(text, &consumed);
                if (consumed == text.size() && std::isfinite(value)) {
                    return value;
                }
            } catch (...) {
            }
        }

        return std::nullopt;
    }

    std::string to_lower(std::string text) {
        std::transform(text.begin(), text.end(), text.begin(),
                    [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
        return text;
    }

    std::string url_encode(const std::string& value) {
        std::ostringstream escaped;
        escaped.fill('0');
        escaped << std::hex;

        for (char c : value) {
            if (std::isalnum(static_cast<unsigned char>(c)) || c == '-' || c == '_' || c == '.' || c == '~') {
                escaped << c;
            } else {
                escaped << std::uppercase;
                escaped << '%' << std::setw(2) << int(static_cast<unsigned char>(c));
                escaped << std::nouppercase;
            }
        }
        return escaped.str();
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
    payload["from"] = "Nanika@verify.lvinik.app";
    payload["to"] = to_email;
    payload["subject"] = "Nanika - Verifique sua conta";
    payload["html"] = "<p>Para verificar sua conta, clique no link: "
                      "<a href='https://nanika.lvinik.app/verify?token=" + token + "'>"
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

EmailValidationResult EmailService::validate_email_via_api(const std::string& email) const {
    if (email.empty()) {
        return EmailValidationResult::Rejected;
    }

    if (validation_api_key_.empty()) {
        return EmailValidationResult::Unavailable;
    }

    const std::string url =
        "https://emailreputation.abstractapi.com/v1/?api_key=" + validation_api_key_ +
        "&email=" + url_encode(email);

    cpr::Response response;
    try {
        response = make_get_request(url);
    } catch (...) {
        return EmailValidationResult::Unavailable;
    }

    if (response.error.code != cpr::ErrorCode::OK ||
        response.status_code < 200 || response.status_code >= 300) {
        return EmailValidationResult::Unavailable;
    }

    nlohmann::json body = nlohmann::json::parse(response.text, nullptr, false);
    if (body.is_discarded() || !body.is_object()) {
        return EmailValidationResult::Unavailable;
    }

    bool saw_signal = false;
    bool saw_malformed_signal = false;
    bool explicit_negative = false;

    if (body.contains("email_quality") && body.at("email_quality").is_object()) {
        const auto& quality = body.at("email_quality");

        if (quality.contains("is_disposable")) {
            const auto disposable = json_bool_value(quality, "is_disposable");
            if (!disposable) {
                saw_malformed_signal = true;
            } else {
                saw_signal = true;
                explicit_negative = explicit_negative || *disposable;
            }
        }

        if (quality.contains("score")) {
            const auto score = json_double_value(quality, "score");
            if (!score) {
                saw_malformed_signal = true;
            } else {
                saw_signal = true;
                explicit_negative = explicit_negative || (*score >= 0.0 && *score < 0.2);
            }
        }
    } else if (body.contains("email_quality")) {
        saw_malformed_signal = true;
    }

    if (body.contains("email_deliverability") && body.at("email_deliverability").is_object()) {
        const auto& deliverability = body.at("email_deliverability");

        if (deliverability.contains("status")) {
            if (!deliverability.at("status").is_string()) {
                saw_malformed_signal = true;
            } else {
                saw_signal = true;
                const std::string status = to_lower(deliverability.at("status").get<std::string>());
                explicit_negative = explicit_negative || status == "undeliverable";
            }
        }

        if (deliverability.contains("is_smtp_valid")) {
            const auto smtp_valid = json_bool_value(deliverability, "is_smtp_valid");
            if (!smtp_valid) {
                saw_malformed_signal = true;
            } else {
                saw_signal = true;
                explicit_negative = explicit_negative || !*smtp_valid;
            }
        }

        if (deliverability.contains("is_mx_valid")) {
            const auto mx_valid = json_bool_value(deliverability, "is_mx_valid");
            if (!mx_valid) {
                saw_malformed_signal = true;
            } else {
                saw_signal = true;
                explicit_negative = explicit_negative || !*mx_valid;
            }
        }
    } else if (body.contains("email_deliverability")) {
        saw_malformed_signal = true;
    }

    if (body.contains("email_risk") && body.at("email_risk").is_object()) {
        const auto& risk = body.at("email_risk");

        if (risk.contains("address_risk_status")) {
            if (!risk.at("address_risk_status").is_string()) {
                saw_malformed_signal = true;
            } else {
                saw_signal = true;
                const std::string address_risk = to_lower(risk.at("address_risk_status").get<std::string>());
                explicit_negative = explicit_negative || address_risk == "high";
            }
        }
    } else if (body.contains("email_risk")) {
        saw_malformed_signal = true;
    }

    if (explicit_negative) {
        return EmailValidationResult::Rejected;
    }
    if (saw_malformed_signal || !saw_signal) {
        return EmailValidationResult::Unavailable;
    }
    return EmailValidationResult::Accepted;
}
