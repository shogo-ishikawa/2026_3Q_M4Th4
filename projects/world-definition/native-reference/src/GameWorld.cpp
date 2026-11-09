#include "GameWorld.h"
#include "JapaneseUI.h"

#include <cmath>

namespace {
constexpr float kLeft = 55.0f;
constexpr float kTop = 115.0f;
constexpr float kWidth = 760.0f;
constexpr float kHeight = 545.0f;
constexpr float kRiverTop = 350.0f;
constexpr float kCell = 40.0f;
constexpr int kRiverColumns = 19;
constexpr int kRiverRows = 2;
constexpr float kPlayerRadius = 13.0f;
constexpr float kPlayerSpeed = 215.0f;
constexpr Vector2 kStart{425.0f, 565.0f};
constexpr Rectangle kGoal{370.0f, 155.0f, 110.0f, 68.0f};
constexpr Rectangle kWallLeft{55, 270, 300, 22};
constexpr Rectangle kGate{355, 270, 140, 22};
constexpr Rectangle kWallRight{495, 270, 320, 22};
constexpr Vector2 kCore{245, 316};

const Color kLand{79, 122, 88, 255};
const Color kWater{99, 177, 211, 255};
const Color kSolidWater{186, 232, 228, 255};
const Color kOutline{188, 213, 166, 255};


}

GameWorld::GameWorld() { Reset(); }

void GameWorld::Reset() {
    player_ = kStart;
    elapsed_ = 0.0f;
    complete_ = false;
    coreCollected_ = false;
    gateUnlocked_ = false;
    gateHeat_ = 0.0f;
    fireHitTimer_ = 0.0f;
    stonePos_ = Vector2{650.0f, 520.0f};
    treePos_ = Vector2{235.0f, 535.0f};
    stoneFloating_ = treeFloating_ = false;
    stoneGrowing_ = treeGrowing_ = false;
}

Vector2 GameWorld::PlayerPosition() const { return player_; }
bool GameWorld::IsComplete() const { return complete_; }
bool GameWorld::HasCore() const { return coreCollected_; }
// METAL_HEAT_GATE_V1
static bool HasHeatAbility(const RuleEngine& rules) {
    return rules.HasEffect(RuleTarget::Fire, RuleEffect::Heat);
}

bool GameWorld::IsBridgeAt(Vector2 position, const RuleEngine&) const {
    const bool stoneReady =
        stoneFloating_ && stonePos_.y >= 362.0f &&
        stonePos_.y <= 418.0f;
    const bool treeReady =
        treeFloating_ && treePos_.y >= 362.0f &&
        treePos_.y <= 418.0f;

    const float stoneHalf = stoneGrowing_ ? 57.0f : 37.0f;
    const float treeHalf = treeGrowing_ ? 55.0f : 35.0f;

    return (stoneReady &&
            position.x >= stonePos_.x - stoneHalf &&
            position.x <= stonePos_.x + stoneHalf) ||
           (treeReady &&
            position.x >= treePos_.x - treeHalf &&
            position.x <= treePos_.x + treeHalf);
}

