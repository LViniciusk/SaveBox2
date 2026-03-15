cmake_minimum_required(VERSION 3.10)

cmake_policy(SET CMP0167 NEW)

project(SaveBox2)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

find_package(PkgConfig REQUIRED)

find_package(Boost REQUIRED COMPONENTS system)
find_package(OpenSSL REQUIRED)
find_package(nlohmann_json REQUIRED)
find_package(libzip REQUIRED)

pkg_check_modules(PQXX REQUIRED libpqxx)

add_executable(${PROJECT_NAME} main.cpp)

target_link_libraries(${PROJECT_NAME}
    PRIVATE
    Boost::system
    OpenSSL::SSL
    OpenSSL::Crypto
    nlohmann_json::nlohmann_json
    libzip::zip
    ${PQXX_LIBRARIES}
    ws2_32
    wsock32
    crypt32
)

target_include_directories(${PROJECT_NAME} PRIVATE ${PQXX_INCLUDE_DIRS})
