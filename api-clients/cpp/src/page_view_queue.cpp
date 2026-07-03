#include "ga_pipe/page_view_queue.hpp"

namespace ga_pipe {

PageViewQueue::PageViewQueue(std::size_t capacity) : m_capacity(capacity) {}

bool PageViewQueue::push(PageView v) {
  std::unique_lock<std::mutex> lk(m_mx);
  m_not_full.wait(lk, [&]{ return m_closed || m_q.size() < m_capacity; });
  if (m_closed) return false;
  m_q.push_back(std::move(v));
  m_not_empty.notify_one();
  return true;
}

std::optional<PageView> PageViewQueue::pop() {
  std::unique_lock<std::mutex> lk(m_mx);
  m_not_empty.wait(lk, [&]{ return m_closed || !m_q.empty(); });
  if (m_q.empty()) return std::nullopt;
  PageView v = std::move(m_q.front());
  m_q.pop_front();
  m_not_full.notify_one();
  return v;
}

void PageViewQueue::close() {
  {
    std::lock_guard<std::mutex> lk(m_mx);
    m_closed = true;
  }
  m_not_full.notify_all();
  m_not_empty.notify_all();
}

std::size_t PageViewQueue::size() const {
  std::lock_guard<std::mutex> lk(m_mx);
  return m_q.size();
}

} // namespace ga_pipe