bool GameWorld::CanOccupy(Vector2 nextPosition, const RuleEngine& rules) const {
    if (nextPosition.x - kPlayerRadius < kLeft ||
        nextPosition.x + kPlayerRadius > kLeft + kWidth ||
        nextPosition.y - kPlayerRadius < kTop ||
        nextPosition.y + kPlayerRadius > kTop + kHeight) return false;

    const Rectangle playerBounds{nextPosition.x - kPlayerRadius,
        nextPosition.y - kPlayerRadius, 2.0f * kPlayerRadius, 2.0f * kPlayerRadius};

    if (CheckCollisionRecs(playerBounds, kWallLeft) ||
        CheckCollisionRecs(playerBounds, kWallRight) ||
        (!gateUnlocked_ &&
         CheckCollisionRecs(playerBounds, kGate))) {
        return false;
    }

    // TREE_FIRE_COLLISION_V1
    // The floating tree is walkable when used as a bridge.
    const bool treePlatform =
        treeFloating_ &&
        treePos_.y >= 362.0f &&
        treePos_.y <= 418.0f;

    if (!treePlatform) {
        // Brown trunk only: green leaves have no collision.
        const float scale = treeGrowing_ ? 1.5f : 1.0f;

        const float lift = treeFloating_
            ? 15.0f + 5.0f * std::sin(elapsed_ * 3.0f)
            : 0.0f;

        const bool moving = rules.HasEffect(
            RuleTarget::Tree, RuleEffect::Move);

        const float tx = treePos_.x +
            (!treeFloating_ && moving
                ? 8.0f * std::sin(elapsed_ * 2.0f)
                : 0.0f);

        const float baseY = treePos_.y - lift;

        const Rectangle trunk{
    tx - 8.0f,
    baseY - 23.0f * scale,
    16.0f,
    23.0f * scale
};

        if (CheckCollisionCircleRec(nextPosition, kPlayerRadius, trunk)) {
            return false;
        }
    }

    // STONE_COLLISION_V1

    // A stone placed in the river becomes a walkable platform.
    const bool stoneIsBridge =
        stoneFloating_ &&
        stonePos_.y >= 362.0f &&
        stonePos_.y <= 418.0f;

    if (!stoneIsBridge) {

        const bool moving =
            rules.HasEffect(
                RuleTarget::Stone,
                RuleEffect::Move
            );

        const bool solid =
            rules.HasEffect(
                RuleTarget::Stone,
                RuleEffect::Solidify
            );

        // Match the stone's displayed position.
        const float sx = stonePos_.x +
            (!stoneFloating_ && moving
                ? 8.0f * std::sin(elapsed_ * 1.7f)
                : 0.0f);

        const float sy = stonePos_.y -
            (stoneFloating_
                ? 15.0f +
                  5.0f * std::sin(elapsed_ * 3.0f)
                : 0.0f);

        // Match the stone's displayed radius.
        const float radius = stoneGrowing_
            ? 36.0f
            : (solid ? 27.0f : 20.0f);

        if (CheckCollisionCircles(
                nextPosition,
                kPlayerRadius,
                Vector2{sx, sy},
                radius)) {

            return false;
        }
    }

    for (int row = 0; row < kRiverRows; ++row) {
        for (int col = 0; col < kRiverColumns; ++col) {
            const float x = kLeft + col * kCell;
            const float y = kRiverTop + row * kCell;
            const Rectangle tile{x, y, kCell, kCell};
            if (CheckCollisionRecs(playerBounds, tile)) {
                const Vector2 tileCenter{x + kCell * 0.5f, y + kCell * 0.5f};
                // Width check keeps the player entirely on a generated bridge.
                if (!rules.WaterIsSolidAt(tileCenter, nextPosition) &&
                    !(IsBridgeAt(Vector2{nextPosition.x - kPlayerRadius, nextPosition.y}, rules) &&
                      IsBridgeAt(Vector2{nextPosition.x + kPlayerRadius, nextPosition.y}, rules))) {
                    return false;
                }
            }
        }
    }
    return true;
}

