cmake_minimum_required(VERSION 3.15)
project(SaveBoxWeb VERSION 2.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

option(BUILD_TESTS "Compilar suite de testes" ON)

include(FetchContent)

if(NOT WIN32)
    set(BUILD_SHARED_LIBS OFF CACHE BOOL "Build static" FORCE)
endif()

find_program(CCACHE_PROGRAM ccache)
if(CCACHE_PROGRAM)
    set_property(GLOBAL PROPERTY RULE_LAUNCH_COMPILE "${CCACHE_PROGRAM}")
endif()

# ----------------------------------------------------------------------
# FASE 1: DEPENDÊNCIAS DO SISTEMA
# ----------------------------------------------------------------------
find_package(Threads REQUIRED)
find_package(PkgConfig REQUIRED)
find_package(OpenSSL REQUIRED)

# Bibliotecas de produção
pkg_check_modules(SODIUM REQUIRED libsodium)
pkg_check_modules(ZIP REQUIRED libzip)

# Framework de testes
if(BUILD_TESTS)
    find_package(Catch2 3 CONFIG REQUIRED)
endif()

# Cliente HTTP (CPR)
if(WIN32)
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
if(WIN32)
    pkg_check_modules(PQXX REQUIRED libpqxx)
else()
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
file(GLOB_RECURSE ALL_SRC_FILES "src/*.cpp")
list(REMOVE_ITEM ALL_SRC_FILES "${CMAKE_CURRENT_SOURCE_DIR}/src/main.cpp")
set(CORE_SOURCES ${ALL_SRC_FILES})

if(BUILD_TESTS)
    file(GLOB_RECURSE TEST_FILES "tests/*.cpp")
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

# Compatibilidade com ASIO recente do MSYS2/UCRT
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

# ----------------------------------------------------------------------
# FASE 3: CONSTRUINDO O SERVIDOR (Produção)
# ----------------------------------------------------------------------
add_executable(savebox_server src/main.cpp ${CORE_SOURCES})

target_compile_options(savebox_server PRIVATE -UASIO_NO_DEPRECATED -UBOOST_ASIO_NO_DEPRECATED)

if(WIN32)
    # No Windows, usamos a libpqxx instalada pelo MSYS2
    target_include_directories(savebox_server PRIVATE include ${PQXX_INCLUDE_DIRS} ${SODIUM_INCLUDE_DIRS} ${ZIP_INCLUDE_DIRS})
    target_link_directories(savebox_server PRIVATE ${PQXX_LIBRARY_DIRS} ${SODIUM_LIBRARY_DIRS} ${ZIP_LIBRARY_DIRS})
    target_link_libraries(savebox_server PRIVATE 
        Threads::Threads 
        ${PQXX_LIBRARIES} 
        ${SODIUM_LIBRARIES} 
        ${ZIP_LIBRARIES} 
        jwt-cpp::jwt-cpp 
        OpenSSL::SSL 
        OpenSSL::Crypto 
        cpr::cpr 
        ws2_32 mswsock crypt32 bcrypt
    )
else()
    # No Linux (Docker), usamos a libpqxx compilada pelo FetchContent (nome 'pqxx')
    target_include_directories(savebox_server PRIVATE include ${SODIUM_INCLUDE_DIRS} ${ZIP_INCLUDE_DIRS})
    target_link_directories(savebox_server PRIVATE ${SODIUM_LIBRARY_DIRS} ${ZIP_LIBRARY_DIRS})
    target_link_libraries(savebox_server PRIVATE 
        Threads::Threads 
        pqxx  # <-- A mágica da libpqxx moderna no Linux
        ${SODIUM_LIBRARIES} 
        ${ZIP_LIBRARIES} 
        jwt-cpp::jwt-cpp 
        OpenSSL::SSL 
        OpenSSL::Crypto 
        cpr::cpr
    )
endif()

# ----------------------------------------------------------------------
# FASE 4: CONSTRUINDO OS TESTES (Laboratório)
# ----------------------------------------------------------------------
if(BUILD_TESTS)
    add_executable(savebox_tests ${TEST_FILES} ${CORE_SOURCES})

    target_compile_options(savebox_tests PRIVATE -UASIO_NO_DEPRECATED -UBOOST_ASIO_NO_DEPRECATED)

    if(WIN32)
        target_include_directories(savebox_tests PRIVATE include tests ${PQXX_INCLUDE_DIRS} ${SODIUM_INCLUDE_DIRS} ${ZIP_INCLUDE_DIRS})
        target_link_directories(savebox_tests PRIVATE ${PQXX_LIBRARY_DIRS} ${SODIUM_LIBRARY_DIRS} ${ZIP_LIBRARY_DIRS})
        target_link_libraries(savebox_tests PRIVATE
            Threads::Threads
            Catch2::Catch2
            ${PQXX_LIBRARIES}
            ${SODIUM_LIBRARIES}
            ${ZIP_LIBRARIES}
            jwt-cpp::jwt-cpp
            OpenSSL::SSL
            OpenSSL::Crypto
            cpr::cpr
            ws2_32 mswsock crypt32 bcrypt
        )
    else()
        target_include_directories(savebox_tests PRIVATE include tests ${SODIUM_INCLUDE_DIRS} ${ZIP_INCLUDE_DIRS})
        target_link_directories(savebox_tests PRIVATE ${SODIUM_LIBRARY_DIRS} ${ZIP_LIBRARY_DIRS})
        target_link_libraries(savebox_tests PRIVATE
            Threads::Threads
            Catch2::Catch2
            pqxx
            ${SODIUM_LIBRARIES}
            ${ZIP_LIBRARIES}
            jwt-cpp::jwt-cpp
            OpenSSL::SSL
            OpenSSL::Crypto
            cpr::cpr
        )
    endif()
endif()

