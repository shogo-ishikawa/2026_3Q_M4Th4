// NATURE_UI_V1
#include <cmath>
#include "raylib.h"
#include "JapaneseUI.h"
#include "GameWorld.h"
#include "RuleEngine.h"
#include "OllamaClient.h"

#include <array>
#include <chrono>
#include <future>
#include <string>
#include <vector>
#include <nlohmann/json.hpp>

namespace {
constexpr int kScreenWidth = 1200;
constexpr int kScreenHeight = 750;
constexpr std::array<RuleTarget, 4> kTargets{
    RuleTarget::Water, RuleTarget::Stone, RuleTarget::Tree, RuleTarget::Fire};
constexpr std::array<RuleEffect, 8> kEffects{
    RuleEffect::Float, RuleEffect::Move, RuleEffect::Grow, RuleEffect::Glow,
    RuleEffect::Freeze, RuleEffect::Solidify, RuleEffect::Pulse, RuleEffect::Heat};

bool Contains(const std::vector<RuleEffect>& effects, RuleEffect effect) {
    for (auto e : effects) if (e == effect) return true;
    return false;
}

void DrawChoice(Rectangle rect, const char* label,
                bool selected, bool disabled = false) {
    const Color bg = disabled
        ? Color{224, 228, 216, 255}
        : selected
            ? Color{182, 215, 160, 255}
            : Color{240, 245, 225, 255};

    DrawRectangleRounded(rect, 0.22f, 8, bg);
    DrawRectangleRoundedLinesEx(
        rect, 0.22f, 8,
        selected ? 3.0f : 1.5f,
        selected ? Color{65, 130, 78, 255}
                 : Color{159, 185, 150, 255}
    );

    DrawJapaneseText(
        label,
        static_cast<int>(rect.x + 19),
        static_cast<int>(rect.y + 9),
        25,
        Color{41, 70, 49, 255}
    );
}

std::string Truncate(const std::string& value, size_t length) {
    if (value.size() <= length) return value;
    return value.substr(0, length > 3 ? length - 3 : length) + "...";
}
}

// STAGE_VISUALS_V1
static void DrawStageVisuals(
    const GameWorld& world,
    double now,
    double lastPowerTime)
{
    const float t = static_cast<float>(now);

    // Decorative grass and terrain details
    for (int i = 0; i < 90; ++i) {
        const int x = 72 + (i * 137) % 720;
        const int y = 128 + (i * 193) % 515;

        if (y > 340 && y < 444) continue;
        if (y > 265 && y < 330) continue;

        const float pulse =
            0.55f + 0.45f * std::sin(t * 1.4f + i);

        DrawLine(
            x, y, x + 3, y - 4,
            Fade(Color{190, 226, 155, 255},
                 0.17f + 0.19f * pulse)
        );
    }

    // Animated river reflections
    for (int i = 0; i < 24; ++i) {
        float x = 65.0f +
            std::fmod(i * 83.0f + t * 23.0f, 715.0f);

        float y = 360.0f + (i % 5) * 15.0f;

        DrawLineEx(
            Vector2{x, y},
            Vector2{x + 24.0f, y},
            1.6f,
            Fade(Color{177, 231, 255, 255}, 0.47f)
        );
    }

    // Riverbank highlights
    DrawLineEx(
        Vector2{55, 350},
        Vector2{815, 350},
        2.0f,
        Fade(SKYBLUE, 0.45f)
    );
    DrawLineEx(
        Vector2{55, 430},
        Vector2{815, 430},
        2.0f,
        Fade(SKYBLUE, 0.45f)
    );

    // Magical glow around the fire
    const float glow =
        0.7f + 0.3f * std::sin(t * 4.0f);

    DrawCircleGradient(
        Vector2{681.0f, 285.0f}, 55.0f * glow,
        Color{255, 166, 44, 75},
        Color{255, 140, 30, 0}
    );

    // Rising fire particles
    for (int i = 0; i < 11; ++i) {
        const float age =
            std::fmod(t * 26.0f + i * 23.0f, 63.0f);

        const float px =
            681.0f + std::sin(t * 2.0f + i * 2.1f) * 17.0f;

        const float py = 280.0f - age;

        DrawCircleV(
            Vector2{px, py},
            1.5f + (i % 3),
            Fade(ORANGE, 1.0f - age / 70.0f)
        );
    }

    // AI activation: magic shockwaves and particles
    const double elapsed = now - lastPowerTime;

    if (elapsed >= 0.0 && elapsed < 2.0) {
        const float progress =
            static_cast<float>(elapsed / 2.0);

        const float alpha = 1.0f - progress;
        const Vector2 center = world.PlayerPosition();

        for (int ring = 0; ring < 3; ++ring) {
            const float radius =
                20.0f + progress * 140.0f + ring * 17.0f;

            DrawCircleLines(
                static_cast<int>(center.x),
                static_cast<int>(center.y),
                radius,
                Fade(SKYBLUE, alpha * 0.85f)
            );
        }

        for (int i = 0; i < 28; ++i) {
            const float angle =
                i * (6.2831853f / 28.0f) + t * 0.6f;

            const float distance =
                18.0f + progress * (70.0f + i % 5 * 17.0f);

            Vector2 particle{
                center.x + std::cos(angle) * distance,
                center.y + std::sin(angle) * distance
            };

            DrawCircleV(
                particle,
                2.0f + i % 3,
                Fade(i % 2 == 0 ? SKYBLUE : YELLOW,
                     alpha)
            );
        }
    }
}
// EFFECT_HELP_V1
struct EffectHelp {
    const char* title;
    const char* line1;
    const char* line2;
    const char* example;
};