void GameWorld::Update(float deltaTime, const RuleEngine& rules) {
    elapsed_ += deltaTime;
    fireHitTimer_ = std::fmax(0.0f, fireHitTimer_ - deltaTime);

    stoneFloating_ |= rules.HasEffect(
        RuleTarget::Stone, RuleEffect::Float);
    treeFloating_ |= rules.HasEffect(
        RuleTarget::Tree, RuleEffect::Float);
    stoneGrowing_ |= rules.HasEffect(
        RuleTarget::Stone, RuleEffect::Grow);
    treeGrowing_ |= rules.HasEffect(
        RuleTarget::Tree, RuleEffect::Grow);
    if (complete_) return;
    Vector2 movement{0.0f, 0.0f};
    if (IsKeyDown(KEY_A) || IsKeyDown(KEY_LEFT)) movement.x -= 1.0f;
    if (IsKeyDown(KEY_D) || IsKeyDown(KEY_RIGHT)) movement.x += 1.0f;
    if (IsKeyDown(KEY_W) || IsKeyDown(KEY_UP)) movement.y -= 1.0f;
    if (IsKeyDown(KEY_S) || IsKeyDown(KEY_DOWN)) movement.y += 1.0f;

    const float magnitude = std::sqrt(movement.x * movement.x + movement.y * movement.y);
    if (magnitude > 0.0f) { movement.x /= magnitude; movement.y /= magnitude; }
    const float dt = (deltaTime < 0.03f) ? deltaTime : 0.03f;

    if (IsKeyDown(KEY_E) && magnitude > 0.0f) {
        auto distance2 = [this](Vector2 p) {
            float x = p.x - player_.x;
            float y = p.y - player_.y;
            return x * x + y * y;
        };

        Vector2* active = nullptr;
        float distance = 115.0f * 115.0f;

        if (stoneFloating_ && distance2(stonePos_) <= distance) {
            distance = distance2(stonePos_);
            active = &stonePos_;
        }

        if (treeFloating_ && distance2(treePos_) <= distance) {
            active = &treePos_;
        }

        if (active) {
            const float speed = 180.0f * dt;

            active->x = std::fmax(
                kLeft + 30.0f,
                std::fmin(kLeft + kWidth - 30.0f,
                          active->x + movement.x * speed));

            active->y = std::fmax(
                kTop + 30.0f,
                std::fmin(kTop + kHeight - 30.0f,
                          active->y + movement.y * speed));
        }
    }

    // Snap a floating object into a stable river platform.
    if (!IsKeyDown(KEY_E)) {
        if (stoneFloating_ &&
            stonePos_.y >= 362.0f && stonePos_.y <= 418.0f) {
            stonePos_.y = 390.0f;
        }

        if (treeFloating_ &&
            treePos_.y >= 362.0f && treePos_.y <= 418.0f) {
            treePos_.y = 390.0f;
        }
    }
    const float dx = movement.x * kPlayerSpeed * dt;
    const float dy = movement.y * kPlayerSpeed * dt;
    const Vector2 moveX{player_.x + dx, player_.y};
    if (CanOccupy(moveX, rules)) player_ = moveX;
    const Vector2 moveY{player_.x, player_.y + dy};
    if (CanOccupy(moveY, rules)) player_ = moveY;
    // Fire damages the player unless it is frozen.
    if (!rules.HasEffect(RuleTarget::Fire, RuleEffect::Freeze)) {
        const bool moving =
            rules.HasEffect(RuleTarget::Fire, RuleEffect::Move);
        const bool floating =
            rules.HasEffect(RuleTarget::Fire, RuleEffect::Float);
        const bool growing =
            rules.HasEffect(RuleTarget::Fire, RuleEffect::Grow);
        const bool pulsing =
            rules.HasEffect(RuleTarget::Fire, RuleEffect::Pulse);

        const float fx = 680.0f +
            (moving ? 28.0f * std::sin(elapsed_ * 2.4f) : 0.0f);

        const float fy = 260.0f -
            (floating ? 27.0f +
             10.0f * std::sin(elapsed_ * 2.6f) : 0.0f);

        const float radius =
            (growing ? 31.0f : 20.0f) +
            (pulsing ? 6.0f * std::sin(elapsed_ * 6.0f) : 0.0f);

        if (CheckCollisionCircles(
                player_, kPlayerRadius,
                Vector2{fx, fy}, radius)) {
            player_ = kStart;
            fireHitTimer_ = 2.0f;
            return;
        }
    }
    if (CheckCollisionCircles(player_, kPlayerRadius, kCore, 20.0f)) {
        coreCollected_ = true;
    }
    // Fire + Grow heats the gate's thermal lock.
    if (coreCollected_ && !gateUnlocked_ &&
        HasHeatAbility(rules)) {

        const float gateX = kGate.x + kGate.width * 0.5f;
        const float gateY = kGate.y + kGate.height * 0.5f;
        const float dx = player_.x - gateX;
        const float dy = player_.y - gateY;

        const bool nearGate =
            dx * dx + dy * dy < 105.0f * 105.0f;

        if (nearGate && IsKeyDown(KEY_E)) {
            gateHeat_ += deltaTime * 0.8f;

            if (gateHeat_ >= 1.0f) {
                gateHeat_ = 1.0f;
                gateUnlocked_ = true;
            }
        }
    }
    if (gateUnlocked_ &&
        CheckCollisionCircleRec(player_, kPlayerRadius, kGoal)) {
        complete_ = true;
    }
}

