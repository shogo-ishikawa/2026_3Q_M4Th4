#pragma once

#include "RuleEngine.h"
#include "raylib.h"

class GameWorld {
public:
    GameWorld();
    void Reset();
    void Update(float deltaTime, const RuleEngine& rules);
    void Draw(const RuleEngine& rules) const;
    bool IsComplete() const;
    bool HasCore() const;
    Vector2 PlayerPosition() const;

private:
    bool CanOccupy(Vector2 nextPosition, const RuleEngine& rules) const;
    bool IsBridgeAt(Vector2 position, const RuleEngine& rules) const;
    void DrawWater(const RuleEngine& rules) const;
    void DrawObjects(const RuleEngine& rules) const;

    Vector2 player_{};
    Vector2 stonePos_{650.0f, 520.0f};
    Vector2 treePos_{235.0f, 535.0f};
    bool stoneFloating_ = false;
    bool treeFloating_ = false;
    bool stoneGrowing_ = false;
    bool treeGrowing_ = false;
    float elapsed_ = 0.0f;
    bool complete_ = false;
    bool coreCollected_ = false;
    bool gateUnlocked_ = false;
    float gateHeat_ = 0.0f;
    float fireHitTimer_ = 0.0f;
};
