cmake_minimum_required(VERSION 3.15)
project(SaveBoxWeb VERSION 2.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

option(BUILD_TESTS "Compilar suite de testes" ON)
option(BUILD_BENCHMARKS "Build backend microbenchmarks" OFF)
option(ENABLE_COVERAGE "Instrumentar os testes para cobertura" OFF)

include(FetchContent)

if(NOT WIN32)
    set(BUILD_SHARED_LIBS OFF CACHE BOOL "Build static" FORCE)
endif()

if(NOT MSVC)
    find_program(CCACHE_PROGRAM ccache)
    if(CCACHE_PROGRAM)
        set_property(GLOBAL PROPERTY RULE_LAUNCH_COMPILE "${CCACHE_PROGRAM}")
    endif()
endif()

# ----------------------------------------------------------------------
# FASE 1: DEPENDÊNCIAS DO SISTEMA
# ----------------------------------------------------------------------
find_package(Threads REQUIRED)
find_package(OpenSSL REQUIRED)

if(MSVC)
    find_package(libpqxx CONFIG REQUIRED)
    find_package(unofficial-sodium CONFIG REQUIRED)
    find_package(asio CONFIG REQUIRED)
    find_package(nlohmann_json CONFIG REQUIRED)
elseif(WIN32)
    find_package(PkgConfig REQUIRED)
    pkg_check_modules(SODIUM REQUIRED libsodium)
    pkg_check_modules(PQXX REQUIRED libpqxx)
else()
    find_package(PkgConfig REQUIRED)
    pkg_check_modules(SODIUM REQUIRED libsodium)
endif()

# Framework de testes
if(BUILD_TESTS OR BUILD_BENCHMARKS)
    find_package(Catch2 3 CONFIG REQUIRED)
endif()

# Cliente HTTP (CPR)
if(MSVC)
    # Native Windows uses the vcpkg CONFIG package.
    find_package(cpr CONFIG REQUIRED)
elseif(WIN32)
    find_package(cpr REQUIRED)
else()
    set(CPR_USE_SYSTEM_CURL ON CACHE BOOL "Use system cURL" FORCE)
    FetchContent_Declare(cpr
        GIT_REPOSITORY https://github.com/libcpr/cpr.git
        GIT_TAG 1.10.5
    )
    FetchContent_MakeAvailable(cpr)
endif()

# Banco de Dados (libpqxx) - Inteligência de Plataforma
if(NOT MSVC AND NOT WIN32)
    set(SKIP_PQXX_TESTS ON CACHE BOOL "Skip tests" FORCE)
    set(SKIP_BUILD_TEST ON CACHE BOOL "Skip tests" FORCE)
    set(BUILD_SHARED_LIBS OFF CACHE BOOL "Build static" FORCE)
    FetchContent_Declare(pqxx
        GIT_REPOSITORY https://github.com/jtv/libpqxx.git
        GIT_TAG 7.10.0
    )
    FetchContent_MakeAvailable(pqxx)
endif()

# ----------------------------------------------------------------------
# FASE 2: SEPARANDO O CÓDIGO FONTE E HEADERS
# ----------------------------------------------------------------------
set(CORE_SOURCES
    src/controllers/ApiRouter.cpp
    src/database/DatabaseMigration.cpp
    src/database/DatabasePool.cpp
    src/database/FileManager.cpp
    src/database/FolderManager.cpp
    src/database/UsersManager.cpp
    src/Services/AuthService.cpp
    src/Services/EmailService.cpp
    src/Services/GoogleDriveService.cpp
    src/Services/GoogleJwksCache.cpp
    src/storage/FileChunker.cpp
    src/storage/GarbageCollector.cpp
)

set(BENCHMARK_FILES
    "${CMAKE_CURRENT_SOURCE_DIR}/tests/test_perf_auth.cpp"
    "${CMAKE_CURRENT_SOURCE_DIR}/tests/test_perf_chunk_io.cpp"
    "${CMAKE_CURRENT_SOURCE_DIR}/tests/test_perf_crypto.cpp"
)

if(BUILD_TESTS)
    file(GLOB_RECURSE TEST_FILES CONFIGURE_DEPENDS "tests/*.cpp")
    list(FILTER TEST_FILES EXCLUDE REGEX "test_perf_.*\\.cpp$")
    list(FILTER TEST_FILES EXCLUDE REGEX "/e2e_fixture\\.cpp$")
endif()

# ----------------------------------------------------------------------
# FASE 2.1: BOOTSTRAP DE HEADERS PARA AMBIENTES LIMPOS (CI / Docker)
# ----------------------------------------------------------------------
set(CROW_HEADER_PATH "${CMAKE_CURRENT_SOURCE_DIR}/include/crow_all.h")
if(NOT EXISTS "${CROW_HEADER_PATH}")
    message(STATUS "Baixando crow_all.h...")
    file(DOWNLOAD "https://github.com/CrowCpp/Crow/releases/download/v1.2.0/crow_all.h"
                  "${CROW_HEADER_PATH}")
endif()

# Configuração do ASIO atual no MSYS2/UCRT
file(READ "${CROW_HEADER_PATH}" CROW_HEADER_CONTENT)
string(REPLACE "asio::io_service" "asio::io_context" CROW_HEADER_CONTENT "${CROW_HEADER_CONTENT}")
string(REPLACE "asio::ip::address::from_string" "asio::ip::make_address" CROW_HEADER_CONTENT "${CROW_HEADER_CONTENT}")
string(REPLACE "io_service->post(handler);" "asio::post(*io_service, handler);" CROW_HEADER_CONTENT "${CROW_HEADER_CONTENT}")
string(REPLACE "io_service->dispatch(handler);" "asio::dispatch(*io_service, handler);" CROW_HEADER_CONTENT "${CROW_HEADER_CONTENT}")
string(REPLACE "is.post(" "asio::post(is," CROW_HEADER_CONTENT "${CROW_HEADER_CONTENT}")
file(WRITE "${CROW_HEADER_PATH}" "${CROW_HEADER_CONTENT}")

FetchContent_Declare(jwt_cpp
    GIT_REPOSITORY https://github.com/Thalhammer/jwt-cpp.git
    GIT_TAG v0.7.0
)
FetchContent_MakeAvailable(jwt_cpp)

if(MSVC)
    set(NANIKA_PQXX_TARGET libpqxx::pqxx)
    set(NANIKA_SODIUM_TARGET unofficial-sodium::sodium)
    set(NANIKA_ASIO_TARGET asio::asio)
    set(NANIKA_JSON_TARGET nlohmann_json::nlohmann_json)
    set(NANIKA_PLATFORM_INCLUDE_DIRS)
    set(NANIKA_PLATFORM_LIBRARY_DIRS)
    set(NANIKA_PLATFORM_LINK_LIBS ws2_32 mswsock crypt32 bcrypt)
elseif(WIN32)
    # Keep the existing MSYS2/MinGW pkg-config path for local development.
    set(NANIKA_PQXX_TARGET ${PQXX_LIBRARIES})
    set(NANIKA_SODIUM_TARGET ${SODIUM_LIBRARIES})
    set(NANIKA_ASIO_TARGET)
    set(NANIKA_JSON_TARGET)
    set(NANIKA_PLATFORM_INCLUDE_DIRS ${PQXX_INCLUDE_DIRS} ${SODIUM_INCLUDE_DIRS})
    set(NANIKA_PLATFORM_LIBRARY_DIRS ${PQXX_LIBRARY_DIRS} ${SODIUM_LIBRARY_DIRS})
    set(NANIKA_PLATFORM_LINK_LIBS ws2_32 mswsock crypt32 bcrypt)
else()
    set(NANIKA_PQXX_TARGET pqxx)
    set(NANIKA_SODIUM_TARGET ${SODIUM_LIBRARIES})
    set(NANIKA_ASIO_TARGET)
    set(NANIKA_JSON_TARGET)
    set(NANIKA_PLATFORM_INCLUDE_DIRS ${SODIUM_INCLUDE_DIRS})
    set(NANIKA_PLATFORM_LIBRARY_DIRS ${SODIUM_LIBRARY_DIRS})
    set(NANIKA_PLATFORM_LINK_LIBS)
endif()

set(NANIKA_COMMON_LIBS
    Threads::Threads
    ${NANIKA_PQXX_TARGET}
    ${NANIKA_SODIUM_TARGET}
    ${NANIKA_JSON_TARGET}
    jwt-cpp::jwt-cpp
    OpenSSL::SSL
    OpenSSL::Crypto
    cpr::cpr
    ${NANIKA_ASIO_TARGET}
    ${NANIKA_PLATFORM_LINK_LIBS}
)

function(configure_nanika_platform target)
    target_include_directories(${target} PRIVATE include ${NANIKA_PLATFORM_INCLUDE_DIRS})
    if(MSVC)
        target_compile_definitions(${target} PRIVATE NOMINMAX WIN32_LEAN_AND_MEAN)
    endif()
    if(NANIKA_PLATFORM_LIBRARY_DIRS)
        target_link_directories(${target} PRIVATE ${NANIKA_PLATFORM_LIBRARY_DIRS})
    endif()
    target_link_libraries(${target} PRIVATE ${NANIKA_COMMON_LIBS})
endfunction()

function(configure_asio_compat target)
    if(MSVC)
        target_compile_options(${target} PRIVATE /UASIO_NO_DEPRECATED /UBOOST_ASIO_NO_DEPRECATED)
    elseif(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
        target_compile_options(${target} PRIVATE -UASIO_NO_DEPRECATED -UBOOST_ASIO_NO_DEPRECATED)
    endif()
endfunction()

# ----------------------------------------------------------------------
# FASE 3: CONSTRUINDO O SERVIDOR (Produção)
# ----------------------------------------------------------------------
add_executable(savebox_server src/main.cpp ${CORE_SOURCES})

function(enable_project_warnings target)
    if(MSVC)
        target_compile_options(${target} PRIVATE /W4 /utf-8)
    elseif(CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
        target_compile_options(${target} PRIVATE -Wall -Wextra -Wpedantic)
    endif()
endfunction()

enable_project_warnings(savebox_server)
configure_nanika_platform(savebox_server)
configure_asio_compat(savebox_server)

# ----------------------------------------------------------------------
# FASE 4: CONSTRUINDO OS TESTES (Laboratório)
# ----------------------------------------------------------------------
if(BUILD_TESTS)
    add_executable(savebox_tests ${TEST_FILES} ${CORE_SOURCES})

    target_compile_definitions(savebox_tests PRIVATE NANIKA_TESTING=1)
    target_include_directories(savebox_tests PRIVATE tests)
    configure_nanika_platform(savebox_tests)
    target_link_libraries(savebox_tests PRIVATE Catch2::Catch2)
    configure_asio_compat(savebox_tests)
    enable_project_warnings(savebox_tests)

    if(ENABLE_COVERAGE AND CMAKE_CXX_COMPILER_ID MATCHES "GNU|Clang")
        target_compile_options(savebox_tests PRIVATE -O0 -g --coverage)
        target_link_options(savebox_tests PRIVATE --coverage)
    endif()

    add_executable(nanika_e2e_fixture tests/e2e_fixture.cpp tests/e2e_fixture_support.cpp ${CORE_SOURCES})
    target_include_directories(nanika_e2e_fixture PRIVATE tests)
    configure_nanika_platform(nanika_e2e_fixture)
    configure_asio_compat(nanika_e2e_fixture)
    enable_project_warnings(nanika_e2e_fixture)
endif()

if(BUILD_BENCHMARKS)
    add_executable(savebox_benchmarks ${BENCHMARK_FILES})

    enable_project_warnings(savebox_benchmarks)

    if(MSVC)
        target_link_libraries(savebox_benchmarks PRIVATE
            Catch2::Catch2WithMain
            unofficial-sodium::sodium
            jwt-cpp::jwt-cpp
            OpenSSL::SSL
            OpenSSL::Crypto
            ws2_32 mswsock crypt32 bcrypt
        )
    elseif(WIN32)
        target_include_directories(savebox_benchmarks PRIVATE ${SODIUM_INCLUDE_DIRS})
        target_link_directories(savebox_benchmarks PRIVATE ${SODIUM_LIBRARY_DIRS})
        target_link_libraries(savebox_benchmarks PRIVATE
            Catch2::Catch2WithMain
            ${SODIUM_LIBRARIES}
            jwt-cpp::jwt-cpp
            OpenSSL::SSL
            OpenSSL::Crypto
            ws2_32 mswsock crypt32 bcrypt
        )
    else()
        target_include_directories(savebox_benchmarks PRIVATE ${SODIUM_INCLUDE_DIRS})
        target_link_directories(savebox_benchmarks PRIVATE ${SODIUM_LIBRARY_DIRS})
        target_link_libraries(savebox_benchmarks PRIVATE
            Catch2::Catch2WithMain
            ${SODIUM_LIBRARIES}
            jwt-cpp::jwt-cpp
            OpenSSL::SSL
            OpenSSL::Crypto
        )
    endif()

endif()

