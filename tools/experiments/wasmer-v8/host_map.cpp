// Ordinary consumer C++ code: deliberately no V8 headers or custom hash.
#include <cstdio>
#include <unordered_map>

extern "C" unsigned probe_host_map() {
  std::unordered_map<unsigned, unsigned> values;
  for (unsigned key = 0; key < 10000; ++key) {
    values.try_emplace(key, key + 17);
  }
  unsigned missing = 0;
  for (unsigned key = 0; key < 10000; ++key) {
    auto found = values.find(key);
    if (found == values.end() || found->second != key + 17) ++missing;
  }
  std::printf("host_map_entries=%zu missing_or_corrupt=%u host_hash_42=%zu\n",
              values.size(), missing, std::hash<unsigned>{}(42));
  return missing;
}

#ifdef PROBE_STANDALONE
int main() { return probe_host_map() == 0 ? 0 : 1; }
#endif
