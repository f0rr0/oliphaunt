#pragma once

#include <algorithm>
#include <atomic>
#include <condition_variable>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <vector>

namespace oliphaunt::reactnative {

inline constexpr const char *invalidatedMessage =
    "React Native Oliphaunt module has been invalidated";

class ChunkAcknowledgement final {
 public:
  void resolve() { finish(std::nullopt); }
  void reject(std::string message) { finish(std::move(message)); }
  std::optional<std::string> wait()
  {
    std::unique_lock<std::mutex> lock(mutex_);
    condition_.wait(lock, [this] { return complete_; });
    return error_;
  }

 private:
  void finish(std::optional<std::string> error)
  {
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (complete_) return;
      error_ = std::move(error);
      complete_ = true;
    }
    condition_.notify_all();
  }
  std::mutex mutex_;
  std::condition_variable condition_;
  bool complete_ = false;
  std::optional<std::string> error_;
};

// One instance belongs to one installed RN runtime. Registering a wait and
// invalidating the owner share a lock, so teardown cannot miss a new waiter.
class RuntimeLifetime {
 public:
  bool active() const { return active_.load(); }
  std::shared_ptr<ChunkAcknowledgement> acknowledge()
  {
    auto result = std::make_shared<ChunkAcknowledgement>();
    std::lock_guard<std::mutex> lock(mutex_);
    if (!active_) {
      result->reject(invalidatedMessage);
      return result;
    }
    waits_.erase(std::remove_if(waits_.begin(), waits_.end(),
        [](const auto &entry) { return entry.expired(); }), waits_.end());
    waits_.emplace_back(result);
    return result;
  }
  void invalidate()
  {
    std::lock_guard<std::mutex> lock(mutex_);
    active_ = false;
    for (const auto &entry : waits_)
      if (auto wait = entry.lock()) wait->reject(invalidatedMessage);
    waits_.clear();
  }
  ~RuntimeLifetime() { invalidate(); }

 private:
  std::atomic<bool> active_{true};
  std::mutex mutex_;
  std::vector<std::weak_ptr<ChunkAcknowledgement>> waits_;
};

} // namespace oliphaunt::reactnative
