#include <catch2/catch_session.hpp>
#include <iostream>
#include <cstdlib>




int main(int argc, char* argv[]) {

    Catch::Session session;
    
    int returnCode = session.applyCommandLine(argc, argv);
    if (returnCode != 0) {
        return returnCode;
    }

    int result = session.run();


    return result;
}