void GameWorld::DrawWater(const RuleEngine& rules) const {
    const bool glow = rules.HasEffect(RuleTarget::Water, RuleEffect::Glow);
    const bool move = rules.HasEffect(RuleTarget::Water, RuleEffect::Move);
    const bool pulse = rules.HasEffect(RuleTarget::Water, RuleEffect::Pulse);
    const bool grow = rules.HasEffect(RuleTarget::Water, RuleEffect::Grow);
    const bool freeze = rules.HasEffect(RuleTarget::Water, RuleEffect::Freeze);
    for (int row = 0; row < kRiverRows; ++row) {
        for (int col = 0; col < kRiverColumns; ++col) {
            const float x = kLeft + col * kCell;
            const float y = kRiverTop + row * kCell;
            const Vector2 center{x + kCell * 0.5f, y + kCell * 0.5f};
            const bool solid = rules.WaterIsSolidAt(center, player_);
            Color color = solid ? kSolidWater : kWater;
            if (glow && !solid) color = Color{35, 190, 210, 255};
            if (pulse && !solid && std::sin(elapsed_ * 5 + col * 0.4f) > 0) color = Color{58, 153, 215, 255};
            if (grow && !solid) color = Color{65, 128, 205, 255};
            if (freeze) color = Color{159, 233, 247, 255};
            DrawRectangle(static_cast<int>(x), static_cast<int>(y),
                static_cast<int>(kCell), static_cast<int>(kCell), color);
            DrawRectangleLines(static_cast<int>(x), static_cast<int>(y),
                static_cast<int>(kCell), static_cast<int>(kCell),
                solid ? Color{204, 251, 250, 255} : Color{34, 112, 170, 255});
            if (move) {
                const int waveY = static_cast<int>(y + 19 + 7 * std::sin(elapsed_ * 3 + col));
                DrawLine(static_cast<int>(x + 8), waveY, static_cast<int>(x + 30), waveY,
                         Color{190, 236, 255, 255});
            }
        }
    }
    if (rules.HasEffect(RuleTarget::Water, RuleEffect::Float)) {
        const float lift = 10 + 10 * std::sin(elapsed_ * 3.0f);
        for (int i = 0; i < 9; ++i) {
            DrawCircle(100 + i * 80, static_cast<int>(382 - lift), 9, Color{180, 230, 255, 255});
        }
    }
    DrawJapaneseText(freeze ? "FROZEN RIVER - WALK ACROSS" : "RIVER", 67, 373, freeze ? 18 : 20, WHITE);
}

