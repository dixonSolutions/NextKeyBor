add_executable(nextkeybord
  src/main.cpp
  src/util.cpp
  src/dbus_service.cpp
  src/speech.cpp
  src/predict.cpp
  src/languages.cpp
  src/emoji.cpp
  src/symbols.cpp
  src/media.cpp
  src/keyboard_detect.cpp)

# The D-Bus introspection XML is compiled in so the daemon cannot drift from it.
set(NKB_IFACE_XML ${PROJECT_SOURCE_DIR}/data/io.github.nextkeybor.Daemon.xml)
set(NKB_IFACE_CPP ${CMAKE_CURRENT_BINARY_DIR}/iface_xml.cpp)
add_custom_command(OUTPUT ${NKB_IFACE_CPP}
  COMMAND ${CMAKE_COMMAND} -DIN=${NKB_IFACE_XML} -DOUT=${NKB_IFACE_CPP}
          -P ${CMAKE_CURRENT_SOURCE_DIR}/embed.cmake
  DEPENDS ${NKB_IFACE_XML} ${CMAKE_CURRENT_SOURCE_DIR}/embed.cmake)
target_sources(nextkeybord PRIVATE ${NKB_IFACE_CPP})

target_compile_definitions(nextkeybord PRIVATE NKB_VERSION="${PROJECT_VERSION}")
target_compile_options(nextkeybord PRIVATE -Wall -Wextra)
target_link_libraries(nextkeybord PRIVATE
  PkgConfig::GIO CURL::libcurl Threads::Threads nlohmann_json::nlohmann_json whisper)

install(TARGETS nextkeybord RUNTIME DESTINATION ${CMAKE_INSTALL_BINDIR})
install(FILES ${PROJECT_SOURCE_DIR}/data/io.github.nextkeybor.gschema.xml
        DESTINATION ${CMAKE_INSTALL_DATADIR}/glib-2.0/schemas)
