cmake_minimum_required(VERSION 3.22)
project(ga_pipe
  VERSION 0.1.0
  DESCRIPTION "Customer-distributable analytics forwarder (TS-088)"
  LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release CACHE STRING "" FORCE)
endif()

add_compile_options(-Wall -Wextra -Wpedantic)

option(GA_PIPE_ENABLE_SANITIZERS "Build with ASan+UBSan (Debug only)" OFF)
option(GA_PIPE_ENABLE_TSAN       "Build with TSan (mutually exclusive with ASan)" OFF)
if(GA_PIPE_ENABLE_SANITIZERS AND CMAKE_BUILD_TYPE STREQUAL "Debug")
  add_compile_options(-fsanitize=address,undefined -fno-omit-frame-pointer)
  add_link_options(-fsanitize=address,undefined)
endif()
if(GA_PIPE_ENABLE_TSAN AND CMAKE_BUILD_TYPE STREQUAL "Debug")
  add_compile_options(-fsanitize=thread -fno-omit-frame-pointer)
  add_link_options(-fsanitize=thread)
endif()

include(cmake/Deps.cmake)

file(GLOB GA_PIPE_SOURCES CONFIGURE_DEPENDS src/*.cpp)
add_library(ga_pipe_core STATIC ${GA_PIPE_SOURCES})
target_include_directories(ga_pipe_core PUBLIC
  $<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>)
target_link_libraries(ga_pipe_core PUBLIC
  CURL::libcurl
  nlohmann_json::nlohmann_json
  yaml-cpp
  pantor::inja)

add_executable(ga_pipe apps/ga_pipe_main.cpp)
target_link_libraries(ga_pipe PRIVATE ga_pipe_core)

enable_testing()
add_subdirectory(tests)

install(TARGETS ga_pipe RUNTIME DESTINATION bin)
install(DIRECTORY sinks/ DESTINATION share/ga_pipe/sinks FILES_MATCHING PATTERN "*.yaml")
