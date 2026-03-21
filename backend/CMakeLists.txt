cmake_minimum_required(VERSION 3.15)
project(SaveBoxWeb VERSION 2.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# ----------------------------------------------------------------------
# FASE 1: DEPENDÊNCIAS DO SISTEMA
# ----------------------------------------------------------------------
find_package(Threads REQUIRED)
find_package(PkgConfig REQUIRED)
find_package(OpenSSL REQUIRED)

# Nossas bibliotecas de produção
pkg_check_modules(PQXX REQUIRED libpqxx)
pkg_check_modules(SODIUM REQUIRED libsodium)
pkg_check_modules(ZIP REQUIRED libzip)

# O nosso framework de testes (Catch2) e o nosso cliente HTTP (CPR)
find_package(Catch2 3 CONFIG REQUIRED)
find_package(cpr REQUIRED)
include(FetchContent)


# ----------------------------------------------------------------------
# FASE 2: SEPARANDO O CÓDIGO FONTE
# ----------------------------------------------------------------------
file(GLOB_RECURSE ALL_SRC_FILES "src/*.cpp")
list(REMOVE_ITEM ALL_SRC_FILES "${CMAKE_CURRENT_SOURCE_DIR}/src/main.cpp")
set(CORE_SOURCES ${ALL_SRC_FILES})

file(GLOB_RECURSE TEST_FILES "tests/*.cpp")


# ----------------------------------------------------------------------
# FASE 2.1: BOOTSTRAP DE HEADERS PARA AMBIENTES LIMPOS (CI)
# ----------------------------------------------------------------------
set(CROW_HEADER_PATH "${CMAKE_CURRENT_SOURCE_DIR}/include/crow_all.h")
if(NOT EXISTS "${CROW_HEADER_PATH}")
    message(STATUS "Baixando crow_all.h...")
    file(DOWNLOAD "https://github.com/CrowCpp/Crow/releases/download/v1.2.0/crow_all.h"
                  "${CROW_HEADER_PATH}")
endif()

# Compatibilidade com ASIO recente do MSYS2/UCRT (io_service foi substituido por io_context)
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
    ws2_32
    mswsock
    crypt32
    bcrypt
    cpr::cpr
)

# ----------------------------------------------------------------------
# FASE 4: CONSTRUINDO OS TESTES (Laboratório)
# ----------------------------------------------------------------------
add_executable(savebox_tests ${TEST_FILES} ${CORE_SOURCES})

target_compile_options(savebox_tests PRIVATE -UASIO_NO_DEPRECATED -UBOOST_ASIO_NO_DEPRECATED)

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
    ws2_32
    mswsock
    crypt32
    bcrypt
    cpr::cpr
)