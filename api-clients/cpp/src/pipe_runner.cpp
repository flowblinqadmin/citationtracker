#include "ga_pipe/pipe_runner.hpp"

#include <atomic>
#include <condition_variable>
#include <curl/curl.h>
#include <iostream>
#include <memory>
#include <mutex>
#include <sstream>
#include <thread>

#include "ga_pipe/auth_client.hpp"
#include "ga_pipe/dead_letter.hpp"
#include "ga_pipe/flowblinq_reader.hpp"
#include "ga_pipe/logger.hpp"
#include "ga_pipe/page_view_queue.hpp"
#include "ga_pipe/response_validator.hpp"
#include "ga_pipe/sink.hpp"
#include "ga_pipe/sink_template.hpp"
#include "ga_pipe/state_file.hpp"

namespace ga_pipe {
namespace {

std::size_t curlWriteCb(void* p, std::size_t s, std::size_t n, void* u) {
  static_cast<std::string*>(u)->append(static_cast<char*>(p), s * n);
  return s * n;
}

struct PostResult { long status{0}; std::string body; std::string headers; };

PostResult httpPost(const RenderedRequest& req) {
  CURL* c = curl_easy_init();
  PostResult r;
  struct curl_slist* h = nullptr;
  for (const auto& [k, v] : req.headers) {
    h = curl_slist_append(h, (k + ": " + v).c_str());
  }
  curl_easy_setopt(c, CURLOPT_URL, req.url.c_str());
  curl_easy_setopt(c, CURLOPT_POST, 1L);
  curl_easy_setopt(c, CURLOPT_POSTFIELDS, req.body.c_str());
  curl_easy_setopt(c, CURLOPT_POSTFIELDSIZE, static_cast<long>(req.body.size()));
  curl_easy_setopt(c, CURLOPT_HTTPHEADER, h);
  curl_easy_setopt(c, CURLOPT_WRITEFUNCTION, curlWriteCb);
  curl_easy_setopt(c, CURLOPT_WRITEDATA, &r.body);
  curl_easy_setopt(c, CURLOPT_HEADERFUNCTION, curlWriteCb);
  curl_easy_setopt(c, CURLOPT_HEADERDATA, &r.headers);
  curl_easy_setopt(c, CURLOPT_TIMEOUT, 30L);
  curl_easy_perform(c);
  curl_easy_getinfo(c, CURLINFO_RESPONSE_CODE, &r.status);
  curl_slist_free_all(h);
  curl_easy_cleanup(c);
  return r;
}

std::string nowIso() {
  auto t = std::chrono::system_clock::to_time_t(std::chrono::system_clock::now());
  std::tm tm{}; gmtime_r(&t, &tm);
  char buf[32];
  std::snprintf(buf, sizeof(buf), "%04d-%02d-%02dT%02d:%02d:%02dZ",
                tm.tm_year+1900, tm.tm_mon+1, tm.tm_mday, tm.tm_hour, tm.tm_min, tm.tm_sec);
  return buf;
}

void advanceCursor(PipeState& s, const PageView& row) {
  s.cursor = Cursor{row.viewed_at, row.id};
}

void interruptibleSleep(int seconds, std::atomic<bool>& shutdown) {
  for (int i = 0; i < seconds * 10 && !shutdown.load(); ++i) {
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
  }
}

} // namespace

struct PipeRunner::Impl {
  PipeRunnerConfig cfg;
  Config           reader_cfg;       // owned; feeds FlowblinqReader's const Config&
  std::atomic<bool> shutdown{false};
  std::atomic<int>  exit_code{0};
  std::thread reader_th, writer_th;

  std::unique_ptr<AuthClient>       auth;
  std::unique_ptr<FlowblinqReader>  reader;
  std::unique_ptr<PageViewQueue>    queue;
  std::unique_ptr<SinkTemplate>     tmpl;
  std::unique_ptr<StateFile>        state;
  std::unique_ptr<DeadLetter>       dl;
  Logger                            log{std::cout, LogLevel::Info};

  std::condition_variable done_cv;
  std::mutex              done_mx;
  bool                    finished{false};

