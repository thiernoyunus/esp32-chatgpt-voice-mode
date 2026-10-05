cmake_minimum_required(VERSION 3.16)
project(voicemode_watch_host C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_C_STANDARD 99)
set(CMAKE_C_STANDARD_REQUIRED ON)

# The firmware root is three levels up from scripts/tests/watch_ui_host.
get_filename_component(FW_DIR "${CMAKE_CURRENT_SOURCE_DIR}/../../.." ABSOLUTE)

# Keep a fixed compatible baseline for screenshots. The device manifest allows
# patch updates (~9.5.0), so a device build may resolve a newer patch release.
set(LVGL_VERSION "v9.5.0")
file(STRINGS "${FW_DIR}/main/idf_component.yml" LVGL_MANIFEST_LINE
     REGEX "^[ \t]*lvgl/lvgl:")
if(NOT LVGL_MANIFEST_LINE MATCHES "~9\\.5\\.0")
    message(FATAL_ERROR "Review the host LVGL baseline: expected firmware range ~9.5.0")
endif()

# The configuration has to be in place before LVGL is added, because adding it
# runs LVGL's own CMakeLists and reads these. Pass
# -DVOICEMODE_LVGL_DIR=/path/to/lvgl (or set the environment variable) to build
# against a local checkout, for example when offline.
set(LV_BUILD_CONF_PATH "${CMAKE_CURRENT_SOURCE_DIR}/host/lv_conf.h" CACHE PATH "" FORCE)
set(CONFIG_LV_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(CONFIG_LV_BUILD_DEMOS OFF CACHE BOOL "" FORCE)
set(CONFIG_LV_USE_THORVG_INTERNAL OFF CACHE BOOL "" FORCE)

set(VOICEMODE_LVGL_DIR "$ENV{VOICEMODE_LVGL_DIR}" CACHE PATH "Local LVGL checkout (optional)")
if(VOICEMODE_LVGL_DIR AND EXISTS "${VOICEMODE_LVGL_DIR}/CMakeLists.txt")
    set(LVGL_SOURCE_DIR "${VOICEMODE_LVGL_DIR}")
    add_subdirectory("${LVGL_SOURCE_DIR}" "${CMAKE_BINARY_DIR}/lvgl_build")
else()
    include(FetchContent)
    FetchContent_Declare(lvgl
        GIT_REPOSITORY https://github.com/lvgl/lvgl.git
        GIT_TAG ${LVGL_VERSION}
        GIT_SHALLOW TRUE
    )
    # This both downloads and adds LVGL; it must not be paired with another
    # add_subdirectory of the same source, or the target is defined twice.
    FetchContent_MakeAvailable(lvgl)
    set(LVGL_SOURCE_DIR "${lvgl_SOURCE_DIR}")
endif()

add_executable(watch_ui_test
    test_host_main.cc
    host/display_driver.c
    host/screenshot.c
    "${FW_DIR}/main/display/watch_ui.cc"
    "${FW_DIR}/main/display/watch_icons.cc"
    "${FW_DIR}/main/display/bloub/bloub_face.c"
    "${FW_DIR}/main/display/bloub/bloub_shapes.c"
    "${FW_DIR}/managed_components/78__xiaozhi-fonts/src/font_noto_sans_basic_30_4.c"
    "${FW_DIR}/managed_components/78__xiaozhi-fonts/src/font_noto_sans_basic_20_4.c"
)

target_include_directories(watch_ui_test PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}/host"
    # LVGL's own sources, so the test can look at display internals such as the
    # live screen count.
    "${LVGL_SOURCE_DIR}/src"
    "${FW_DIR}/main/display"
)

target_link_libraries(watch_ui_test PRIVATE lvgl m)

set_target_properties(watch_ui_test PROPERTIES
    CXX_STANDARD 17
    C_STANDARD 99
)
