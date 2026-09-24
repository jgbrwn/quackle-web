cmake_minimum_required(VERSION 3.28)
project(quackle-engine-worker LANGUAGES CXX)

set(QUACKLE_ROOT "" CACHE PATH "Pinned Quackle source checkout")
set(QUACKLE_BUILD_DIR "" CACHE PATH "Build tree containing libquackle.a and libquackleio.a")

if(NOT QUACKLE_ROOT OR NOT QUACKLE_BUILD_DIR)
    message(FATAL_ERROR "Set QUACKLE_ROOT and QUACKLE_BUILD_DIR")
endif()

find_package(Qt6 REQUIRED COMPONENTS Core)
find_package(Threads REQUIRED)

add_library(quackle STATIC IMPORTED GLOBAL)
set_target_properties(quackle PROPERTIES
    IMPORTED_LOCATION "${QUACKLE_BUILD_DIR}/libquackle/libquackle.a"
    INTERFACE_INCLUDE_DIRECTORIES "${QUACKLE_ROOT}"
)

add_library(quackleio STATIC IMPORTED GLOBAL)
set_target_properties(quackleio PROPERTIES
    IMPORTED_LOCATION "${QUACKLE_BUILD_DIR}/quackleio/libquackleio.a"
    INTERFACE_INCLUDE_DIRECTORIES "${QUACKLE_ROOT};${QUACKLE_ROOT}/quackleio"
)
target_link_libraries(quackleio INTERFACE quackle Qt6::Core Threads::Threads)

add_executable(quackle-engine-worker
    classic_board.cpp
    main.cpp
)
target_compile_features(quackle-engine-worker PRIVATE cxx_std_17)
target_compile_options(quackle-engine-worker PRIVATE -Wall -Wextra -Wpedantic)
target_link_libraries(quackle-engine-worker PRIVATE quackleio quackle Qt6::Core Threads::Threads)

set_target_properties(quackle-engine-worker PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin"
)