void GameWorld::DrawObjects(const RuleEngine& rules) const {
    // Floating objects become platforms when placed in the river.
    auto drawPlatform = [](Vector2 pos, bool floating,
                           bool growing, Color color) {
        if (!floating ||
            pos.y < 362.0f || pos.y > 418.0f) return;

        const float half = growing ? 55.0f : 35.0f;
        const Rectangle bridge{
            pos.x - half, 342.0f, half * 2.0f, 96.0f
        };

        DrawRectangleRounded(bridge, 0.14f, 8, color);
        DrawRectangleRoundedLinesEx(
            bridge, 0.14f, 8, 2.0f, WHITE);

        for (int yy = 351; yy < 434; yy += 18) {
            DrawLine(
                static_cast<int>(pos.x - half + 7), yy,
                static_cast<int>(pos.x + half - 7), yy,
                Color{75, 92, 80, 255}
            );
        }
    };

    drawPlatform(stonePos_, stoneFloating_, stoneGrowing_,
                 Color{153, 165, 171, 255});

    drawPlatform(treePos_, treeFloating_, treeGrowing_,
                 Color{166, 131, 82, 255});
    // Stone. FLOAT+GROW also creates a new stone bridge.
    const bool stoneFloat = rules.HasEffect(RuleTarget::Stone, RuleEffect::Float);
    const bool stoneMove = rules.HasEffect(RuleTarget::Stone, RuleEffect::Move);
    const bool stoneGrow = stoneGrowing_;
    const bool stoneGlow = rules.HasEffect(RuleTarget::Stone, RuleEffect::Glow);
    const bool stonePulse = rules.HasEffect(RuleTarget::Stone, RuleEffect::Pulse);
    const bool stoneFreeze = rules.HasEffect(RuleTarget::Stone, RuleEffect::Freeze);
    const bool stoneSolid = rules.HasEffect(RuleTarget::Stone, RuleEffect::Solidify);
    const float sx = stonePos_.x + (!stoneFloating_ && stoneMove ? 8 * std::sin(elapsed_ * 1.7f) : 0);
    const float sy = stonePos_.y - (stoneFloat || stoneFloating_ ? 15 + 5 * std::sin(elapsed_ * 3) : 0);
    const float sr = stoneGrow ? 36.0f : (stoneSolid ? 27.0f : 20.0f);
    if (stoneGlow || stonePulse) {
        DrawCircleLines(static_cast<int>(sx), static_cast<int>(sy),
            sr + 7 + (stonePulse ? 6 * std::sin(elapsed_ * 5) : 0), GOLD);
    }
    DrawCircle(static_cast<int>(sx), static_cast<int>(sy), sr,
        stoneFreeze ? SKYBLUE : (stoneGlow ? Color{249, 211, 109, 255} : GRAY));
    DrawCircleLines(static_cast<int>(sx), static_cast<int>(sy), sr, DARKGRAY);
    DrawJapaneseText("STONE", static_cast<int>(sx - 30), static_cast<int>(sy + sr + 8), 15, WHITE);

    // Tree with variable height and movement.
    const bool treeGrow = treeGrowing_;
    const bool treeFloat = rules.HasEffect(RuleTarget::Tree, RuleEffect::Float);
    const bool treeMove = rules.HasEffect(RuleTarget::Tree, RuleEffect::Move);
    const bool treeGlow = rules.HasEffect(RuleTarget::Tree, RuleEffect::Glow);
    const bool treeFreeze = rules.HasEffect(RuleTarget::Tree, RuleEffect::Freeze);
    const bool treePulse = rules.HasEffect(RuleTarget::Tree, RuleEffect::Pulse);
    const float tx = treePos_.x + (!treeFloating_ && treeMove ? 8 * std::sin(elapsed_ * 2) : 0);
    const float ty = treePos_.y - (treeFloat || treeFloating_ ? 15 + 5 * std::sin(elapsed_ * 3) : 0);
    const float scale = treeGrow ? 1.5f : 1.0f;
    DrawRectangle(static_cast<int>(tx - 8), static_cast<int>(ty - 55 * scale),
                  16, static_cast<int>(55 * scale), Color{132, 92, 55, 255});
    if (treeGlow || treePulse) DrawCircleLines(static_cast<int>(tx),
        static_cast<int>(ty - 57 * scale), 42 * scale + (treePulse ? 8 * std::sin(elapsed_ * 4) : 0), GOLD);
    DrawCircle(static_cast<int>(tx), static_cast<int>(ty - 57 * scale), 34 * scale,
               treeFreeze ? SKYBLUE : (treeGlow ? LIME : DARKGREEN));
    DrawJapaneseText("TREE", static_cast<int>(tx - 20), static_cast<int>(ty + 10), 15, WHITE);

    // Fire with clear animated response to selected effects.
    const bool fireFloat = rules.HasEffect(RuleTarget::Fire, RuleEffect::Float);
    const bool fireMove = rules.HasEffect(RuleTarget::Fire, RuleEffect::Move);
    const bool fireGrow = rules.HasEffect(RuleTarget::Fire, RuleEffect::Grow);
    const bool fireGlow = rules.HasEffect(RuleTarget::Fire, RuleEffect::Glow);
    const bool fireFreeze = rules.HasEffect(RuleTarget::Fire, RuleEffect::Freeze);
    const bool firePulse = rules.HasEffect(RuleTarget::Fire, RuleEffect::Pulse);
    const float fx = 680 + (fireMove ? 28 * std::sin(elapsed_ * 2.4f) : 0);
    const float fy = 260 - (fireFloat ? 27 + 10 * std::sin(elapsed_ * 2.6f) : 0);
    const float fr = (fireGrow ? 31.0f : 20.0f) + (firePulse ? 6 * std::sin(elapsed_ * 6) : 0);
    if (fireGlow) DrawCircleLines(static_cast<int>(fx), static_cast<int>(fy), fr + 12, GOLD);
    DrawCircle(static_cast<int>(fx), static_cast<int>(fy), fr,
        fireFreeze ? BLUE : (fireGlow ? GOLD : ORANGE));
    DrawCircle(static_cast<int>(fx), static_cast<int>(fy + 3), fr * 0.55f,
        fireFreeze ? SKYBLUE : YELLOW);
    DrawJapaneseText("FIRE", static_cast<int>(fx - 18), static_cast<int>(fy + fr + 8), 15, WHITE);
}

