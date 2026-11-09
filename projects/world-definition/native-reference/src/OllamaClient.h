#pragma once

#include <string>

class OllamaClient {
public:
    std::string GenerateRuleJson(const std::string& instruction) const;
};
