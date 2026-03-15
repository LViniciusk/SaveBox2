#include <iostream>
#include <boost/asio.hpp>
#include <nlohmann/json.hpp>
#include <zip.h>

int main() {
    // Teste JSON
    nlohmann::json j = {{"status", "OK"}, {"libs", "carregadas"}};
    
    // Teste Boost.Asio
    boost::asio::io_context io;
    
    // Teste Libzip
    int err = 0;
    zip_t* z = zip_open("teste.zip", ZIP_CREATE, &err);
    if(z) zip_close(z);

    std::cout << "Sucesso! JSON: " << j.dump() << std::endl;
    std::cout << "Ambiente configurado e pronto para o SaveBox2." << std::endl;
    
    return 0;
}