void GameWorld::Draw(const RuleEngine& rules) const {
    DrawRectangle(static_cast<int>(kLeft), static_cast<int>(kTop),
                  static_cast<int>(kWidth), static_cast<int>(kHeight), kLand);
    DrawRectangleLinesEx(Rectangle{kLeft, kTop, kWidth, kHeight}, 3.0f, kOutline);
    DrawRectangleRec(kGoal, Color{187, 216, 148, 255});
    DrawJapaneseText("GOAL", 390, 178, 24, Color{17, 50, 32, 255});
    DrawWater(rules);
    DrawObjects(rules);
    if (fireHitTimer_ > 0.0f) {
        DrawRectangleRounded(
            Rectangle{267.0f, 222.0f, 350.0f, 46.0f},
            0.15f, 8,
            Color{140, 48, 37, 240}
        );
        DrawJapaneseText(
            "FIRE HIT - RESPAWN",
            291, 231, 22, WHITE
        );
    }
    if (!coreCollected_) {
        float bob = 4.0f * sinf(elapsed_ * 3.2f);
        DrawCircle(245, static_cast<int>(316 + bob), 23, SKYBLUE);
        DrawPoly(Vector2{245, 316 + bob}, 4, 14, 45, BLUE);
        DrawJapaneseText("POWER CORE", 184, 330, 16, WHITE);
    } else {
        DrawJapaneseText("CORE ACQUIRED!", 85, 312, 18, LIME);
    }

    DrawRectangleRec(kWallLeft, DARKGRAY);
    DrawRectangleRec(kWallRight, DARKGRAY);

    bool opened = gateUnlocked_;
    if (!opened) {
        DrawCircle(370, 281, 4, LIGHTGRAY);
        DrawCircle(480, 281, 4, LIGHTGRAY);

        DrawRectangle(355, 305, 140, 10, DARKGRAY);
        DrawRectangle(
            355, 305,
            static_cast<int>(140.0f * gateHeat_),
            10, ORANGE
        );

        if (coreCollected_ && HasHeatAbility(rules)) {
            DrawJapaneseText(
                "HOLD E TO HEAT",
                345, 322, 17, WHITE
            );
        }
    }
    DrawRectangleRec(kGate, opened ? DARKGREEN : Color{85, 100, 110, 255});
    DrawRectangleLinesEx(kGate, 2, opened ? LIME : ORANGE);
    DrawJapaneseText(opened ? "OPEN" : "METAL LOCK", 383, 271, 18, WHITE);

    DrawRectangle(65, 122, 300, 84, Color{15, 30, 37, 240});
    DrawJapaneseText("STAGE 1 : SEALED GOAL", 75, 130, 18, SKYBLUE);

    if (player_.y > 350) {
        DrawJapaneseText("1. CROSS THE RIVER", 75, 159, 17, WHITE);
    } else if (!coreCollected_) {
        DrawJapaneseText("2. COLLECT THE CORE", 75, 159, 17, YELLOW);
    } else if (!opened) {
        DrawJapaneseText("3. FIRE + HEAT", 75, 159, 17, YELLOW);
        DrawJapaneseText("HOLD E TO HEAT", 75, 181, 15, WHITE);
    } else {
        DrawJapaneseText("GATE OPEN! REACH GOAL", 75, 159, 17, LIME);
    }
    if (rules.WaterRuleEnabled() && !rules.HasEffect(RuleTarget::Water, RuleEffect::Freeze) &&
        !rules.HasEffect(RuleTarget::Water, RuleEffect::Bridge)) {
        DrawCircleLines(static_cast<int>(player_.x), static_cast<int>(player_.y),
                        rules.WaterRuleRadius(), Color{144, 235, 220, 170});
    }
    DrawCircleV(player_, kPlayerRadius, Color{245, 208, 105, 255});
    DrawCircleLines(static_cast<int>(player_.x), static_cast<int>(player_.y),
                    kPlayerRadius, Color{70, 52, 27, 255});
    if ((stoneFloating_ || treeFloating_) && !complete_) {
        DrawJapaneseText(
            "E + WASD : MOVE FLOATING OBJECT",
            260, 630, 17, WHITE
        );
    }
    // TREE_CANOPY_LAYER_V1
    // Draw the leaves over the player when behind the tree.
    {
        const bool treePlatform =
            treeFloating_ &&
            treePos_.y >= 362.0f &&
            treePos_.y <= 418.0f;

        const bool moving =
            rules.HasEffect(RuleTarget::Tree, RuleEffect::Move);

        const bool floating =
            rules.HasEffect(RuleTarget::Tree, RuleEffect::Float);

        const bool glowing =
            rules.HasEffect(RuleTarget::Tree, RuleEffect::Glow);

        const bool frozen =
            rules.HasEffect(RuleTarget::Tree, RuleEffect::Freeze);

        const float tx = treePos_.x +
            (!treeFloating_ && moving
                ? 8.0f * std::sin(elapsed_ * 2.0f)
                : 0.0f);

        const float ty = treePos_.y -
            (treeFloating_ || floating
                ? 15.0f + 5.0f * std::sin(elapsed_ * 3.0f)
                : 0.0f);

        const float scale = treeGrowing_ ? 1.5f : 1.0f;

        const Vector2 canopy{
            tx, ty - 57.0f * scale
        };

        const float radius = 34.0f * scale;

        if (!treePlatform &&
            player_.y < ty &&
            CheckCollisionCircles(
                player_, kPlayerRadius,
                canopy, radius)) {

            DrawCircleV(
                canopy,
                radius,
                frozen ? SKYBLUE :
                    (glowing ? LIME : DARKGREEN)
            );
        }
    }
    if (complete_) {
        DrawRectangle(160, 262, 540, 118, Color{15, 31, 35, 236});
        DrawJapaneseText("PUZZLE CLEAR!", 270, 281, 36, Color{176, 239, 197, 255});
        DrawJapaneseText("Press R to restart", 320, 335, 21, WHITE);
    }
}
