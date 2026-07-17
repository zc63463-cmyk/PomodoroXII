cmake_minimum_required(VERSION 3.30...3.31)
project(pxii_vfs LANGUAGES C)

file(MAKE_DIRECTORY "${CMAKE_CURRENT_BINARY_DIR}/generated")
file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/generated/sqlite3.h"
  "/* SQLite ABI declarations are intentionally provided by pxii_vfs.h. */\n")

add_library(pxii_vfs MODULE
  native/pxii_vfs/pxii_vfs.c
  native/pxii_vfs/pxii_vfs.h
  native/vendor/sqlite3ext.h
)
target_compile_features(pxii_vfs PRIVATE c_std_17)
target_include_directories(pxii_vfs PRIVATE
  native/vendor
  native/pxii_vfs
  "${CMAKE_CURRENT_BINARY_DIR}/generated"
)
set_target_properties(pxii_vfs PROPERTIES
  C_VISIBILITY_PRESET hidden
  VISIBILITY_INLINES_HIDDEN YES
  PREFIX ""
  OUTPUT_NAME "_pxii_vfs"
)
if(MSVC)
  target_compile_options(pxii_vfs PRIVATE /std:c17 /W4 /WX)
  target_compile_definitions(pxii_vfs PRIVATE _CRT_SECURE_NO_WARNINGS)
else()
  target_compile_definitions(pxii_vfs PRIVATE _GNU_SOURCE)
  target_compile_options(pxii_vfs PRIVATE -Wall -Wextra -Wpedantic -Werror)
endif()
install(TARGETS pxii_vfs
  LIBRARY DESTINATION pomodoroxii_native
  RUNTIME DESTINATION pomodoroxii_native
)
install(FILES cmake/pxii-vfs-source.sha256
  DESTINATION pomodoroxii_native/cmake
)
install(FILES
  native/pxii_vfs/pxii_vfs.c
  native/pxii_vfs/pxii_vfs.h
  DESTINATION pomodoroxii_native/native/pxii_vfs
)
install(FILES native/vendor/sqlite3ext.h
  DESTINATION pomodoroxii_native/native/vendor
)
