#include "OllamaClient.h"
#include <nlohmann/json.hpp>
#include <string>

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <winhttp.h>
#include <memory>

namespace {
struct HttpCloser {
    void operator()(void* handle) const {
        if (handle) WinHttpCloseHandle(handle);
    }
};
using HttpHandle = std::unique_ptr<void, HttpCloser>;

std::string PostOllama(const std::string& body) {
    HttpHandle session(WinHttpOpen(L"WORLD_DEFINITION/2.0",
        WINHTTP_ACCESS_TYPE_NO_PROXY, WINHTTP_NO_PROXY_NAME,
        WINHTTP_NO_PROXY_BYPASS, 0));
    if (!session) return "";
    if (!WinHttpSetTimeouts(session.get(), 5000, 5000, 10000, 120000)) return "";

    HttpHandle connection(WinHttpConnect(session.get(), L"127.0.0.1", 11434, 0));
    if (!connection) return "";
    HttpHandle request(WinHttpOpenRequest(connection.get(), L"POST", L"/api/generate",
        nullptr, WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, 0));
    if (!request) return "";

    const DWORD bytes = static_cast<DWORD>(body.size());
    if (!WinHttpSendRequest(request.get(),
        L"Content-Type: application/json; charset=utf-8\r\n",
        static_cast<DWORD>(-1), const_cast<char*>(body.data()), bytes, bytes, 0)) return "";
    if (!WinHttpReceiveResponse(request.get(), nullptr)) return "";

    DWORD status = 0;
    DWORD statusSize = sizeof(status);
    if (!WinHttpQueryHeaders(request.get(),
        WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
        WINHTTP_HEADER_NAME_BY_INDEX, &status, &statusSize,
        WINHTTP_NO_HEADER_INDEX) || status != 200) return "";

    std::string response;
    char buffer[4096];
    for (;;) {
        DWORD count = 0;
        if (!WinHttpReadData(request.get(), buffer, sizeof(buffer), &count)) return "";
        if (count == 0) break;
        if (response.size() + count > 1024 * 1024) return "";
        response.append(buffer, count);
    }
    return response;
}
} // namespace

#else
// macOS and Linux use libcurl instead of Windows-only WinHTTP.
#include <curl/curl.h>
#include <mutex>

namespace {
struct ResponseBuffer {
    std::string data;
    bool overflow = false;
};

size_t ReceiveCurl(char* ptr, size_t size, size_t count, void* user) {
    auto* output = static_cast<ResponseBuffer*>(user);
    const size_t bytes = size * count;
    if (bytes > 1024 * 1024 - output->data.size()) {
        output->overflow = true;
        return 0;
    }
    output->data.append(ptr, bytes);
    return bytes;
}

std::string PostOllama(const std::string& body) {
    static std::once_flag initFlag;
    static bool curlReady = false;
    std::call_once(initFlag, []() {
        curlReady = (curl_global_init(CURL_GLOBAL_DEFAULT) == CURLE_OK);
    });
    if (!curlReady) return "";

    CURL* curl = curl_easy_init();
    if (!curl) return "";

    curl_slist* headers = nullptr;
    headers = curl_slist_append(headers, "Content-Type: application/json; charset=utf-8");
    ResponseBuffer response;

    curl_easy_setopt(curl, CURLOPT_URL, "http://127.0.0.1:11434/api/generate");
    curl_easy_setopt(curl, CURLOPT_POST, 1L);
    curl_easy_setopt(curl, CURLOPT_POSTFIELDS, body.c_str());
    curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, static_cast<long>(body.size()));
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, headers);
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, ReceiveCurl);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &response);
    curl_easy_setopt(curl, CURLOPT_CONNECTTIMEOUT_MS, 5000L);
    curl_easy_setopt(curl, CURLOPT_TIMEOUT_MS, 120000L);
    curl_easy_setopt(curl, CURLOPT_NOSIGNAL, 1L);
    curl_easy_setopt(curl, CURLOPT_PROXY, "");  // Never proxy the local AI call.

    const CURLcode result = curl_easy_perform(curl);
    long status = 0;
    curl_easy_getinfo(curl, CURLINFO_RESPONSE_CODE, &status);
    curl_slist_free_all(headers);
    curl_easy_cleanup(curl);

    if (result != CURLE_OK || status != 200 || response.overflow) return "";
    return response.data;
}
} // namespace
#endif

std::string OllamaClient::GenerateRuleJson(const std::string& instruction) const {
    if (instruction.empty() || instruction.size() > 4096) return "";

    const nlohmann::json payload = {
        {"model", "qwen3.5:4b"},
        {"system",
         "You design combinations of game powers. Input is a JSON object with "
         "target and effects. Respond ONLY as one JSON object with these keys: "
         "target, effects, name, description. Copy target and the complete effects "
         "array from the input exactly; do not change, omit, or add any effects. "
         "Invent an imaginative power name and a brief description of how the "
         "selected actions combine. Use short ASCII English text for name "
         "(max 35 characters) and description (max 100 characters). "
         "The game safely implements effects itself; do not generate code. "
         "Example: input {\"target\":\"stone\",\"effects\":[\"float\",\"move\"]} "
         "returns {\"target\":\"stone\",\"effects\":[\"float\",\"move\"],"
         "\"name\":\"Flying Stone\",\"description\":\"The stone flies as it moves through the air.\"}."},
        {"prompt", instruction},
        {"stream", false},
        {"think", false},
        {"format", "json"},
        {"options", {{"temperature", 0.3}, {"num_predict", 180}}}
    };

    const std::string rawResponse = PostOllama(payload.dump());
    if (rawResponse.empty()) return "";

    const auto result = nlohmann::json::parse(rawResponse, nullptr, false);
    if (!result.is_object() || !result.contains("done") ||
        result["done"] != true || !result.contains("response") ||
        !result["response"].is_string()) return "";
    return result["response"].get<std::string>();
}
