#include "Lifecycle.h"
#include <cassert>
#include <chrono>
#include <future>
#include <thread>

using namespace oliphaunt::reactnative;
using namespace std::chrono_literals;

int main()
{
  auto first = std::make_shared<RuntimeLifetime>();
  auto second = std::make_shared<RuntimeLifetime>();
  auto firstWait = first->acknowledge();
  auto secondWait = second->acknowledge();
  auto blocked = std::async(std::launch::async, [firstWait] { return firstWait->wait(); });
  first->invalidate();
  assert(blocked.wait_for(2s) == std::future_status::ready);
  assert(blocked.get() == invalidatedMessage);
  assert(second->active());
  secondWait->resolve();
  secondWait->reject("late rejection must not replace successful delivery");
  assert(!secondWait->wait());
  assert(first->acknowledge()->wait() == invalidatedMessage);

  // A producer racing teardown must either be registered before invalidation
  // or immediately rejected. Neither outcome leaves a blocked native worker.
  for (int i = 0; i < 1000; ++i) {
    auto owner = std::make_shared<RuntimeLifetime>();
    auto work = std::async(std::launch::async, [owner] {
      return owner->acknowledge()->wait();
    });
    owner->invalidate();
    assert(work.wait_for(2s) == std::future_status::ready);
    assert(work.get() == invalidatedMessage);
  }

  auto abandonedOwner = std::make_shared<RuntimeLifetime>();
  auto abandonedWait = abandonedOwner->acknowledge();
  abandonedOwner.reset();
  assert(abandonedWait->wait() == invalidatedMessage);
}
