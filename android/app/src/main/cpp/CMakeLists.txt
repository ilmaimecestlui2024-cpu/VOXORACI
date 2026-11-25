cmake_minimum_required(VERSION 3.18)
project(voxora)

find_package(oboe REQUIRED CONFIG)

add_library(voxora SHARED voxora.cpp)
set_target_properties(voxora PROPERTIES CXX_STANDARD 17 CXX_STANDARD_REQUIRED ON)
target_compile_options(voxora PRIVATE -O3 -ffast-math)
target_link_libraries(voxora oboe::oboe mediandk log)
