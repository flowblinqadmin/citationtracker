# ga-pipe

Customer-distributable analytics forwarder (TS-088). Reads filtered
`geo_page_views` from Flowblinq's `/api/v1/page_views` and POSTs to a
pluggable sink (GA4 Measurement Protocol, generic HMAC webhook, or
whatever YAML template you supply).

Not part of the Next.js build — this directory is excluded via
`.vercelignore` and has its own CMake toolchain.

## Build

```
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build -j$(nproc)
ctest --test-dir build --output-on-failure
```

Debug build with sanitizers:
```
cmake -B build-debug -DCMAKE_BUILD_TYPE=Debug -DGA_PIPE_ENABLE_SANITIZERS=ON
cmake --build build-debug -j$(nproc)
```

## Run

```
./build/ga_pipe --config pipe.yaml
```

Status: skeleton. Task #17 (modules) and Task #18 (glue) fill in
implementations; this commit only lands the build system + API headers
+ linkable stubs.
