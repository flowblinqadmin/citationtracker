file(GLOB UNIT_TESTS CONFIGURE_DEPENDS unit/*.cpp)
foreach(src ${UNIT_TESTS})
  get_filename_component(name ${src} NAME_WE)
  add_executable(${name} ${src})
  target_link_libraries(${name} PRIVATE ga_pipe_core Catch2::Catch2WithMain)
  target_include_directories(${name} PRIVATE ${CPP_HTTPLIB_INCLUDE_DIR})
  catch_discover_tests(${name})
endforeach()

file(GLOB INTEG_TESTS CONFIGURE_DEPENDS integration/*.cpp)
foreach(src ${INTEG_TESTS})
  get_filename_component(name ${src} NAME_WE)
  add_executable(${name} ${src})
  target_link_libraries(${name} PRIVATE ga_pipe_core Catch2::Catch2WithMain)
  target_include_directories(${name} PRIVATE
    ${CPP_HTTPLIB_INCLUDE_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/integration)
  catch_discover_tests(${name})
endforeach()
