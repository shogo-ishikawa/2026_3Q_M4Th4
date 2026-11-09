#include "RuleEngine.h"

#include <algorithm>
#include <nlohmann/json.hpp>

const char* TargetId(RuleTarget target) {
    switch (target) {
    case RuleTarget::Water: return "water";
    case RuleTarget::Stone: return "stone";
    case RuleTarget::Tree: return "tree";
    case RuleTarget::Fire: return "fire";
    }
    return "water";
}

const char* EffectId(RuleEffect effect) {
    switch (effect) {
    case RuleEffect::Float: return "float";
    case RuleEffect::Move: return "move";
    case RuleEffect::Grow: return "grow";
    case RuleEffect::Glow: return "glow";
    case RuleEffect::Freeze: return "freeze";
    case RuleEffect::Solidify: return "solidify";
    case RuleEffect::Bridge: return "bridge";
    case RuleEffect::Pulse: return "pulse";
    case RuleEffect::Heat: return "heat";
    }
    return "float";
}

const char* TargetLabel(RuleTarget target) {
    switch (target) {
    case RuleTarget::Water: return "WATER";
    case RuleTarget::Stone: return "STONE";
    case RuleTarget::Tree: return "TREE";
    case RuleTarget::Fire: return "FIRE";
    }
    return "WATER";
}

const char* EffectLabel(RuleEffect effect) {
    switch (effect) {
    case RuleEffect::Float: return "FLOAT";
    case RuleEffect::Move: return "MOVE";
    case RuleEffect::Grow: return "GROW";
    case RuleEffect::Glow: return "GLOW";
    case RuleEffect::Freeze: return "FREEZE";
    case RuleEffect::Solidify: return "SOLIDIFY";
    case RuleEffect::Bridge: return "BRIDGE";
    case RuleEffect::Pulse: return "PULSE";
    case RuleEffect::Heat: return "HEAT";
    }
    return "FLOAT";
}

bool RuleEngine::ApplyRuleJson(const std::string& jsonText, RuleTarget expectedTarget,
                               const std::vector<RuleEffect>& expectedEffects) {
    if (jsonText.empty() || jsonText.size() > 4096 ||
        expectedEffects.empty() || expectedEffects.size() > 3) return false;

    const auto result = nlohmann::json::parse(jsonText, nullptr, false);
    if (!result.is_object() || !result.contains("target") ||
        !result.contains("effects") || !result.contains("name") ||
        !result["target"].is_string() || !result["effects"].is_array() ||
        !result["name"].is_string()) return false;

    if (result["target"].get<std::string>() != TargetId(expectedTarget) ||
        result["effects"].size() != expectedEffects.size()) return false;

    // Same effects are required (AI cannot secretly grant other abilities).
    std::vector<std::string> actual;
    for (const auto& element : result["effects"]) {
        if (!element.is_string()) return false;
        actual.push_back(element.get<std::string>());
    }
    std::vector<std::string> selected;
    for (const auto effect : expectedEffects) selected.emplace_back(EffectId(effect));
    std::sort(actual.begin(), actual.end());
    std::sort(selected.begin(), selected.end());
    if (actual != selected) return false;

    auto name = result["name"].get<std::string>();
    if (name.empty() || name.size() > 64) return false;
    std::string description = "AI combined selected effects.";
    if (result.contains("description") && result["description"].is_string()) {
        description = result["description"].get<std::string>();
        if (description.empty() || description.size() > 160) {
            description = "AI combined selected effects.";
        }
    }
    activeTarget_ = expectedTarget;
    activeEffects_ = expectedEffects;
    ruleName_ = std::move(name);
    ruleDescription_ = std::move(description);
    ruleActive_ = true;
    return true;
}

bool RuleEngine::HasEffect(RuleTarget target, RuleEffect effect) const {
    return ruleActive_ && activeTarget_ == target &&
           std::find(activeEffects_.begin(), activeEffects_.end(), effect) != activeEffects_.end();
}

bool RuleEngine::HasActiveRule() const { return ruleActive_; }
const std::string& RuleEngine::RuleName() const { return ruleName_; }
const std::string& RuleEngine::RuleDescription() const { return ruleDescription_; }
RuleTarget RuleEngine::ActiveTarget() const { return activeTarget_; }

void RuleEngine::ToggleWaterRule() { manualWaterRule_ = !manualWaterRule_; }

void RuleEngine::Reset() {
    activeTarget_ = RuleTarget::Water;
    activeEffects_.clear();
    ruleName_ = "No AI rule";
    ruleDescription_ = "Select effects and ask Ollama.";
    ruleActive_ = false;
    manualWaterRule_ = false;
}

bool RuleEngine::WaterIsSolidAt(Vector2 waterCellCenter, Vector2 playerPosition) const {
    if (HasEffect(RuleTarget::Water, RuleEffect::Freeze) ||
        HasEffect(RuleTarget::Water, RuleEffect::Bridge)) return true;
    if (!(manualWaterRule_ || HasEffect(RuleTarget::Water, RuleEffect::Solidify))) return false;
    const float dx = waterCellCenter.x - playerPosition.x;
    const float dy = waterCellCenter.y - playerPosition.y;
    return dx * dx + dy * dy <= waterRadius_ * waterRadius_;
}

bool RuleEngine::WaterRuleEnabled() const {
    return manualWaterRule_ || HasEffect(RuleTarget::Water, RuleEffect::Solidify) ||
           HasEffect(RuleTarget::Water, RuleEffect::Freeze) ||
           HasEffect(RuleTarget::Water, RuleEffect::Bridge);
}

float RuleEngine::WaterRuleRadius() const { return waterRadius_; }
