cmake_minimum_required(VERSION 3.22.1)

project(liboliphaunt_kotlin_android LANGUAGES C CXX)

add_library(oliphaunt_kotlin_android SHARED
  oliphaunt_android_bridge.cpp
)

target_compile_features(oliphaunt_kotlin_android PRIVATE cxx_std_17)

target_include_directories(oliphaunt_kotlin_android PRIVATE
  "${CMAKE_CURRENT_SOURCE_DIR}/include"
)

target_link_libraries(oliphaunt_kotlin_android PRIVATE
  dl
  log
)

target_link_options(oliphaunt_kotlin_android PRIVATE
  "-Wl,-z,max-page-size=16384"
)

function(oliphaunt_find_file out_var)
  foreach(candidate IN LISTS ARGN)
    if(EXISTS "${candidate}")
      set("${out_var}" "${candidate}" PARENT_SCOPE)
      return()
    endif()
  endforeach()
  set("${out_var}" "" PARENT_SCOPE)
endfunction()

if(DEFINED OLIPHAUNT_MOBILE_STATIC_MODULES AND NOT "${OLIPHAUNT_MOBILE_STATIC_MODULES}" STREQUAL "")
  if(NOT DEFINED OLIPHAUNT_STATIC_REGISTRY_SOURCE OR NOT EXISTS "${OLIPHAUNT_STATIC_REGISTRY_SOURCE}")
    message(FATAL_ERROR "OLIPHAUNT_MOBILE_STATIC_MODULES requires OLIPHAUNT_STATIC_REGISTRY_SOURCE from oliphaunt-resources --mobile-static-module")
  endif()
  if(NOT DEFINED OLIPHAUNT_EXTENSION_ARCHIVES_ROOT OR "${OLIPHAUNT_EXTENSION_ARCHIVES_ROOT}" STREQUAL "")
    message(FATAL_ERROR "OLIPHAUNT_MOBILE_STATIC_MODULES requires OLIPHAUNT_EXTENSION_ARCHIVES_ROOT from static-registry/archives or -PoliphauntAndroidExtensionArchivesDir")
  endif()
  if(NOT DEFINED OLIPHAUNT_ANDROID_JNI_LIBS_ROOT OR "${OLIPHAUNT_ANDROID_JNI_LIBS_ROOT}" STREQUAL "")
    message(FATAL_ERROR "OLIPHAUNT_MOBILE_STATIC_MODULES requires OLIPHAUNT_ANDROID_JNI_LIBS_ROOT with liboliphaunt.so")
  endif()
  if(DEFINED OLIPHAUNT_ANDROID_LINK_EVIDENCE_FILE AND NOT "${OLIPHAUNT_ANDROID_LINK_EVIDENCE_FILE}" STREQUAL "")
    get_filename_component(OLIPHAUNT_ANDROID_LINK_EVIDENCE_DIR "${OLIPHAUNT_ANDROID_LINK_EVIDENCE_FILE}" DIRECTORY)
    file(MAKE_DIRECTORY "${OLIPHAUNT_ANDROID_LINK_EVIDENCE_DIR}")
    file(WRITE "${OLIPHAUNT_ANDROID_LINK_EVIDENCE_FILE}" "schema\toliphaunt-android-static-extension-link-v1\n")
    file(APPEND "${OLIPHAUNT_ANDROID_LINK_EVIDENCE_FILE}" "abi\t${ANDROID_ABI}\n")
  endif()

  oliphaunt_find_file(OLIPHAUNT_IMPORTED_LIBRARY
    "${OLIPHAUNT_ANDROID_JNI_LIBS_ROOT}/jniLibs/${ANDROID_ABI}/liboliphaunt.so"
    "${OLIPHAUNT_ANDROID_JNI_LIBS_ROOT}/${ANDROID_ABI}/liboliphaunt.so"
  )
  if("${OLIPHAUNT_IMPORTED_LIBRARY}" STREQUAL "")
    message(FATAL_ERROR "Could not find liboliphaunt.so for ${ANDROID_ABI} under OLIPHAUNT_ANDROID_JNI_LIBS_ROOT=${OLIPHAUNT_ANDROID_JNI_LIBS_ROOT}")
  endif()

  add_library(oliphaunt_imported SHARED IMPORTED)
  set_target_properties(oliphaunt_imported PROPERTIES
    IMPORTED_LOCATION "${OLIPHAUNT_IMPORTED_LIBRARY}"
  )
  if(DEFINED OLIPHAUNT_ANDROID_LINK_EVIDENCE_FILE AND NOT "${OLIPHAUNT_ANDROID_LINK_EVIDENCE_FILE}" STREQUAL "")
    file(APPEND "${OLIPHAUNT_ANDROID_LINK_EVIDENCE_FILE}" "runtime\tliboliphaunt\t${OLIPHAUNT_IMPORTED_LIBRARY}\n")
  endif()

  add_library(oliphaunt_extensions SHARED
    "${OLIPHAUNT_STATIC_REGISTRY_SOURCE}"
  )
  target_include_directories(oliphaunt_extensions PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}/include"
  )
  target_link_libraries(oliphaunt_extensions PRIVATE
    oliphaunt_imported
  )
  foreach(stem IN LISTS OLIPHAUNT_MOBILE_STATIC_MODULES)
    oliphaunt_find_file(extension_archive
      "${OLIPHAUNT_EXTENSION_ARCHIVES_ROOT}/jniLibs/${ANDROID_ABI}/extensions/${stem}/liboliphaunt_extension_${stem}.a"
      "${OLIPHAUNT_EXTENSION_ARCHIVES_ROOT}/android-${ANDROID_ABI}/extensions/${stem}/liboliphaunt_extension_${stem}.a"
      "${OLIPHAUNT_EXTENSION_ARCHIVES_ROOT}/${ANDROID_ABI}/extensions/${stem}/liboliphaunt_extension_${stem}.a"
      "${OLIPHAUNT_EXTENSION_ARCHIVES_ROOT}/extensions/${stem}/liboliphaunt_extension_${stem}.a"
      "${OLIPHAUNT_EXTENSION_ARCHIVES_ROOT}/${stem}/liboliphaunt_extension_${stem}.a"
    )
    if("${extension_archive}" STREQUAL "")
      message(FATAL_ERROR "Could not find prebuilt liboliphaunt_extension_${stem}.a for ${ANDROID_ABI} under OLIPHAUNT_EXTENSION_ARCHIVES_ROOT=${OLIPHAUNT_EXTENSION_ARCHIVES_ROOT}")
    endif()
    if(DEFINED OLIPHAUNT_ANDROID_LINK_EVIDENCE_FILE AND NOT "${OLIPHAUNT_ANDROID_LINK_EVIDENCE_FILE}" STREQUAL "")
      file(APPEND "${OLIPHAUNT_ANDROID_LINK_EVIDENCE_FILE}" "extension\t${stem}\t${extension_archive}\n")
    endif()
    target_link_libraries(oliphaunt_extensions PRIVATE
      "-Wl,--whole-archive"
      "${extension_archive}"
      "-Wl,--no-whole-archive"
    )
  endforeach()
  set(oliphaunt_dependency_archives)
  foreach(dependency_root
      "${OLIPHAUNT_EXTENSION_ARCHIVES_ROOT}/jniLibs/${ANDROID_ABI}/dependencies"
      "${OLIPHAUNT_EXTENSION_ARCHIVES_ROOT}/android-${ANDROID_ABI}/dependencies"
      "${OLIPHAUNT_EXTENSION_ARCHIVES_ROOT}/${ANDROID_ABI}/dependencies"
      "${OLIPHAUNT_EXTENSION_ARCHIVES_ROOT}/dependencies")
    if(IS_DIRECTORY "${dependency_root}")
      file(GLOB_RECURSE dependency_archives CONFIGURE_DEPENDS "${dependency_root}/*.a")
      list(APPEND oliphaunt_dependency_archives ${dependency_archives})
    endif()
  endforeach()
  if(oliphaunt_dependency_archives)
    list(REMOVE_DUPLICATES oliphaunt_dependency_archives)
    list(SORT oliphaunt_dependency_archives)
    if(DEFINED OLIPHAUNT_ANDROID_LINK_EVIDENCE_FILE AND NOT "${OLIPHAUNT_ANDROID_LINK_EVIDENCE_FILE}" STREQUAL "")
      foreach(dependency_archive IN LISTS oliphaunt_dependency_archives)
        get_filename_component(dependency_dir "${dependency_archive}" DIRECTORY)
        get_filename_component(dependency_name "${dependency_dir}" NAME)
        file(APPEND "${OLIPHAUNT_ANDROID_LINK_EVIDENCE_FILE}" "dependency\t${dependency_name}\t${dependency_archive}\n")
      endforeach()
    endif()
    target_link_libraries(oliphaunt_extensions PRIVATE
      ${oliphaunt_dependency_archives}
    )
  endif()
  target_link_options(oliphaunt_extensions PRIVATE
    "-Wl,-z,max-page-size=16384"
  )
endif()
