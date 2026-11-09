#pragma once

#include "raylib.h"
#include <string>
#include <vector>

// Only these game-defined targets and effects can be applied. AI never runs code.
enum class RuleTarget { Water, Stone, Tree, Fire };
enum class RuleEffect { Float, Move, Grow, Glow, Freeze, Solidify, Bridge, Pulse, Heat };

const char* TargetId(RuleTarget target);
const char* EffectId(RuleEffect effect);
const char* TargetLabel(RuleTarget target);
const char* EffectLabel(RuleEffect effect);

class RuleEngine {
public:
    // Validates that the AI response matches the actual selections.
    bool ApplyRuleJson(const std::string& jsonText, RuleTarget expectedTarget,
                       const std::vector<RuleEffect>& expectedEffects);
    bool HasEffect(RuleTarget target, RuleEffect effect) const;
    bool HasActiveRule() const;
    const std::string& RuleName() const;
    const std::string& RuleDescription() const;
    RuleTarget ActiveTarget() const;
    void ToggleWaterRule();
    void Reset();
    bool WaterIsSolidAt(Vector2 waterCellCenter, Vector2 playerPosition) const;
    bool WaterRuleEnabled() const;
    float WaterRuleRadius() const;

private:
    RuleTarget activeTarget_ = RuleTarget::Water;
    std::vector<RuleEffect> activeEffects_;
    std::string ruleName_ = "No AI rule";
    std::string ruleDescription_ = "Select effects and ask Ollama.";
    bool ruleActive_ = false;
    bool manualWaterRule_ = false;
    float waterRadius_ = 95.0f;
};
