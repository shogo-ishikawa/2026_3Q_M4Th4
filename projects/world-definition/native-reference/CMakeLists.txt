cmake_minimum_required(VERSION 3.21)
project(WORLD_DEFINITION LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

include(FetchContent)
set(BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(BUILD_GAMES OFF CACHE BOOL "" FORCE)
FetchContent_Declare(raylib
    URL https://github.com/raysan5/raylib/archive/refs/tags/6.2.tar.gz
    DOWNLOAD_EXTRACT_TIMESTAMP TRUE
)
FetchContent_Declare(nlohmann_json
    URL https://github.com/nlohmann/json/releases/download/v3.12.0/json.tar.xz
    DOWNLOAD_EXTRACT_TIMESTAMP TRUE
)
FetchContent_MakeAvailable(raylib nlohmann_json)

set(WD_SOURCES
    src/main.cpp
    src/GameWorld.cpp
    src/RuleEngine.cpp
    src/OllamaClient.cpp
)

if(APPLE)
    add_executable(world_definition MACOSX_BUNDLE ${WD_SOURCES})
    set_target_properties(world_definition PROPERTIES
        OUTPUT_NAME "WORLD DEFINITION"
        MACOSX_BUNDLE_BUNDLE_NAME "WORLD DEFINITION"
        MACOSX_BUNDLE_GUI_IDENTIFIER "jp.ac.nihon.worlddefinition"
        MACOSX_BUNDLE_BUNDLE_VERSION "1.0"
        MACOSX_BUNDLE_SHORT_VERSION_STRING "1.0"
    )
else()
    add_executable(world_definition ${WD_SOURCES})
endif()

target_include_directories(world_definition PRIVATE src)
target_link_libraries(world_definition PRIVATE raylib nlohmann_json::nlohmann_json)

if(WIN32)
    target_link_libraries(world_definition PRIVATE winhttp)
else()
    find_package(CURL REQUIRED)
    target_link_libraries(world_definition PRIVATE CURL::libcurl)
endif()

if(MSVC)
    target_compile_options(world_definition PRIVATE /W4 /utf-8)
else()
    target_compile_options(world_definition PRIVATE -Wall -Wextra -Wpedantic)
endif()

if(APPLE)
    # Finder-launched .app uses its own resources; no external data folder needed.
    add_custom_command(TARGET world_definition POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E copy_directory
            "${CMAKE_CURRENT_SOURCE_DIR}/data"
            "$<TARGET_FILE_DIR:world_definition>/../Resources/data"
        VERBATIM
        COMMENT "Bundle game font and data in macOS .app"
    )
endif()
