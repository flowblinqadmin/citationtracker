#pragma once
#include <condition_variable>
#include <cstddef>
#include <deque>
#include <mutex>
#include <optional>

#include "ga_pipe/page_view.hpp"

namespace ga_pipe {

class PageViewQueue {
public:
  explicit PageViewQueue(std::size_t capacity);

  bool push(PageView v);
  std::optional<PageView> pop();
  void   close();
  std::size_t size() const;

private:
  const std::size_t         m_capacity;
  std::deque<PageView>      m_q;
  mutable std::mutex        m_mx;
  std::condition_variable   m_not_full;
  std::condition_variable   m_not_empty;
  bool                      m_closed{false};
};

} // namespace ga_pipe
