#pragma once

#include <cpr/cpr.h>

#include <string>

class EmailService {
public:
    EmailService(const std::string& resend_api_key, const std::string& validation_api_key);

    virtual ~EmailService() = default;

    bool send_verification_email(const std::string& to_email, const std::string& token) const;
    bool is_domain_valid_via_api(const std::string& domain) const;

protected:
    virtual cpr::Response make_post_request(const std::string& url,
                                            const cpr::Header& headers,
                                            const cpr::Body& body) const;
    virtual cpr::Response make_get_request(const std::string& url) const;

private:
    std::string resend_api_key_;
    std::string validation_api_key_;
};