  void readerLoop(std::optional<Cursor> seed) {
    std::string cursor = seed.has_value() ? encodeCursor(*seed) : "";
    int consecutive_malformed = 0;
    while (!shutdown.load()) {
      ReadPage page;
      try {
        page = reader->readPage(cursor);
        consecutive_malformed = 0;
      } catch (const ValidationError& v) {
        log.error("reader.malformed_response", {
          {"reason", malformedReasonToStr(v.reason)},
          {"detail", v.detail},
          {"consecutive", ++consecutive_malformed},
        });
        if (consecutive_malformed >= cfg.malformed_response_threshold) {
          std::fprintf(stderr,
              "ga-pipe: received %d consecutive malformed responses from flowblinq; "
              "shutting down. Likely: API version mismatch, upstream outage, or wrong base_url.\n",
              consecutive_malformed);
          exit_code.store(3);
          shutdown.store(true);
          break;
        }
        interruptibleSleep(cfg.poll_interval_s > 0 ? cfg.poll_interval_s : 1, shutdown);
        continue;
      } catch (const std::exception& e) {
        log.error("reader.fatal", {{"err", e.what()}});
        exit_code.store(1);
        shutdown.store(true);
        break;
      }
      // Capture last-row cursor BEFORE the std::move loop below; after the
      // move, page.rows.back() has moved-from strings (undefined, typically
      // empty) and encoding from it would produce {"viewed_at":"","id":""}
      // which the server rejects with bad_cursor.
      std::optional<Cursor> last_row_cursor;
      if (!page.rows.empty() && !page.has_more) {
        last_row_cursor = Cursor{
            page.rows.back().viewed_at,
            page.rows.back().id,
        };
      }
      for (auto& row : page.rows) {
        if (!queue->push(std::move(row))) break;
      }
      if (page.has_more) {
        // Server issued a cursor positioned at the start of the next page.
        cursor = page.next_cursor;
      } else if (last_row_cursor.has_value()) {
        // Server says nothing more right now; it returns next_cursor=null in
        // that case. Advance local cursor PAST the last row of this page so
        // the next poll queries for rows strictly after it — otherwise the
        // reader loses position and next readPage("") defaults back to
        // now-72h, re-fetching + re-delivering everything every poll.
        // NOTE: captured BEFORE the std::move loop above, since moved-from
        // rows have undefined (typically empty) string values.
        cursor = encodeCursor(*last_row_cursor);
        interruptibleSleep(cfg.poll_interval_s, shutdown);
      } else {
        // Empty page and no more — just sleep; cursor stays put.
        interruptibleSleep(cfg.poll_interval_s, shutdown);
      }
    }
    queue->close();
  }

