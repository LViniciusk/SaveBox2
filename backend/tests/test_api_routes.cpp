#include <catch2/catch_test_macros.hpp>
#include "controllers/ApiRouter.hpp"
#include <string>




TEST_CASE("Lógica do Healthcheck", "[api][routes][healthcheck]") {
    ApiRouter router;
    std::string response = router.handle_healthcheck();

    REQUIRE(response.find("\"status\":\"online\"") != std::string::npos);
}
