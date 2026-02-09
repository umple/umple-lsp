#include <napi.h>

extern "C" {
  typedef struct TSLanguage TSLanguage;
  const TSLanguage *tree_sitter_umple();
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports["tree_sitter_umple"] = Napi::External<void>::New(
    env,
    (void *)tree_sitter_umple()
  );
  return exports;
}

NODE_API_MODULE(tree_sitter_umple_binding, Init)