  void writerLoop() {
    PipeState s = state->load();
    std::map<std::string, std::string> env;
    env["FLOWBLINQ_DOMAIN"] = cfg.flowblinq_domain;
    // Merge sink secrets from pipe.yaml (e.g. GA4 measurement_id / api_secret).
    // These become top-level Inja variables in the sink template render.
    for (const auto& [k, v] : cfg.sink_secrets) env[k] = v;

    while (auto row_opt = queue->pop()) {
      const PageView& row = *row_opt;
      RenderedRequest req;
      try {
        req = tmpl->render(row, env);
      } catch (const ConstraintViolation& e) {
        dl->append(row, std::string("oversize/constraint: ") + e.what());
        s.deadletter_count_total++;
        advanceCursor(s, row);
        state->persist(s);
        continue;
      } catch (const std::exception& e) {
        dl->append(row, std::string("render_error: ") + e.what());
        s.deadletter_count_total++;
        advanceCursor(s, row);
        state->persist(s);
        continue;
      }

      bool delivered = false;
      for (int attempt = 0; attempt < tmpl->retryPolicy().max_attempts && !shutdown.load(); ++attempt) {
        auto result = httpPost(req);
        auto disposition = tmpl->classify(static_cast<int>(result.status));
        if (disposition == SinkTemplate::Disposition::Ok) {
          log.info("writer.sink_ok", {{"row_id", row.id}, {"status", result.status}});
          s.served_count_total++;
          s.last_successful_sink_ts = nowIso();
          advanceCursor(s, row);
          state->persist(s);
          delivered = true;
          break;
        }
        if (disposition == SinkTemplate::Disposition::NonRetriable) {
          break;
        }
        // Retriable: back off (interruptible — break out fast if shutdown fires)
        int wait_ms = pickBackoffMs(attempt, tmpl->retryPolicy(), std::nullopt);
        log.warn("writer.sink_retry",
                 {{"row_id", row.id}, {"attempt", attempt}, {"backoff_ms", wait_ms}, {"status", result.status}});
        for (int slept = 0; slept < wait_ms && !shutdown.load(); slept += 25) {
          std::this_thread::sleep_for(std::chrono::milliseconds(25));
        }
      }
      if (!delivered) {
        // Shutdown-induced abort: do NOT advance cursor — row re-delivers on next run
        // (at-least-once semantic, duplicates acceptable for analytics forwarding).
        // Budget-exhausted / non-retriable failures: deadletter + advance (give up).
        if (shutdown.load()) {
          log.warn("writer.shutdown_leave_undelivered", {{"row_id", row.id}});
          break;
        }
        dl->append(row, "retry_exhausted_or_non_retriable");
        s.deadletter_count_total++;
        advanceCursor(s, row);
        state->persist(s);
        log.warn("writer.deadletter", {{"row_id", row.id}});
      }
    }
    state->persist(s);
    {
      std::lock_guard<std::mutex> lk(done_mx);
      finished = true;
    }
    done_cv.notify_all();
  }
};

PipeRunner::PipeRunner(PipeRunnerConfig cfg) : m_impl(std::make_unique<Impl>()) {
  m_impl->cfg = std::move(cfg);
  curl_global_init(CURL_GLOBAL_DEFAULT);

  AuthClientParams ap;
  ap.base_url      = m_impl->cfg.flowblinq_base_url;
  ap.client_id     = m_impl->cfg.client_id;
  ap.client_secret = m_impl->cfg.client_secret;
  m_impl->auth  = std::make_unique<AuthClient>(std::move(ap));

  // Per-instance Config (NOT static — two PipeRunners must not share).
  m_impl->reader_cfg.flowblinq.base_url = m_impl->cfg.flowblinq_base_url;
  m_impl->reader_cfg.flowblinq.domain   = m_impl->cfg.flowblinq_domain;
  m_impl->reader = std::make_unique<FlowblinqReader>(m_impl->reader_cfg, *m_impl->auth);

  m_impl->queue = std::make_unique<PageViewQueue>(m_impl->cfg.queue_capacity);
  m_impl->tmpl  = std::make_unique<SinkTemplate>(SinkTemplate::loadFromYaml(m_impl->cfg.sink_yaml));
  m_impl->state = std::make_unique<StateFile>(m_impl->cfg.state_path);
  m_impl->dl    = std::make_unique<DeadLetter>(m_impl->cfg.deadletter_path);
}

PipeRunner::~PipeRunner() {
  requestShutdown();
  if (m_impl->reader_th.joinable()) m_impl->reader_th.join();
  if (m_impl->writer_th.joinable()) m_impl->writer_th.join();
}

void PipeRunner::start() {
  m_impl->log.info("pipe.start", {{"domain", m_impl->cfg.flowblinq_domain}});
  auto s = m_impl->state->load();
  m_impl->reader_th = std::thread(&Impl::readerLoop, m_impl.get(), s.cursor);
  m_impl->writer_th = std::thread(&Impl::writerLoop, m_impl.get());
}

void PipeRunner::requestShutdown() {
  m_impl->shutdown.store(true);
  m_impl->queue->close();
}

bool PipeRunner::waitForShutdown(std::chrono::seconds timeout) {
  // Use the tighter of (caller timeout, cfg.shutdown_deadline) as the bound.
  auto deadline = m_impl->cfg.shutdown_deadline;
  if (deadline.count() > 0 && deadline < timeout) timeout = deadline;

  std::unique_lock<std::mutex> lk(m_impl->done_mx);
  bool done = m_impl->done_cv.wait_for(lk, timeout, [&]{ return m_impl->finished; });
  lk.unlock();

  if (!done) {
    // Deadline exceeded. Force-close: detach threads (they'll complete but we
    // don't block), mark exit_code nonzero so caller sees force-close.
    if (m_impl->exit_code.load() == 0) m_impl->exit_code.store(1);
    if (m_impl->reader_th.joinable()) m_impl->reader_th.detach();
    if (m_impl->writer_th.joinable()) m_impl->writer_th.detach();
  } else {
    if (m_impl->reader_th.joinable()) m_impl->reader_th.join();
    if (m_impl->writer_th.joinable()) m_impl->writer_th.join();
  }
  m_impl->log.info("pipe.shutdown", {{"exit_code", m_impl->exit_code.load()}});
  return true;
}

int PipeRunner::exitCode() const { return m_impl->exit_code.load(); }

} // namespace ga_pipe