static void DrawEffectHelpOverlay() {
    const EffectHelp help[] = {
        {
            u8"浮遊 / FLOAT",
            u8"重力の影響を弱め、空中に浮かせる。",
            u8"単体では自由に移動できない。",
            u8"例：浮遊＋移動 → 空中を移動"
        },
        {
            u8"移動 / MOVE",
            u8"物体を別の場所へ動かす。",
            u8"方向や速度は組み合わせで変化。",
            u8"例：移動＋脈動 → 往復運動"
        },
        {
            u8"成長 / GROW",
            u8"大きさや形を変えて伸ばす。",
            u8"足場や壁などの用途を生み出す。",
            u8"例：成長＋浮遊 → 大きな空中足場"
        },
        {
            u8"発光 / GLOW",
            u8"物体から光を発生させる。",
            u8"暗所や光に反応する装置に使う。",
            u8"例：発光＋脈動 → 点滅する光"
        },
        {
            u8"凍結 / FREEZE",
            u8"熱を奪い、凍る物質を氷にする。",
            u8"水面を歩ける場所に変えられる。",
            u8"例：凍結＋成長 → 氷が広がる"
        },
        {
            u8"固体化 / SOLIDIFY",
            u8"温度を変えず、物体の形を固定。",
            u8"壁や足場になる硬い状態にする。",
            u8"例：固体化＋浮遊 → 空中の足場"
        },
        {
            u8"脈動 / PULSE",
            u8"光や大きさを周期的に変化させる。",
            u8"ほかの動作に繰り返しを加える。",
            u8"例：脈動＋発光 → 光が点滅する"
        }
    };

    const Color dark{40, 72, 51, 255};
    const Color green{57, 113, 78, 255};

    DrawRectangle(0, 0, 1200, 750,
                  Color{14, 32, 22, 210});

    DrawRectangleRounded(
        Rectangle{96, 63, 1007, 644},
        0.06f, 12,
        Color{250, 247, 232, 255}
    );

    DrawJapaneseText(
        u8"動作の説明",
        126, 87, 32, dark
    );

    DrawJapaneseText(
        u8"組み合わせで新しい能力を作ろう",
        126, 129, 19, green
    );

    for (int i = 0; i < 7; ++i) {
        const int column = i / 4;
        const int row = i % 4;

        const int x = 122 + column * 486;
        const int y = 163 + row * 127;

        DrawRectangleRounded(
            Rectangle{
                static_cast<float>(x),
                static_cast<float>(y),
                462.0f, 115.0f
            },
            0.12f, 8,
            Color{232, 242, 218, 255}
        );

        DrawJapaneseText(help[i].title,
                         x + 13, y + 7, 25, dark);

        DrawJapaneseText(help[i].line1,
                         x + 13, y + 39, 19, dark);

        DrawJapaneseText(help[i].line2,
                         x + 13, y + 63, 19, dark);

        DrawJapaneseText(help[i].example,
                         x + 13, y + 90, 17, green);
    }

    DrawJapaneseText(
        u8"※ 組み合わせ例には未実装の効果もあります。",
        619, 572, 18, dark
    );

    DrawJapaneseText(
        u8"Hキーで説明を閉じる",
        783, 110, 21, green
    );
}
int main() {
    InitWindow(kScreenWidth, kScreenHeight, "WORLD DEFINITION - AI Rule Fusion");
    wdjp::Init();
    SetTargetFPS(60);
    RuleEngine rules;
    bool showEffectHelp = false;
    double lastPowerTime = -100.0;
    GameWorld world;
    RuleTarget selectedTarget = RuleTarget::Water;
    std::vector<RuleEffect> selectedEffects;
    int highlightedEffect = 0;
    std::future<std::string> ollamaFuture;
    RuleTarget pendingTarget = RuleTarget::Water;
    std::vector<RuleEffect> pendingEffects;
    std::string ollamaStatus = "Ready - choose 1 to 3 effects";
    bool discardOllamaResult = false;
    bool aiPage = false; // AI_PAGE_FULLSCREEN_V1

    while (!WindowShouldClose()) {
        if (aiPage && IsKeyPressed(KEY_H)) {
            showEffectHelp = !showEffectHelp;
        }

        if (aiPage && IsMouseButtonPressed(MOUSE_BUTTON_LEFT)) {
            const Vector2 p = GetMousePosition();

            if (showEffectHelp &&
                CheckCollisionPointRec(
                    p, Rectangle{870, 90, 275, 43})) {
                showEffectHelp = false;
            } else if (!showEffectHelp &&
                CheckCollisionPointRec(
                    p, Rectangle{870, 90, 275, 43})) {
                showEffectHelp = true;
            }
        }

        if (!aiPage) showEffectHelp = false;
        const Vector2 mouse = GetMousePosition();
        const bool click = IsMouseButtonPressed(MOUSE_BUTTON_LEFT);
        const Rectangle navigation{962, 15, 215, 46};
        if (IsKeyPressed(KEY_TAB) ||
            (click && CheckCollisionPointRec(mouse, navigation))) {
            aiPage = !aiPage;
        }
        bool askAI = aiPage && (IsKeyPressed(KEY_TWO) || IsKeyPressed(KEY_ENTER));

        // Choose an object, using either the mouse or T.
        if (aiPage && IsKeyPressed(KEY_T)) {
            int next = 0;
            for (int i = 0; i < static_cast<int>(kTargets.size()); ++i)
                if (selectedTarget == kTargets[i]) next = (i + 1) % static_cast<int>(kTargets.size());
            selectedTarget = kTargets[next];
            selectedEffects.clear();
        }
        for (int i = 0; i < static_cast<int>(kTargets.size()); ++i) {
            const Rectangle button{65.0f + (i % 2) * 322.0f, 184.0f + (i / 2) * 72.0f,
                300.0f, 53.0f};
            if (aiPage && click && CheckCollisionPointRec(mouse, button)) {
                selectedTarget = kTargets[i];
                selectedEffects.clear();
            }
        }

        if (aiPage && IsKeyPressed(KEY_E)) highlightedEffect = (highlightedEffect + 1) % static_cast<int>(kEffects.size());
        if (aiPage && IsKeyPressed(KEY_Q)) highlightedEffect = (highlightedEffect + static_cast<int>(kEffects.size()) - 1) % static_cast<int>(kEffects.size());
        bool addHighlighted = aiPage && IsKeyPressed(KEY_SPACE);
        if (IsKeyPressed(KEY_BACKSPACE) && !selectedEffects.empty()) selectedEffects.pop_back();
        for (int i = 0; i < static_cast<int>(kEffects.size()); ++i) {
            const Rectangle button{65.0f + (i % 2) * 322.0f, 373.0f + (i / 2) * 63.0f,
                300.0f, 53.0f};
            if (aiPage && click && CheckCollisionPointRec(mouse, button)) {
                highlightedEffect = i;
                addHighlighted = true;
            }
        }
        if (addHighlighted) {
            const RuleEffect effect = kEffects[highlightedEffect];
            if (effect == RuleEffect::Heat && !world.HasCore()) {
                ollamaStatus = "GET POWER CORE TO UNLOCK";
                addHighlighted = false;
            }
            if (!Contains(selectedEffects, effect) && selectedEffects.size() < 3)
                // HEAT_SELECTION_LOCK_V2
                if ((effect) != RuleEffect::Heat || world.HasCore()) {
                    selectedEffects.push_back(effect);
                } else {
                    ollamaStatus = "GET POWER CORE TO UNLOCK";
                }
        }

        const Rectangle askButton{785.0f, 587.0f, 365.0f, 60.0f};
        if (aiPage && click && CheckCollisionPointRec(mouse, askButton)) askAI = true;
        // Debug water shortcut disabled for Stage 1.
        if (IsKeyPressed(KEY_R)) {
            rules.Reset();
            world.Reset();
            selectedEffects.clear();
            if (ollamaFuture.valid()) {
                discardOllamaResult = true;
                ollamaStatus = "Reset; old AI response ignored";
            } else {
                ollamaStatus = "Ready - choose effects";
            }
        }

        if (askAI) {
            if (selectedEffects.empty()) {
                ollamaStatus = "Select 1-3 effects first";
            } else if (ollamaFuture.valid()) {
                ollamaStatus = "AI is still generating...";
            } else {
                pendingTarget = selectedTarget;
                pendingEffects = selectedEffects;
                nlohmann::json prompt = {
                    {"target", TargetId(selectedTarget)},
                    {"effects", nlohmann::json::array()},
                    {"task", "Invent one creative combined ability for this video game. "
                             "Use exactly these effects, not others."}
                };
                for (RuleEffect effect : pendingEffects) prompt["effects"].push_back(EffectId(effect));
                const std::string instruction = prompt.dump();
                ollamaStatus = "Thinking with qwen3.5:4b...";
                discardOllamaResult = false;
                ollamaFuture = std::async(std::launch::async, [instruction]() {
                    OllamaClient client;
                    return client.GenerateRuleJson(instruction);
                });
            }
        }

        if (ollamaFuture.valid() &&
            ollamaFuture.wait_for(std::chrono::seconds(0)) == std::future_status::ready) {
            try {
                const std::string output = ollamaFuture.get();
                if (discardOllamaResult) {
                    ollamaStatus = "Old response ignored after reset";
                } else if (output.empty()) {
                    ollamaStatus = "AI request failed - check Ollama";
                } else if (rules.ApplyRuleJson(output, pendingTarget, pendingEffects)) {
                    ollamaStatus = "AI POWER APPLIED!";
                    lastPowerTime = GetTime();
                    aiPage = false;
                    TraceLog(LOG_INFO, "AI response: %s", output.c_str());
                } else {
                    ollamaStatus = "AI JSON rejected - retry";
                    TraceLog(LOG_WARNING, "Rejected AI JSON: %s", output.c_str());
                }
            } catch (...) {
                ollamaStatus = "AI request failed";
            }
            discardOllamaResult = false;
        }

        if (!aiPage) world.Update(GetFrameTime(), rules);

        BeginDrawing();
        ClearBackground(Color{247, 244, 231, 255});

        if (!aiPage) {
            Camera2D camera{};
            camera.offset = Vector2{600.0f, 386.0f};
            camera.target = Vector2{435.0f, 387.5f};
            camera.zoom = 1.16f;

            BeginMode2D(camera);
            world.Draw(rules);
            DrawStageVisuals(world, GetTime(), lastPowerTime);
            EndMode2D();
            if (lastPowerTime > 0.0 &&
                GetTime() - lastPowerTime < 2.5) {

                float alpha = 1.0f -
                    static_cast<float>(
                        (GetTime() - lastPowerTime) / 2.5
                    );

                DrawRectangle(
                    360, 651, 485, 48,
                    Fade(Color{201, 227, 174, 255},
                         alpha * 0.9f)
                );

                DrawJapaneseText(
                    "WORLD RULE UPDATED!",
                    385, 663, 25,
                    Fade(WHITE, alpha)
                );
            }

            DrawRectangle(0, 0, 1200, 70, Color{247, 244, 231, 255});
            DrawJapaneseText("WORLD DEFINITION", 27, 20, 30, Color{40, 69, 49, 255});
            DrawJapaneseText("STAGE 01 / SEALED GOAL", 373, 27, 18, SKYBLUE);

            DrawRectangleRounded(navigation, 0.28f, 8, Color{183, 218, 161, 255});
            DrawRectangleLinesEx(navigation, 2, LIME);
            DrawJapaneseText("OPEN AI LAB [TAB]", 975, 29, 20, Color{40, 69, 49, 255});

            DrawRectangle(0, 710, 1200, 40, Color{247, 244, 231, 255});
            DrawJapaneseText("WASD: MOVE   R: RESET   TAB: AI LAB",
                     26, 720, 18, Color{40, 69, 49, 255});

            if (rules.HasActiveRule()) {
                std::string label =
                    "AI POWER: " + Truncate(rules.RuleName(), 34);
                DrawJapaneseText(label.c_str(), 625, 720, 18, LIME);
            } else {
                DrawJapaneseText("AI POWER: NONE", 625, 720, 18, Color{100, 115, 99, 255});
            }
        } else {
            DrawJapaneseText("AI RULE LAB", 55, 39, 39, Color{40, 69, 49, 255});
            DrawJapaneseText("Combine up to 3 effects with Ollama / qwen3.5:4b",
                     58, 94, 19, SKYBLUE);

            DrawRectangleRounded(navigation, 0.28f, 8, Color{215, 231, 193, 255});
            DrawRectangleLinesEx(navigation, 2, SKYBLUE);
            DrawJapaneseText("BACK TO GAME", 976, 29, 21, Color{40, 69, 49, 255});

            DrawJapaneseText("01  SELECT TARGET", 66, 148, 24, Color{40, 69, 49, 255});

            for (int i = 0; i < static_cast<int>(kTargets.size()); ++i) {
                DrawChoice(
                    Rectangle{
                        65.0f + (i % 2) * 322.0f,
                        184.0f + (i / 2) * 72.0f,
                        300.0f, 53.0f
                    },
                    TargetLabel(kTargets[i]),
                    selectedTarget == kTargets[i]
                );
            }

            DrawJapaneseText("02  COMBINE EFFECTS / MAX 3",
                     66, 338, 24, Color{40, 69, 49, 255});

            for (int i = 0; i < static_cast<int>(kEffects.size()); ++i) {
                DrawChoice(
                    Rectangle{
                        65.0f + (i % 2) * 322.0f,
                        373.0f + (i / 2) * 63.0f,
                        300.0f, 53.0f
                    },
                    EffectLabel(kEffects[i]),
                    Contains(selectedEffects, kEffects[i]), kEffects[i] == RuleEffect::Heat && !world.HasCore()
                );
            }

            DrawJapaneseText("CLICK: SELECT   BACKSPACE: UNDO   TAB: GAME",
                     65, 678, 18, SKYBLUE);

            DrawRectangle(754, 148, 410, 543,
                          Color{255, 251, 238, 255});
            DrawRectangleLines(754, 148, 410, 543, SKYBLUE);

            DrawJapaneseText(
                world.HasCore()
                    ? "HEAT UNLOCKED!"
                    : "GET POWER CORE TO UNLOCK",
                65, 644, 18,
                Color{40, 85, 53, 255}
            );
            DrawJapaneseText("03  FUSION QUEUE", 781, 177, 24, Color{40, 69, 49, 255});
            DrawJapaneseText(TargetLabel(selectedTarget),
                     784, 220, 24, LIME);

            for (int i = 0; i < 3; ++i) {
                std::string slot = std::to_string(i + 1) + "  " +
                    (i < static_cast<int>(selectedEffects.size())
                    ? EffectLabel(selectedEffects[i]) : "---");

                DrawJapaneseText(slot.c_str(), 784, 260 + i * 34, 21,
                    i < static_cast<int>(selectedEffects.size())
                    ? WHITE : GRAY);
            }

            DrawLine(779, 380, 1139, 380, SKYBLUE);
            DrawJapaneseText("AI GENERATED POWER", 782, 398, 20, SKYBLUE);

            if (rules.HasActiveRule()) {
                DrawJapaneseText(Truncate(rules.RuleName(), 30).c_str(),
                         782, 431, 21, LIME);
                DrawJapaneseText(Truncate(rules.RuleDescription(), 46).c_str(),
                         782, 462, 14, Color{40, 69, 49, 255});
            } else {
                DrawJapaneseText("No power generated yet", 782, 434, 17, Color{100, 115, 99, 255});
            }

            DrawJapaneseText(Truncate(ollamaStatus, 43).c_str(),
                     783, 540, 16, Color{40, 69, 49, 255});

            DrawRectangleRounded(askButton, 0.20f, 8, Color{183, 218, 161, 255});
            DrawRectangleLinesEx(askButton, 2, LIME);
            DrawJapaneseText("GENERATE WITH AI", 800, 605, 23, Color{40, 69, 49, 255});

            DrawJapaneseText("2/ENTER: GENERATE   T: TARGET   Q/E: EFFECT",
                     772, 663, 15, SKYBLUE);
        }

        if (aiPage) {
            DrawRectangleRounded(
                Rectangle{870, 90, 275, 43},
                0.18f, 8,
                Color{187, 219, 163, 255}
            );

            DrawJapaneseText(
                u8"動作の説明 [H]",
                890, 99, 22,
                Color{40, 72, 51, 255}
            );
        }

        if (aiPage && showEffectHelp) {
            DrawEffectHelpOverlay();
        }

        EndDrawing();
    }
    wdjp::Shutdown();
    CloseWindow();
    return 0;
}
